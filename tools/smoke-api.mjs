// Coins and stats API test. First the rules alone (server/coins.js) in plain Node.js with an in-memory store — the part
// that has to move to another host as is; then the whole API (server/api.js) on `wrangler dev` with a throwaway local D1
// and a test bot token.
// Checks: the initData signature (missing, forged, stale, a changed field → 401), an empty profile, a win against the
// AI gives coins and moves the profile, the same match again → 409, the next one too soon → 429, implausible
// summaries → 422, 'left' gives no coins, the daily cap ends in verdict 'capped', CORS preflight. A real server-mode
// match (two WebSocket players, a 15-second match in the Durable Object): both reports with the room's score are paid
// from the duo cap, a report with another score → 422 'mismatch', a match the room does not know → paid as an AI match
// ('unverified'), a host claiming team 1 → 422. The game in Chromium (?api= points it at this Worker): a match left in
// the send queue goes out on start, the profile brings coins and stats, a match summary shows «+N coins» on the result
// screen.
// usage: node tools/smoke-api.mjs [--port 8799] [--verbose]
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { startWrangler } from './wrangler-dev.mjs';
import { startServer } from './serve.mjs';
import { openGame, fakeTelegram, isError } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const port = +opt('port', 8799), VERBOSE = args.includes('--verbose');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'TEST_BOT_TOKEN_smoke_api';
const fails = [], ok = (c, m) => { if (!c) fails.push(m); else if (VERBOSE) console.log('ok  ', m); };
const API = `http://127.0.0.1:${port}`;

// initData the way Telegram signs it
function initData(user, { authDate = Math.floor(Date.now() / 1000), token = TOKEN, tamper = null } = {}) {
  const f = { auth_date: String(authDate), query_id: 'AAH' + user.id, user: JSON.stringify(user) };
  const dcs = Object.keys(f).sort().map((k) => k + '=' + f[k]).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  if (tamper) Object.assign(f, tamper);
  return new URLSearchParams({ ...f, hash }).toString();
}
async function call(method, path, idata, body) {
  const h = {}; if (idata) h['X-Telegram-Init-Data'] = idata; if (body) h['Content-Type'] = 'application/json';
  const r = await fetch(API + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j, h: r.headers };
}
let n = 0;
function summary(o = {}) {
  const now = Date.now(), len = o.len || 180;
  const score = o.score || [3, 1];
  const team = (g, x) => ({ shots: g + 6 + x, sog: g + 3 + x, goals: g, passes: 30, passesDone: 22, saves: 4, hits: 3, penalties: 0, pokes: 2, takeaways: 1, posts: 0 });
  const s = { v: 1, id: (Date.now().toString(16) + (++n).toString(16).padStart(4, '0') + 'abcdef0123').slice(0, 24), client: 1,
    mode: 'ai', role: 'solo', net: null, team: 0, difficulty: 'normal', clubs: [0, 3], len, played: len + 4,
    startedAt: now - (len + 20) * 1000, endedAt: now, score, result: score[0] > score[1] ? 'win' : score[0] < score[1] ? 'loss' : 'draw',
    disconnect: null, teams: [team(score[0], 0), team(score[1], 1)],
    players: [{ t: 0, num: 9, g: score[0], a: 2, s: 5, h: 1 }, { t: 1, num: 17, g: score[1], a: 0, s: 2, h: 0 }],
    faceoffs: 6, events: 120, test: false };
  return Object.assign(s, o.patch || {});
}

