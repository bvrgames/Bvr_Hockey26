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
  const M = new Map(), U = new Map(), Lg = [];
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
      // a finished match: the summary goes out, the reward shows up on the result screen
      const s2 = summary();
      await g.page.evaluate((x) => { __hk.match().id = x.id; __hk.ev.emit('match:summary', x); }, s2);
      await g.page.waitForFunction(() => /\+15/.test(document.getElementById('oReward').textContent), null, { timeout: 15000 }).catch(() => {});
      const rw = await g.page.evaluate(() => ({ t: document.getElementById('oReward').textContent, coins: __hk.coins().coins }));
      ok(/\+15/.test(rw.t) && /30/.test(rw.t) && rw.coins === 30, `game: result screen shows the reward ${JSON.stringify(rw)}`);
      const errs = g.logs.filter(isError);
      ok(!errs.length, `game: page errors ${JSON.stringify(errs).slice(0, 400)}`);
    } finally { await g.browser.close(); srv.close(); }
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