// ---------- the rules without Cloudflare: server/coins.js in plain Node.js with an in-memory store (the STORE contract)
{
  const { handleCoins } = await import('../server/coins.js');
  const M = new Map(), U = new Map(), Lg = [], St = new Map();
  const store = {
    async matchSeen(uid, id) { return M.has(uid + ':' + id); },
    async lastMatch(uid) { const a = [...M.values()].filter((m) => m.uid === uid).sort((x, y) => y.now - x.now)[0]; return a ? { at: a.now, len: a.len } : null; },
    async matchesSince(uid, t) { return [...M.values()].filter((m) => m.uid === uid && m.now >= t).length; },
    async coinsSince(uid, reason, t) { return Lg.filter((l) => l.uid === uid && l.reason === reason && l.at >= t).reduce((a, l) => a + l.d, 0); },
    async recordMatch(m) {
      if (M.has(m.uid + ':' + m.id)) return 'duplicate';
      M.set(m.uid + ':' + m.id, m);
      const u = U.get(m.uid) || { coins: 0, stars: 0, matches: 0, wins: 0, draws: 0, losses: 0, goals: 0, goals_against: 0, streak: 0, best_streak: 0, online: 0, inventory: [] };
      u.coins += m.coins; u.matches++; u.wins += m.win; u.draws += m.draw; u.losses += 1 - m.win - m.draw; u.goals += m.my; u.goals_against += m.op;
      u.streak = m.win ? u.streak + 1 : 0; u.best_streak = Math.max(u.best_streak, u.streak); u.online += m.online; U.set(m.uid, u);
      if (m.coins > 0) Lg.push({ uid: m.uid, d: m.coins, reason: m.reason, at: m.now });
      return 'ok';
    },
    async balance(uid) { return (U.get(uid) || { coins: 0 }).coins; },
    async profile(uid) { return U.get(uid) || null; },
    // stakes: the same contract as server/coins-d1.js — all or nothing, never below zero, settle only from 'locked'
    async stakeLock(s) {
      if (St.has(s.id)) return 'duplicate';
      const us = s.uids.map((uid) => U.get(uid));
      if (us.some((u) => !u || u.coins < s.amount)) return 'funds';
      for (const [i, u] of us.entries()) { u.coins -= s.amount; Lg.push({ uid: s.uids[i], d: -s.amount, reason: 'stake', ref: s.id, at: s.now }); }
      St.set(s.id, { id: s.id, room: s.room, amount: s.amount, uids: s.uids.slice(), len: s.len, status: 'locked', outcome: null, created: s.now, deadline: s.deadline });
      return 'ok';
    },
    async stakeGet(id) { const s = St.get(id); return s ? { ...s, uids: s.uids.slice() } : null; },
    async stakeSettle(id, outcome, pays, now) {
      const s = St.get(id); if (!s || s.status !== 'locked') return 'done';
      for (const [uid, d, reason] of pays) { U.get(uid).coins += d; Lg.push({ uid, d, reason, ref: id, at: now }); }
      s.status = 'settled'; s.outcome = outcome; s.settled = now;
      return 'ok';
    },
    async stakesOverdue(uid, now) { return [...St.values()].filter((s) => s.status === 'locked' && s.deadline <= now && s.uids.includes(uid)); },
  };
  const P = { id: 777000111, first_name: 'Node' };
  const deps = { botToken: TOKEN, store, roomResult: async () => null };
  const req = (method, path, idata, body) => new Request('http://local' + path, { method,
    headers: { ...(idata ? { 'X-Telegram-Init-Data': idata } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const go = async (...a) => { const r = await handleCoins(req(...a), deps); return { status: r.status, j: await r.json() }; };
  ok((await handleCoins(req('GET', '/room/X'), deps)) === null, 'node core: a non-API path is not handled');
  ok((await go('GET', '/v1/profile', initData(P, { token: 'WRONG' }))).status === 401, 'node core: forged initData → 401');
  const s1 = summary();
  let r = await go('POST', '/v1/match', initData(P), s1);
  ok(r.status === 200 && r.j.coins === 15 && r.j.balance === 15 && r.j.verdict === 'ok', `node core: win → 15 coins ${JSON.stringify(r.j)}`);
  ok((await go('POST', '/v1/match', initData(P), s1)).status === 409, 'node core: the same match again → 409');
  ok((await go('POST', '/v1/match', initData(P), summary())).status === 429, 'node core: next match right away → 429');
  r = await go('GET', '/v1/profile', initData(P));
  ok(r.status === 200 && r.j.coins === 15 && r.j.totals.w === 1 && r.j.day.coins === 15, `node core: profile ${JSON.stringify(r.j)}`);

  // ---- stakes (coins.js StakeRoom / stakeFinish / stakeSweep) on the same in-memory store
  const { StakeRoom, stakeFinish, stakeSweep } = await import('../server/coins.js');
  const user = (id, coins) => { U.set(id, { coins, stars: 0, matches: 0, wins: 0, draws: 0, losses: 0, goals: 0, goals_against: 0, streak: 0, best_streak: 0, online: 0, inventory: [] }); return id; };
  const bal = (id) => U.get(id).coins;
  const H = user(9001, 100), G = user(9002, 30), Poor = user(9003, 5);
  const total0 = bal(H) + bal(G) + bal(Poor);
  let sid = 0; const mid = () => 'abcdef' + String(++sid).padStart(10, '0');
  const now = 1_800_000_000;
  // a room with both players signed in and a stake both agreed to → the started match id
  async function staked(n, uids = [H, G]) {
    const R = new StakeRoom(); R.auth(0, uids[0]); R.auth(1, uids[1]);
    const e1 = await R.offer(store, 0, n), e2 = e1 || await R.confirm(store, 1, n);
    if (e1 || e2) return { R, err: e1 || e2 };
    const id = mid(), err = await R.start(store, { id, room: 'NODE', len: 180, now, deadline: now + 1260 });
    return { R, id, err };
  }
  // win: the host takes both; the second settlement pays nothing
  let t = await staked(25);
  ok(!t.err && bal(H) === 75 && bal(G) === 5 && t.R.live && t.R.live.n === 25 && t.R.n === 0, `stake: locked from both ${JSON.stringify([t.err, bal(H), bal(G)])}`);
  await stakeFinish(store, t.id, { score: [3, 1], left: [false, false] }, now + 200);
  await stakeFinish(store, t.id, { score: [0, 9], left: [false, false] }, now + 300);
  ok(bal(H) === 125 && bal(G) === 5, `stake: win → the host takes both, settled once (${bal(H)}, ${bal(G)})`);
  // the report of that match: the stake as each sees it, outside the daily cap; the same report again → 409, no coins
  const duo = (team, id, sc) => summary({ score: sc, patch: { id, mode: 'online', role: team ? 'guest' : 'host', team, net: 'server', room: 'NODE', difficulty: null,
    result: sc[team] > sc[1 - team] ? 'win' : sc[team] < sc[1 - team] ? 'loss' : 'draw' } });
  const ide = (id) => initData({ id, first_name: 'S' + id });
  r = await go('POST', '/v1/match', ide(G), duo(1, t.id, [3, 1]));
  ok(r.status === 200 && r.j.stake && r.j.stake.out === 'loss' && r.j.stake.n === 25 && r.j.stake.delta === 0 && r.j.balance === 5 + r.j.coins,
    `stake: guest's report shows the lost stake ${JSON.stringify(r.j)}`);
  const gAfter = bal(G), rj = r.j;
  ok((await go('POST', '/v1/match', ide(G), duo(1, t.id, [3, 1]))).status === 409 && bal(G) === gAfter, 'stake: the same report again → 409, nothing paid');
  ok((await store.coinsSince(G, 'match_ai', 0)) === r.j.coins && Lg.some((l) => l.uid === G && l.reason === 'stake'), 'stake: not counted in the daily match caps');
  const gWas = bal(G); U.get(G).coins = 40;          // top up the guest for the next ones (bookkeeping below)
  let extra = 40 - gWas;
  // draw: each gets their own back
  t = await staked(10);
  await stakeFinish(store, t.id, { score: [2, 2], left: [false, false] }, now);
  ok(!t.err && bal(H) === 125 && bal(G) === 40, `stake: draw → each their own back (${bal(H)}, ${bal(G)})`);
  // a player who dropped and did not come back loses the stake, whatever the score
  t = await staked(10);
  await stakeFinish(store, t.id, { score: [0, 3], left: [false, true] }, now);
  ok(!t.err && bal(H) === 135 && bal(G) === 30, `stake: the guest left → the host takes both despite 0:3 (${bal(H)}, ${bal(G)})`);
  t = await staked(10);
  await stakeFinish(store, t.id, { score: [1, 0], left: [true, true] }, now);
  ok(!t.err && bal(H) === 135 && bal(G) === 30, `stake: both left → both back (${bal(H)}, ${bal(G)})`);
  // not enough coins: the offer, the confirmation, and a balance that dropped before the start
  t = await staked(10, [Poor, G]);
  ok(t.err === 'funds' && bal(Poor) === 5, `stake: the host without coins cannot offer (${t.err})`);
  t = await staked(10, [H, Poor]);
  ok(t.err === 'funds' && bal(Poor) === 5 && bal(H) === 135, `stake: the guest without coins cannot confirm (${t.err})`);
  {
    const R = new StakeRoom(); R.auth(0, H); R.auth(1, G);
    await R.offer(store, 0, 25); await R.confirm(store, 1, 25);
    U.get(G).coins = 20; extra -= 10;
    const e = await R.start(store, { id: mid(), room: 'NODE', len: 180, now, deadline: now + 1260 });
    ok(e === 'funds' && bal(H) === 135 && bal(G) === 20 && !R.ok[1], `stake: balance gone before the start → nothing locked (${e})`);
    // not confirmed: no start
    const e2 = await R.start(store, { id: mid(), room: 'NODE', len: 180, now, deadline: now + 1260 });
    ok(e2 === 'confirm' && bal(H) === 135, `stake: not confirmed by the guest → the match does not start (${e2})`);
    // a new amount drops the confirmation; another amount cannot be confirmed
    await R.offer(store, 0, 10); ok((await R.confirm(store, 1, 25)) === 'amount' && !R.ok[1], 'stake: confirming another amount is refused');
    // the same Telegram user on both sides
    const S2 = new StakeRoom(); S2.auth(0, H); S2.auth(1, H);
    ok((await S2.offer(store, 0, 10)) === 'same', 'stake: the same player in both slots is refused');
    // unsigned player
    const S3 = new StakeRoom(); S3.auth(1, G);
    ok((await S3.offer(store, 0, 10)) === 'auth', 'stake: an offer without a verified player is refused');
    ok((await S3.offer(store, 0, 7)) === 'amount', 'stake: only 0 / 10 / 25 / 50 / 100');
  }
  // one stake per match id
  t = await staked(10);
  ok((await store.stakeLock({ id: t.id, room: 'NODE', amount: 10, uids: [H, G], len: 180, now, deadline: now })) === 'duplicate' && bal(H) === 125 && bal(G) === 10,
    'stake: a second lock of the same match → duplicate, nothing taken twice');
  // no result from the room (the match never ended): refunded after the deadline by a sweep, once
  await stakeSweep(store, H, now + 1000, async () => null);
  ok(bal(H) === 125, 'stake: not refunded before the deadline');
  await stakeSweep(store, H, now + 1300, async () => null);
  await stakeSweep(store, G, now + 1300, async () => null);
  ok(bal(H) === 135 && bal(G) === 20, `stake: no room result → both refunded (${bal(H)}, ${bal(G)})`);
  // the books: stakes move coins between players, never make or lose any
  const matchPaid = Lg.filter((l) => l.reason === 'match_duo' || l.reason === 'match_ai').filter((l) => [H, G, Poor].includes(l.uid)).reduce((a, l) => a + l.d, 0);
  ok(bal(H) + bal(G) + bal(Poor) === total0 + extra + matchPaid, `stake: coins add up to the coin (${bal(H) + bal(G) + bal(Poor)} = ${total0} + ${extra} + ${matchPaid})`);
}

const persist = mkdtempSync(join(tmpdir(), 'bvr-api-'));
let w = null;
const t0 = Date.now();
try {
  execFileSync(join(ROOT, 'node_modules', '.bin', 'wrangler'), ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist],
    { cwd: join(ROOT, 'server'), stdio: VERBOSE ? 'inherit' : 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
  // MATCH_GAP stays on for the 429 check, a second user with a gap of 0 tests the daily cap
  w = await startWrangler(port, { args: ['--persist-to', persist, '--var', `BOT_TOKEN:${TOKEN}`] });

  const A = { id: 100000000 + Math.floor(Math.random() * 1e6), first_name: 'Test', last_name: 'A', language_code: 'ru' };
  const ia = initData(A);

  // signature
  ok((await call('GET', '/v1/profile')).status === 401, 'no initData → 401');
  ok((await call('GET', '/v1/profile', initData(A, { token: 'WRONG' }))).status === 401, 'other bot token → 401');
  ok((await call('GET', '/v1/profile', initData(A, { authDate: Math.floor(Date.now() / 1000) - 90000 }))).status === 401, 'initData older than a day → 401');
  ok((await call('GET', '/v1/profile', initData(A, { tamper: { user: JSON.stringify({ ...A, id: 1 }) } }))).status === 401, 'changed user id → 401');
  const pre = await fetch(API + '/v1/match', { method: 'OPTIONS', headers: { Origin: 'https://example.org', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-telegram-init-data' } });
  ok(pre.status === 204 && /x-telegram-init-data/i.test(pre.headers.get('access-control-allow-headers') || ''), `CORS preflight ${pre.status}`);

  // empty profile
  let p = await call('GET', '/v1/profile', ia);
  ok(p.status === 200 && p.j.user.id === A.id && p.j.user.name === 'Test A' && p.j.coins === 0 && p.j.totals.m === 0, `empty profile ${JSON.stringify(p.j)}`);

  // implausible summaries (nothing is stored, so they do not trip the rate limit)
  const bad = [
    ['score ≠ team goals', summary({ patch: { score: [5, 1] } })],
    ['result does not match the score', summary({ patch: { result: 'loss' } })],
    ['played much less than len', summary({ patch: { played: 60 } })],
    ['sent sooner than the match lasts', summary({ patch: { startedAt: Date.now() - 30000 } })],
    ['len under a minute', summary({ len: 30 })],
    ['sog > shots', summary({ patch: { teams: [{ ...summary().teams[0], sog: 99 }, summary().teams[1]] } })],
    ['test match', summary({ patch: { test: true } })],
    ['ai mode with role host', summary({ patch: { role: 'host' } })],
  ];
  for (const [what, s] of bad) { const r = await call('POST', '/v1/match', ia, s); ok(r.status === 422, `${what} → 422 (got ${r.status} ${JSON.stringify(r.j)})`); }

  // a win: 10 for the result + bonus (3 goals + 2 assists = 5) = 15
  const s1 = summary();
  let r = await call('POST', '/v1/match', ia, s1);
  ok(r.status === 200 && r.j.accepted && r.j.coins === 15 && r.j.balance === 15 && r.j.verdict === 'ok', `win → 15 coins ${r.status} ${JSON.stringify(r.j)}`);
  r = await call('POST', '/v1/match', ia, s1);
  ok(r.status === 409, `the same match again → 409 (got ${r.status})`);
  r = await call('POST', '/v1/match', ia, summary());
  ok(r.status === 429, `next match right away → 429 (got ${r.status} ${JSON.stringify(r.j)})`);
  p = await call('GET', '/v1/profile', ia);
  ok(p.j.coins === 15 && p.j.totals.m === 1 && p.j.totals.w === 1 && p.j.totals.g === 3 && p.j.totals.ga === 1 && p.j.totals.streak === 1 && p.j.day.coins === 15,
    `profile after a win ${JSON.stringify(p.j)}`);

  // daily cap and 'left': a second Worker with MATCH_GAP 0 on the same database
  w.close(); await new Promise((res) => setTimeout(res, 800));
  w = await startWrangler(port, { args: ['--persist-to', persist, '--var', `BOT_TOKEN:${TOKEN}`, '--var', 'MATCH_GAP:0', '--var', 'MIN_LEN:10'] });
  const B = { id: A.id + 1, first_name: 'Test', username: 'b' };
  const ib = initData(B);
  r = await call('POST', '/v1/match', ib, summary({ score: [0, 2], patch: { result: 'left', played: 50, disconnect: { self: 1, selfLeft: true, opp: false, oppLeft: false } } }));
  ok(r.status === 200 && r.j.coins === 0 && r.j.verdict === 'left', `'left' → 0 coins ${JSON.stringify(r.j)}`);
  r = await call('POST', '/v1/match', ib, summary({ len: 60, score: [1, 1] }));
  ok(r.status === 200 && r.j.coins === 5, `1-minute draw: 5 × 0.4 + bonus 1 goal + 2 assists = 5 (cap 15 × 0.4 = 6) → got ${JSON.stringify(r.j)}`);
  let total = r.j.coins + 0, last = null;
  for (let i = 0; i < 9; i++) { last = await call('POST', '/v1/match', ib, summary()); total += last.j.coins; }
  ok(last.j.verdict === 'capped' && total === 100 && last.j.balance === 100 && last.j.day.coins === 100, `daily cap 100: total ${total}, last ${JSON.stringify(last.j)}`);
  p = await call('GET', '/v1/profile', ib);
  ok(p.j.coins === 100 && p.j.totals.m === 11 && p.j.totals.l === 1 && p.j.totals.d === 1 && p.j.totals.w === 9 && p.j.totals.best === 9, `profile B ${JSON.stringify(p.j.totals)}`);

  // a socket to a room that keeps every message; next() waits for one that matches
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const roomSock = (code, q) => new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/room/${code}${q}`); const P = { ws, q: [], end: null, send: (o) => ws.send(JSON.stringify(o)) };
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.t === 's') { if (m.e) for (const [nm, e] of m.e) if (nm === 'match:end') P.end = e; return; } P.q.push(m); });
    ws.on('open', () => res(P)); ws.on('error', rej);
  });
  const next = async (P, f, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const i = P.q.findIndex(f); if (i >= 0) return P.q.splice(i, 1)[0]; await sleep(50); } return null; };
  const coinsOf = async (u) => (await call('GET', '/v1/profile', initData(u))).j.coins;
  // two signed-in players in a fresh server room with a stake of n both agreed to → { H, G }
  async function stakeRoom(code, hu, gu, n) {
    const H = await roomSock(code, '?mode=srv'); await sleep(200); const G = await roomSock(code, '');
    const hh = await next(H, (m) => m.t === 'hello'); await next(G, (m) => m.t === 'hello');
    H.stk = hh && hh.stk;
    H.send({ t: 'auth', d: initData(hu) }); G.send({ t: 'auth', d: initData(gu) });
    H.auth = await next(H, (m) => m.t === 'auth'); G.auth = await next(G, (m) => m.t === 'auth');
    if (n) { H.send({ t: 'stake', n }); await next(G, (m) => m.t === 'stake' && m.n === n); G.send({ t: 'stakeOk', n }); await next(H, (m) => m.t === 'stake' && m.ok && m.ok[1]); }
    return { H, G };
  }
  // a server-mode match in a real room
  const room = 'API' + Math.floor(Math.random() * 1e5), mid = 'fedcba9876543210' + Math.floor(Math.random() * 1e8).toString(16).padStart(8, '0');
  const sock = (q) => new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/room/${room}${q}`); const P = { ws, end: null };
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.t === 's' && m.e) for (const [nm, e] of m.e) if (nm === 'match:end') P.end = e; });
    ws.on('open', () => res(P)); ws.on('error', rej);
  });
  const H = await sock('?mode=srv'); await new Promise((r) => setTimeout(r, 300));
  const G = await sock('');
  await new Promise((r) => setTimeout(r, 300));
  H.ws.send(JSON.stringify({ t: 'cfg', a: 0, b: 3, min: 0.25, id: mid }));
  const tEnd = Date.now(); while (!(H.end && G.end) && Date.now() - tEnd < 40000) await new Promise((r) => setTimeout(r, 200));
  ok(H.end && G.end, 'the 15-second server match ended');
  if (H.end) {
    const sc = H.end.score, C = { id: A.id + 2, first_name: 'Host' }, D = { id: A.id + 3, first_name: 'Guest' };
    const online = (team, o = {}) => summary({ len: 15, score: o.score || sc, patch: { id: o.id || mid, mode: 'online', role: team ? 'guest' : 'host', team, net: 'server', room: o.room || room,
      difficulty: null, played: 15, result: (o.score || sc)[team] > (o.score || sc)[1 - team] ? 'win' : (o.score || sc)[team] < (o.score || sc)[1 - team] ? 'loss' : 'draw', ...(o.patch || {}) } });
    r = await call('POST', '/v1/match', initData(C), online(0, { score: [sc[0] + 1, sc[1]] }));
    ok(r.status === 422 && r.j.reason === 'mismatch', `server match with another score → 422 mismatch (got ${r.status} ${JSON.stringify(r.j)})`);
    r = await call('POST', '/v1/match', initData(C), online(0, { patch: { team: 1 } }));
    ok(r.status === 422 && r.j.reason === 'team', `host claiming team 1 → 422 team (got ${r.status} ${JSON.stringify(r.j)})`);
    r = await call('POST', '/v1/match', initData(C), online(0));
    ok(r.status === 200 && r.j.kind === 'match_duo' && r.j.verdict === 'ok' && r.j.coins > 0, `host report with the room's score → duo coins ${JSON.stringify(r.j)}`);
    r = await call('POST', '/v1/match', initData(D), online(1));
    ok(r.status === 200 && r.j.kind === 'match_duo' && r.j.verdict === 'ok', `guest report → duo ${JSON.stringify(r.j)}`);
    r = await call('POST', '/v1/match', initData(D), online(1, { id: '00112233445566778899aabb' }));
    ok(r.status === 200 && r.j.kind === 'match_ai' && r.j.verdict === 'unverified', `a match the room does not know → paid as AI, unverified ${JSON.stringify(r.j)}`);
    p = await call('GET', '/v1/profile', initData(C));
    ok(p.j.totals.online === 1 && p.j.day.duo > 0 && p.j.day.coins === 0, `host profile after the duo match ${JSON.stringify(p.j)}`);
    const ext = await fetch(`${API}/room/${room}/diag`, { headers: { 'X-Internal': 'result' } });
    ok(ext.ok && !('score' in (await ext.json())), 'X-Internal from outside does not reach the room results');
  }
  H.ws.close(); G.ws.close();

  // ---------- a stake on a real server match: the players sign in over the socket, the host offers, the guest
  // confirms, the room locks the stake in D1 at the start and settles it by its own result
  const SH = { id: A.id + 10, first_name: 'StakeHost' }, SG = { id: A.id + 11, first_name: 'StakeGuest' };
  for (const u of [SH, SG]) { const r1 = await call('POST', '/v1/match', initData(u), summary()); ok(r1.j && r1.j.balance === 15, `stake player earns 15 first ${JSON.stringify(r1.j)}`); }
  {
    const code = 'STK' + Math.floor(Math.random() * 1e5), sm = 'aa' + Math.floor(Math.random() * 1e12).toString(16).padStart(14, '0') + 'bb00cc11';
    const { H, G } = await stakeRoom(code, SH, SG, 0);
    ok(H.stk === 1 && H.auth && H.auth.ok === 1 && G.auth && G.auth.ok === 1, `stake: hello.stk and initData accepted over the socket ${JSON.stringify([H.stk, H.auth, G.auth])}`);
    H.send({ t: 'stake', n: 100 });
    let m = await next(H, (x) => x.t === 'stake' && x.err);
    ok(m && m.err === 'funds', `stake: 100 with 15 coins → funds ${JSON.stringify(m)}`);
    G.send({ t: 'stake', n: 10 });
    m = await next(G, (x) => x.t === 'stake' && x.err);
    ok(m && m.err === 'role', `stake: only the host offers ${JSON.stringify(m)}`);
    H.send({ t: 'stake', n: 10 });
    m = await next(G, (x) => x.t === 'stake' && x.n === 10);
    ok(m && m.ok[0] === 1 && m.ok[1] === 0, `stake: the guest sees the offer ${JSON.stringify(m)}`);
    H.send({ t: 'cfg', a: 0, b: 3, min: 0.25, id: sm });
    m = await next(H, (x) => x.t === 'stake' && x.err);
    ok(m && m.err === 'confirm' && !(await next(H, (x) => x.t === 'cfg', 800)), `stake: not confirmed → no match ${JSON.stringify(m)}`);
    G.send({ t: 'stakeOk', n: 10 });
    m = await next(H, (x) => x.t === 'stake' && x.ok && x.ok[1] === 1);
    ok(!!m, 'stake: the host sees the confirmation');
    H.send({ t: 'cfg', a: 0, b: 3, min: 0.25, id: sm });
    const cfgH = await next(H, (x) => x.t === 'cfg'), live = await next(G, (x) => x.t === 'stake' && x.live);
    ok(cfgH && cfgH.id === sm && live && live.live.id === sm && live.live.n === 10, `stake: locked, the match starts ${JSON.stringify([cfgH, live])}`);
    ok((await coinsOf(SH)) === 5 && (await coinsOf(SG)) === 5, 'stake: 10 locked from each (15 → 5)');
    H.send({ t: 'cfg', a: 0, b: 3, min: 0.25, id: 'ab' + sm.slice(2) });
    ok(!(await next(H, (x) => x.t === 'cfg', 800)), 'stake: a match with a stake is not restarted halfway');
    const t1 = Date.now(); while (!(H.end && G.end) && Date.now() - t1 < 40000) await sleep(200);
    ok(H.end && G.end, 'stake: the staked match ended');
    if (H.end) {
      const sc = H.end.score, win = sc[0] > sc[1] ? 0 : sc[0] < sc[1] ? 1 : -1;
      const want = win === 0 ? [25, 5] : win === 1 ? [5, 25] : [15, 15];
      let got = []; for (let i = 0; i < 30; i++) { got = [await coinsOf(SH), await coinsOf(SG)]; if (got[0] === want[0] && got[1] === want[1]) break; await sleep(200); }
      ok(got[0] === want[0] && got[1] === want[1], `stake: settled by the room's ${sc.join(':')} → ${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
      const rep = (team, u) => call('POST', '/v1/match', initData(u), summary({ len: 15, score: sc, patch: { id: sm, mode: 'online', role: team ? 'guest' : 'host', team, net: 'server', room: code,
        difficulty: null, played: 15, result: sc[team] > sc[1 - team] ? 'win' : sc[team] < sc[1 - team] ? 'loss' : 'draw' } }));
      const rh = await rep(0, SH), rg = await rep(1, SG);
      const outs = win === 0 ? ['win', 'loss'] : win === 1 ? ['loss', 'win'] : ['back', 'back'];
      ok(rh.status === 200 && rh.j.stake && rh.j.stake.out === outs[0] && rh.j.balance === want[0] + rh.j.coins, `stake: host's report ${JSON.stringify(rh.j)}`);
      ok(rg.status === 200 && rg.j.stake && rg.j.stake.out === outs[1] && rg.j.balance === want[1] + rg.j.coins, `stake: guest's report ${JSON.stringify(rg.j)}`);
      ok((await rep(0, SH)).status === 409 && (await coinsOf(SH)) === rh.j.balance && (await coinsOf(SG)) === rg.j.balance, 'stake: the same report again pays nothing');
      ok((await coinsOf(SH)) + (await coinsOf(SG)) === 30 + rh.j.coins + rg.j.coins, 'stake: both balances add up to the coin');
      const ph = await call('GET', '/v1/profile', initData(SH));
      ok(ph.j.day.duo === rh.j.coins, `stake: not in the daily duo cap ${JSON.stringify(ph.j.day)}`);
    }
    H.ws.close(); G.ws.close();
  }

  // the game itself: queue on start, profile, reward on the result screen
  {
    const E = { id: A.id + 4, first_name: 'Game' };
    const queued = summary();
    const tg = fakeTelegram().replace(/initData:'[^']*'/, 'initData:' + JSON.stringify(initData(E)));
    const srv = await startServer(port + 1);
    const g = await openGame('chromium', { tg });
    try {
      await g.page.addInitScript((q) => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('bvr_pending_matches', JSON.stringify([q])); sessionStorage.setItem('seeded', '1'); } } catch (e) {} }, queued);
      await g.page.goto(`http://127.0.0.1:${port + 1}/index.html?nomusic&api=${encodeURIComponent(API)}`, { waitUntil: 'load', timeout: 120000 });
      await g.page.waitForFunction(() => { const c = window.__hk && __hk.coins(); return c && c.coins === 15 && c.prof.m >= 1 && c.q === 0; }, null, { timeout: 20000 }).catch(() => {});
      const st = await g.page.evaluate(() => { const c = __hk.coins(); return { coins: c.coins, m: c.prof.m, w: c.prof.w, q: c.q, pill: (document.querySelector('[data-coins]') || {}).textContent || '' }; });
      ok(st.coins === 15 && st.m === 1 && st.w === 1 && st.q === 0 && /15/.test(st.pill), `game: queued match sent on start, profile from the server ${JSON.stringify(st)}`);
      // a finished match: the result screen waits («начисляем…»), the server's answer plays the reward: rows «за что»,
      // the total counts up, coins fly to the balance (30) and are gone after it
      const s2 = summary();
      await g.page.evaluate((id) => __hk.result(id), s2.id);
      let rw = await g.page.evaluate(() => __hk.rw());
      ok(rw.st === 'wait' && /…|\.\.\./.test(rw.text), `game: result screen waits for the server ${JSON.stringify(rw)}`);
      await g.page.evaluate((x) => __hk.ev.emit('match:summary', x), s2);
      let flew = 0;
      for (let t = 0; t < 60; t++) { await new Promise((r) => setTimeout(r, 100)); rw = await g.page.evaluate(() => __hk.rw()); flew = Math.max(flew, rw.fly); if (rw.played && rw.wal === '30' && !rw.fly) break; }
      ok(rw.st === 'done' && /\+10/.test(rw.text) && /\+5/.test(rw.text) && /\+15$/.test(rw.text) && rw.wal === '30' && flew >= 3 && rw.fly === 0,
        `game: the reward played — rows, total +15, ${flew} coins flew, balance 30 ${JSON.stringify(rw)}`);
      ok((await g.page.evaluate(() => __hk.coins().coins)) === 30, 'game: balance 30 after the reward');
      // no connection: «начислится позже», nothing flies; the match stays in the queue
      await g.page.route(/\/v1\/match/, (r) => r.abort());
      const s3 = summary();
      await g.page.evaluate((id) => __hk.result(id), s3.id);
      await g.page.evaluate((x) => __hk.ev.emit('match:summary', x), s3);
      await g.page.waitForFunction(() => __hk.rw().st === 'later', null, { timeout: 10000 }).catch(() => {});
      rw = await g.page.evaluate(() => __hk.rw());
      ok(rw.st === 'later' && rw.fly === 0 && (await g.page.evaluate(() => __hk.coins().q)) === 1, `game: no connection → «later», queued ${JSON.stringify(rw)}`);
      await g.page.unroute(/\/v1\/match/);
      // it goes out with the next one; a match that left early pays 0 — the rows, no flying coins
      const s4 = summary({ score: [0, 2], patch: { result: 'left', played: 50, disconnect: { self: 1, selfLeft: true, opp: false, oppLeft: false } } });
      await g.page.evaluate((id) => __hk.result(id), s4.id);
      await g.page.evaluate((x) => __hk.ev.emit('match:summary', x), s4);
      flew = 0;
      for (let t = 0; t < 40; t++) { await new Promise((r) => setTimeout(r, 100)); rw = await g.page.evaluate(() => __hk.rw()); flew = Math.max(flew, rw.fly); if (rw.st === 'done' && t > 20) break; }
      ok(rw.st === 'done' && flew === 0 && /0$/.test(rw.text), `game: 0 coins → no flying coins ${JSON.stringify(rw)} flew ${flew}`);
      await g.page.waitForFunction(() => __hk.coins().q === 0, null, { timeout: 10000 }).catch(() => {});
      ok((await g.page.evaluate(() => __hk.coins())).coins === 45, `game: the queued match went out with the next one ${JSON.stringify(await g.page.evaluate(() => __hk.coins().coins))}`);
      const errs = g.logs.filter(isError).filter((e) => !/ERR_FAILED/.test(e.text));   // the request aborted on purpose above
      ok(!errs.length, `game: page errors ${JSON.stringify(errs).slice(0, 400)}`);
    } finally { await g.browser.close(); srv.close(); }
  }


  // ---------- no result from the room → refund: a Worker whose stakes are already past their deadline when locked
  // (STAKE_GRACE far below zero) — the room's alarm and the profile's sweep refund it; the match's own end later pays nothing
  w.close(); await sleep(800);
  w = await startWrangler(port, { args: ['--persist-to', persist, '--var', `BOT_TOKEN:${TOKEN}`, '--var', 'MATCH_GAP:0', '--var', 'MIN_LEN:10', '--var', 'STAKE_GRACE:-100000'] });
  {
    const before = [await coinsOf(SH), await coinsOf(SG)];
    const code = 'STR' + Math.floor(Math.random() * 1e5), sm = 'cc' + Math.floor(Math.random() * 1e12).toString(16).padStart(14, '0') + 'dd00ee11';
    const { H, G } = await stakeRoom(code, SH, SG, 10);
    H.send({ t: 'cfg', a: 0, b: 3, min: 0.25, id: sm });
    const live = await next(G, (x) => x.t === 'stake' && x.live);
    ok(live && live.live.id === sm, `refund: stake locked ${JSON.stringify(live)}`);
    let got = []; for (let i = 0; i < 40; i++) { got = [await coinsOf(SH), await coinsOf(SG)]; if (got[0] === before[0] && got[1] === before[1]) break; await sleep(250); }
    ok(got[0] === before[0] && got[1] === before[1], `refund: no room result → both back ${JSON.stringify(got)} (was ${JSON.stringify(before)})`);
    const t1 = Date.now(); while (!(H.end && G.end) && Date.now() - t1 < 40000) await sleep(200);
    await sleep(1500);
    ok((await coinsOf(SH)) === before[0] && (await coinsOf(SG)) === before[1], 'refund: the match ending afterwards pays nothing more');
    // not enough coins: a player with none cannot confirm
    const Z = { id: A.id + 12, first_name: 'Zero' };
    await call('GET', '/v1/profile', initData(Z));
    const z = await stakeRoom('STZ' + Math.floor(Math.random() * 1e5), SH, Z, 0);
    z.H.send({ t: 'stake', n: 10 }); await next(z.G, (x) => x.t === 'stake' && x.n === 10);
    z.G.send({ t: 'stakeOk', n: 10 });
    const e = await next(z.G, (x) => x.t === 'stake' && x.err);
    ok(e && e.err === 'funds', `funds: a guest without coins cannot confirm ${JSON.stringify(e)}`);
    for (const P of [H, G, z.H, z.G]) P.ws.close();
  }

  // A is untouched by B
  p = await call('GET', '/v1/profile', ia);
  ok(p.j.coins === 15, `A's coins unchanged ${p.j.coins}`);
} catch (e) {
  fails.push('exception: ' + (e && e.stack || e));
  if (w) console.log(w.log().slice(-3000));
} finally {
  if (w) w.close();
  try { rmSync(persist, { recursive: true, force: true }); } catch (e) {}
}
console.log(`smoke-api: ${fails.length ? 'FAIL' : 'OK'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
for (const f of fails) console.log('  ✗ ' + f);
process.exit(fails.length ? 1 : 0);
