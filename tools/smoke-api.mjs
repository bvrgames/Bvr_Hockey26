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
// usage: node tools/smoke-api.mjs [--port 8799] [--verbose] [--core — only the Node.js part]
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
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

  // ---- stars for Telegram Stars (coins.js «stars»): a fake Bot API, the same STORE contract as coins-d1.js
  const { handleBot, STAR_PACKS } = await import('../server/coins.js');
  const Or = new Map();
  Object.assign(store, {
    async starOrderNew(o) { if (!U.has(o.uid)) user(o.uid, 0); Or.set(o.id, { id: o.id, uid: o.uid, pack: o.pack, stars: o.stars, price: o.price, status: 'pending', charge: null, created: o.now, short: 0 }); },
    async starOrderGet(id) { const o = Or.get(id); return o ? { ...o } : null; },
    async starOrderFail(id) { const o = Or.get(id); if (o && o.status === 'pending') o.status = 'failed'; },
    async starOrdersSince(uid, t) { return [...Or.values()].filter((o) => o.uid === uid && o.created >= t).length; },
    async starPaid(p) {
      const o = Or.get(p.id); if (!o || o.status !== 'pending' || o.uid !== p.uid) return 'repeat';
      U.get(p.uid).stars += p.stars; o.status = 'paid'; o.charge = p.charge; Lg.push({ uid: p.uid, d: p.stars, reason: 'stars_buy', ref: p.id, at: p.now });
      return 'ok';
    },
    async starRefund(p) {
      const o = [...Or.values()].find((x) => x.charge === p.charge); if (!o) return { r: 'unknown' };
      if (o.status !== 'paid') return { r: 'repeat', id: o.id };
      const u = U.get(o.uid), taken = Math.min(u.stars, o.stars);
      u.stars -= taken; o.status = 'refunded'; o.short = o.stars - taken; Lg.push({ uid: o.uid, d: -taken, reason: 'stars_refund', ref: o.id, at: p.now });
      return { r: 'ok', id: o.id, uid: o.uid, taken, short: o.short };
    },
    async starUnmatched(p) { Or.set('u_' + p.charge, { id: 'u_' + p.charge, uid: p.uid, status: 'unmatched', charge: p.charge, price: p.amount, stars: 0 }); },
    async starsBalance(uid) { return (U.get(uid) || { stars: 0 }).stars; },
  });
  const calls = [];
  const fakeBot = async (method, params) => { calls.push({ method, params }); return method === 'createInvoiceLink' ? 'https://t.me/$fake_' + params.payload : true; };
  const sdeps = { ...deps, bot: fakeBot };
  const sgo = async (method, path, idata, body) => { const r = await handleCoins(req(method, path, idata, body), sdeps); return { status: r.status, j: await r.json() }; };
  const SECRET = 'webhook-secret-node';
  const hook = async (upd, secret = SECRET) => (await handleBot(new Request('http://local/tg/webhook', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(upd) }), { secret: SECRET, store, bot: fakeBot })).status;
  const B1 = { id: 9101, first_name: 'Buyer', language_code: 'ru' }, B2 = { id: 9102, first_name: 'Other' };
  r = await sgo('GET', '/v1/profile', initData(B1));
  ok(r.status === 200 && JSON.stringify(r.j.packs) === JSON.stringify(STAR_PACKS), `stars: the profile brings the packs ${JSON.stringify(r.j.packs)}`);
  ok((await sgo('POST', '/v1/stars/invoice', initData(B1), { pack: 'free' })).status === 422, 'stars: an unknown pack → 422');
  ok((await sgo('POST', '/v1/stars/invoice', null, { pack: 's50' })).status === 401, 'stars: an invoice without initData → 401');
  r = await sgo('POST', '/v1/stars/invoice', initData(B1), { pack: 's120' });
  const inv = calls.find((c) => c.method === 'createInvoiceLink');
  ok(r.status === 200 && r.j.link === 'https://t.me/$fake_' + r.j.order && inv && inv.params.currency === 'XTR' && inv.params.provider_token === '' &&
     inv.params.payload === r.j.order && inv.params.prices[0].amount === 100 && /120 звёзд/.test(inv.params.title), `stars: invoice s120 → XTR 100, payload = order ${JSON.stringify([r.j, inv && inv.params])}`);
  const ord = r.j.order;
  ok((await sgo('GET', '/v1/stars/order?id=' + ord, initData(B2))).status === 404, "stars: someone else's order → 404");
  const checkout = async (from, payload, amount = 100) => { calls.length = 0;
    await hook({ update_id: 1, pre_checkout_query: { id: 'q' + Math.random(), from, currency: 'XTR', total_amount: amount, invoice_payload: payload } });
    const a = calls.find((c) => c.method === 'answerPreCheckoutQuery'); return a ? a.params.ok : null; };
  ok((await checkout(B2, ord)) === false, "stars: pre_checkout from another player → ok:false");
  ok((await checkout(B1, 'ffffffffffffffffffffffff')) === false, 'stars: pre_checkout for no such order → ok:false');
  ok((await checkout(B1, ord, 50)) === false, 'stars: pre_checkout with another sum → ok:false');
  ok((await checkout(B1, ord)) === true, 'stars: pre_checkout for the right order → ok:true');
  ok((await hook({ update_id: 2 }, 'wrong')) === 403, 'stars: webhook with a wrong secret → 403');
  const pay = (from, payload, charge, amount = 100) => hook({ update_id: 3, message: { message_id: 1, from, chat: { id: from.id }, date: now,
    successful_payment: { currency: 'XTR', total_amount: amount, invoice_payload: payload, telegram_payment_charge_id: charge, provider_payment_charge_id: '' } } });
  ok((await pay(B1, ord, 'ch_node_1')) === 200 && U.get(B1.id).stars === 120, `stars: successful_payment → +120 (${U.get(B1.id).stars})`);
  await pay(B1, ord, 'ch_node_1');
  ok(U.get(B1.id).stars === 120, 'stars: the same payment again adds nothing');
  ok((await checkout(B1, ord)) === false, 'stars: pre_checkout for a paid order → ok:false');
  r = await sgo('GET', '/v1/stars/order?id=' + ord, initData(B1));
  ok(r.j.status === 'paid' && r.j.balance === 120, `stars: the order is paid ${JSON.stringify(r.j)}`);
  // a refund after some stars are gone: only what is left goes, the rest is marked on the order
  U.get(B1.id).stars = 30;
  await hook({ update_id: 4, message: { message_id: 2, from: B1, chat: { id: B1.id }, date: now, refunded_payment: { currency: 'XTR', total_amount: 100, invoice_payload: ord, telegram_payment_charge_id: 'ch_node_1' } } });
  ok(U.get(B1.id).stars === 0 && Or.get(ord).status === 'refunded' && Or.get(ord).short === 90, `stars: refund with 30 left → 0, short 90 (${U.get(B1.id).stars}, ${JSON.stringify(Or.get(ord))})`);
  calls.length = 0;
  await hook({ update_id: 5, message: { message_id: 3, from: B1, chat: { id: B1.id, type: 'private' }, date: now, text: '/terms' } });
  ok(calls.some((c) => c.method === 'sendMessage' && /Telegram id/.test(c.params.text)), '/terms answers with the terms (Telegram id, name, stats)');
  // the bot's menu button is the owner's: /tg/setup?do=install never changes it — whatever it is now (the hub, another
  // game, the default «commands», none), and the Bot API wrapper itself refuses setChatMenuButton; no server file calls it
  {
    const { handleBotSetup, botApiFrom } = await import('../server/coins.js');
    for (const mb of [{ type: 'web_app', text: 'ИГРАТЬ', web_app: { url: 'https://bvr-games-hub.vercel.app/' } }, { type: 'web_app', text: 'X', web_app: { url: 'https://other.example/' } }, { type: 'commands' }, { type: 'default' }, null]) {
      const mc = [];
      const bot = async (method, params) => { mc.push(method); return method === 'getChatMenuButton' ? mb : method === 'getMyCommands' ? [] : method === 'getWebhookInfo' ? { url: '' } : true; };
      const r = await handleBotSetup(new Request('https://w.example/tg/setup?do=install', { method: 'POST', headers: { 'X-Setup-Secret': SECRET } }), { secret: SECRET, bot });
      const j = await r.json();
      ok(r.status === 200 && !mc.includes('setChatMenuButton') && j.rev >= 3 && JSON.stringify(j.menuButton) === JSON.stringify(mb),
        `setup: the menu button ${JSON.stringify(mb)} is not changed by install (${mc.join(',')})`);
    }
    let refused = null;
    try { await botApiFrom('T', 'http://127.0.0.1:9')('setChatMenuButton', {}); } catch (e) { refused = e.message; }
    ok(/refused/.test(refused || ''), `setup: the Bot API wrapper refuses setChatMenuButton (${refused})`);
    const { readdirSync, readFileSync } = await import('node:fs');
    const calls = readdirSync(join(ROOT, 'server')).filter((f) => f.endsWith('.js')).filter((f) => /bot\(\s*['"]setChatMenuButton/.test(readFileSync(join(ROOT, 'server', f), 'utf8')));
    ok(!calls.length, `setup: no server file calls setChatMenuButton (${calls})`);
  }
  // the menu button: one that already opens the game is kept; the commands keep the bot's own ones
  {
    const { handleBotSetup } = await import('../server/coins.js');
    const mc = [];
    const mbBot = async (method, params) => { mc.push({ method, params });
      return method === 'getChatMenuButton' ? { type: 'web_app', text: 'Hockey', web_app: { url: 'https://bvr-hockey26.vercel.app/?x=1' } }
        : method === 'getMyCommands' ? (params.language_code ? [] : [{ command: 'help', description: 'Help' }]) : method === 'getWebhookInfo' ? { url: '' } : true; };
    const r = await handleBotSetup(new Request('https://w.example/tg/setup?do=install', { method: 'POST', headers: { 'X-Setup-Secret': SECRET } }), { secret: SECRET, bot: mbBot });
    const smc = mc.find((c) => c.method === 'setMyCommands');
    ok(r.status === 200 && !mc.some((c) => c.method === 'setChatMenuButton') && smc && smc.params.commands.map((c) => c.command).join() === 'start,help,paysupport,terms',
      `setup: the menu button is not touched, own commands kept ${JSON.stringify([r.status, smc && smc.params])}`);
  }

  // ---- the developer's page: only ADMIN_IDS by the verified Telegram id
  const adeps = { ...sdeps, adminIds: '42, 9101', adminUi: 'function BVRDev(K){ return {}; }' };
  const ago = async (path, idata) => (await handleCoins(req('GET', path, idata), adeps)).status;
  ok((await ago('/v1/admin/me', null)) === 403, 'admin core: unsigned → 403');
  ok((await ago('/v1/admin/me', initData(B2))) === 403, 'admin core: another player → 403');
  ok((await ago('/v1/admin/me', initData(B1, { token: 'WRONG' }))) === 403, 'admin core: the admin id signed by another bot → 403');
  ok((await ago('/v1/admin/me', initData(B2, { tamper: { user: JSON.stringify(B1) } }))) === 403, 'admin core: a player who put the admin id into initData → 403');
  ok((await ago('/v1/admin/me', initData({ id: 9101, first_name: 'X', username: 'B1' }))) === 200, 'admin core: the admin id → 200');
  ok((await handleCoins(req('GET', '/v1/admin/me', initData(B1)), { ...adeps, adminIds: '' })).status === 403, 'admin core: no ADMIN_IDS → 403 to all');
  ok((await ago('/v1/admin/ui.js', initData(B1))) === 200 && (await ago('/v1/admin/ui.js', initData(B2))) === 403, 'admin core: the page text only to the admin');
  // why a signature is refused (the owner's log line «auth refused»): another bot token (e.g. revoked in @BotFather), stale
  const { checkInitData } = await import('../server/coins.js');
  const nowS = Math.floor(Date.now() / 1000);
  ok((await checkInitData(initData(B1, { token: 'REVOKED' }), TOKEN, nowS)).why === 'hash', 'auth: initData signed by another token → why hash');
  ok((await checkInitData(initData(B1, { authDate: nowS - 90000 }), TOKEN, nowS)).why === 'expired', 'auth: a day-old initData → why expired');
  ok((await checkInitData('', TOKEN, nowS)).why === 'none' && (await checkInitData(initData(B1), TOKEN, nowS)).user.id === B1.id, 'auth: none / ok');
}

const t0 = Date.now();
if (args.includes('--core')) {          // only the rules in plain Node.js (seconds, no wrangler)
  console.log(`smoke-api --core: ${fails.length ? 'FAIL' : 'OK'}`); for (const f of fails) console.log('  ✗ ' + f); process.exit(fails.length ? 1 : 0);
}
const persist = mkdtempSync(join(tmpdir(), 'bvr-api-'));
let w = null;
// a fake Bot API (TG_API points the Worker here): records every call, invoices get a link with the order id in it
const BOT_PORT = port + 3, HOOK_SECRET = 'smoke-webhook-secret', botCalls = [];
const botSrv = createServer((rq, rs) => { let b = ''; rq.on('data', (c) => { b += c; }); rq.on('end', () => {
  const method = rq.url.split('/').pop(); let params = {}; try { params = JSON.parse(b || '{}'); } catch (e) {}
  botCalls.push({ method, params, token: rq.url.split('/')[1] });
  const result = method === 'createInvoiceLink' ? 'https://t.me/$smoke_' + params.payload : method === 'getMyCommands' ? [] : method === 'getUpdates' ? [] :
    method === 'getWebhookInfo' ? { url: '', pending_update_count: 0 } : method === 'getChatMenuButton' ? { type: 'commands' } : true;
  rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ ok: true, result }));
}); });
await new Promise((res) => botSrv.listen(BOT_PORT, '127.0.0.1', res));
const ADMIN = { id: 777000999, first_name: 'Dev', username: 'dev_admin', language_code: 'ru' };
const VARS = ['--var', `BOT_TOKEN:${TOKEN}`, '--var', `TG_API:http://127.0.0.1:${BOT_PORT}`, '--var', `TG_WEBHOOK_SECRET:${HOOK_SECRET}`,
  '--var', `ADMIN_IDS:123, ${ADMIN.id}`, '--var', 'ADMIN_CACHE:0'];
try {
  execFileSync(join(ROOT, 'node_modules', '.bin', 'wrangler'), ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist],
    { cwd: join(ROOT, 'server'), stdio: VERBOSE ? 'inherit' : 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
  // MATCH_GAP stays on for the 429 check, a second user with a gap of 0 tests the daily cap
  w = await startWrangler(port, { args: ['--persist-to', persist, ...VARS] });

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
  w = await startWrangler(port, { args: ['--persist-to', persist, ...VARS, '--var', 'MATCH_GAP:0', '--var', 'MIN_LEN:10'] });
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

  // ---------- stars for Telegram Stars on the real Worker + D1, the Bot API faked (no real payments)
  {
    const hookRaw = (upd, secret = HOOK_SECRET) => fetch(API + '/tg/webhook', { method: 'POST', body: JSON.stringify(upd),
      headers: { 'Content-Type': 'application/json', ...(secret !== null ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {}) } });
    const S1 = { id: A.id + 20, first_name: 'Star', last_name: 'Buyer', language_code: 'en' }, S2 = { id: A.id + 21, first_name: 'Stranger' };
    const starsOf = async (u) => (await call('GET', '/v1/profile', initData(u))).j.stars;
    p = await call('GET', '/v1/profile', initData(S1));
    ok(p.j.stars === 0 && Array.isArray(p.j.packs) && p.j.packs.map((x) => `${x.stars}/${x.price}`).join(' ') === '50/50 120/100 300/250', `stars: packs from the server ${JSON.stringify(p.j.packs)}`);
    botCalls.length = 0;
    r = await call('POST', '/v1/stars/invoice', initData(S1), { pack: 's50' });
    const ci = botCalls.find((c) => c.method === 'createInvoiceLink');
    ok(r.status === 200 && /^[0-9a-f]{24}$/.test(r.j.order) && r.j.link === 'https://t.me/$smoke_' + r.j.order && ci && ci.token === 'bot' + TOKEN &&
       ci.params.currency === 'XTR' && ci.params.provider_token === '' && ci.params.payload === r.j.order && ci.params.prices[0].amount === 50,
       `stars: invoice created through createInvoiceLink ${JSON.stringify([r.status, r.j, ci && ci.params])}`);
    const o1 = r.j.order;
    r = await call('GET', '/v1/stars/order?id=' + o1, initData(S1));
    ok(r.status === 200 && r.j.status === 'pending' && r.j.stars === 50 && r.j.price === 50, `stars: the order is pending in D1 ${JSON.stringify(r.j)}`);
    ok((await call('GET', '/v1/stars/order?id=' + o1, initData(S2))).status === 404, "stars: someone else's order → 404");
    ok((await call('POST', '/v1/stars/invoice', initData(S1), { pack: 'x1' })).status === 422, 'stars: unknown pack → 422');
    // the webhook: secret
    ok((await hookRaw({ update_id: 1 }, 'wrong')).status === 403, 'webhook: wrong secret → 403');
    ok((await hookRaw({ update_id: 1 }, null)).status === 403, 'webhook: no secret → 403');
    // pre_checkout_query
    const checkout = async (from, payload, amount = 50) => {
      botCalls.length = 0; const id = 'pcq' + Math.floor(Math.random() * 1e9);
      const st = (await hookRaw({ update_id: 2, pre_checkout_query: { id, from, currency: 'XTR', total_amount: amount, invoice_payload: payload } })).status;
      const a = botCalls.find((c) => c.method === 'answerPreCheckoutQuery' && c.params.pre_checkout_query_id === id);
      return st === 200 && a ? a.params : null;
    };
    let a = await checkout(S2, o1);
    ok(a && a.ok === false && a.error_message, `pre_checkout: someone else's order → ok:false ${JSON.stringify(a)}`);
    a = await checkout(S1, 'abababababababababababab');
    ok(a && a.ok === false, `pre_checkout: no such order → ok:false ${JSON.stringify(a)}`);
    a = await checkout(S1, o1, 1);
    ok(a && a.ok === false, `pre_checkout: another sum → ok:false ${JSON.stringify(a)}`);
    a = await checkout(S1, o1);
    ok(a && a.ok === true, `pre_checkout: the right order → ok:true ${JSON.stringify(a)}`);
    // successful_payment: once
    const pay = (from, payload, charge, amount = 50) => hookRaw({ update_id: 3, message: { message_id: 7, from, chat: { id: from.id, type: 'private' }, date: Math.floor(Date.now() / 1000),
      successful_payment: { currency: 'XTR', total_amount: amount, invoice_payload: payload, telegram_payment_charge_id: charge, provider_payment_charge_id: '' } } });
    const ch1 = 'stxSMOKE' + Math.floor(Math.random() * 1e9);
    ok((await pay(S1, o1, ch1)).status === 200 && (await starsOf(S1)) === 50, 'successful_payment: +50 stars');
    ok((await pay(S1, o1, ch1)).status === 200 && (await starsOf(S1)) === 50, 'successful_payment: the same payment again adds nothing');
    r = await call('GET', '/v1/stars/order?id=' + o1, initData(S1));
    ok(r.j.status === 'paid' && r.j.balance === 50, `stars: the order is paid ${JSON.stringify(r.j)}`);
    a = await checkout(S1, o1);
    ok(a && a.ok === false, `pre_checkout: a paid order → ok:false ${JSON.stringify(a)}`);
    ok((await call('GET', '/v1/profile', initData(S1))).j.coins === 0, 'buying stars gives no coins by itself (coins only through the shop)');
    // a second order (s120) and a refund of the first: −50
    const o2 = (await call('POST', '/v1/stars/invoice', initData(S1), { pack: 's120' })).j.order, ch2 = ch1 + 'b';
    await pay(S1, o2, ch2, 100);
    ok((await starsOf(S1)) === 170, 'successful_payment: s120 → 170');
    const refund = (from, charge, amount) => hookRaw({ update_id: 4, message: { message_id: 8, from, chat: { id: from.id, type: 'private' }, date: Math.floor(Date.now() / 1000),
      refunded_payment: { currency: 'XTR', total_amount: amount, invoice_payload: '', telegram_payment_charge_id: charge } } });
    ok((await refund(S1, ch1, 50)).status === 200 && (await starsOf(S1)) === 120, 'refunded_payment: −50 → 120');
    ok((await refund(S1, ch1, 50)).status === 200 && (await starsOf(S1)) === 120, 'refunded_payment: the same refund again takes nothing');
    r = await call('GET', '/v1/stars/order?id=' + o1, initData(S1));
    ok(r.j.status === 'refunded', `stars: the first order is refunded ${JSON.stringify(r.j)}`);
    // a refund after the stars were spent (no shop yet: the balance is cut in D1 by hand) — never below zero
    execFileSync(join(ROOT, 'node_modules', '.bin', 'wrangler'), ['d1', 'execute', 'DB', '--local', '--persist-to', persist, '--command', `UPDATE users SET stars = 20 WHERE user_id = ${S1.id}`],
      { cwd: join(ROOT, 'server'), stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
    ok((await starsOf(S1)) === 20, 'stars: 100 of 120 spent (set in D1)');
    ok((await refund(S1, ch2, 100)).status === 200 && (await starsOf(S1)) === 0, 'refunded_payment with 20 left of 120 → 0, not below');
    const rows = JSON.parse(execFileSync(join(ROOT, 'node_modules', '.bin', 'wrangler'), ['d1', 'execute', 'DB', '--local', '--persist-to', persist, '--json', '--command',
      `SELECT status, refund_short, charge_id FROM star_orders WHERE id = '${o2}'; SELECT delta, reason, balance_after, currency FROM ledger WHERE user_id = ${S1.id} ORDER BY id`],
      { cwd: join(ROOT, 'server'), stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } }).toString());
    const od = rows[0].results[0], lg = rows[1].results.map((x) => `${x.reason}:${x.delta}:${x.balance_after}:${x.currency}`).join(' ');
    ok(od && od.status === 'refunded' && od.refund_short === 100 && od.charge_id === ch2, `refund: the order marks 100 not taken back ${JSON.stringify(od)}`);
    ok(lg === 'stars_buy:50:50:stars stars_buy:120:170:stars stars_refund:-50:120:stars stars_refund:-20:0:stars', `refund: ledger rows ${lg}`);
    // a payment no order matches is kept, not lost; commands
    await pay(S2, 'cdcdcdcdcdcdcdcdcdcdcdcd', ch1 + 'zz');
    ok((await starsOf(S2)) === 0, 'successful_payment for an unknown order credits nothing (kept as unmatched)');
    botCalls.length = 0;
    await hookRaw({ update_id: 5, message: { message_id: 9, from: S1, chat: { id: S1.id, type: 'private' }, date: 1, text: '/paysupport' } });
    await hookRaw({ update_id: 6, message: { message_id: 10, from: { ...S1, language_code: 'ru' }, chat: { id: S1.id, type: 'private' }, date: 1, text: '/terms@bvr_games_bot' } });
    const sm = botCalls.filter((c) => c.method === 'sendMessage');
    // /start on three languages: «the BVR games bot» and two web_app buttons — «Хоккей» → hockey, «Все игры» → the hub;
    // /start <param> → straight into hockey by its direct link with ?startapp=<param> (the way an invite reaches it);
    // anything else → the hint with the same two buttons; a group → silence
    const say = async (from, text, chat = { id: from.id, type: 'private' }) => {
      botCalls.length = 0;
      await hookRaw({ update_id: 7, message: { message_id: 11, from, chat, date: 1, text } });
      return botCalls.filter((c) => c.method === 'sendMessage');
    };
    const btn = (m) => m && m.params.reply_markup && m.params.reply_markup.inline_keyboard[0][0];
    const two = (m, hockey, hub) => { const k = m && m.params.reply_markup && m.params.reply_markup.inline_keyboard;
      return !!k && k.length === 1 && k[0].length === 2 && k[0][0].text === hockey && k[0][0].web_app && k[0][0].web_app.url === 'https://bvr-hockey26.vercel.app/' &&
        k[0][1].text === hub && k[0][1].web_app && k[0][1].web_app.url === 'https://bvr-games-hub.vercel.app/' && !k[0][0].url && !k[0][1].url; };
    for (const [lang, word, hockey, hub] of [['ru', 'бот игр BVR', 'Хоккей', 'Все игры'], ['en', 'BVR games bot', 'Hockey', 'All games'], ['id', 'bot game BVR', 'Hoki', 'Semua game'], ['de', 'BVR games bot', 'Hockey', 'All games']]) {
      const [m] = await say({ ...S1, language_code: lang }, '/start');
      ok(m && m.params.text.includes(word) && two(m, hockey, hub), `/start (${lang}) → greeting + «${hockey}» and «${hub}» web_app ${JSON.stringify(m && m.params)}`);
    }
    let [ms] = await say(S1, '/start dbg_ABC12');
    ok(btn(ms) && btn(ms).url === 'https://t.me/bvr_games_bot/hockeytg?startapp=dbg_ABC12' && !btn(ms).web_app && btn(ms).text === 'Hockey' && ms.params.reply_markup.inline_keyboard[0].length === 1,
      `/start with a parameter → straight into hockey by the direct link with startapp ${JSON.stringify(ms && ms.params.reply_markup)}`);
    [ms] = await say(S1, '/start bad<param>');
    ok(two(ms, 'Hockey', 'All games'), '/start with a malformed parameter → the two buttons');
    [ms] = await say({ ...S1, language_code: 'ru' }, 'привет, а где игра?');
    ok(ms && /бот игр BVR/.test(ms.params.text) && /\/paysupport/.test(ms.params.text) && two(ms, 'Хоккей', 'Все игры'), `a plain message → the hint with both buttons ${JSON.stringify(ms && ms.params)}`);
    [ms] = await say({ ...S1, language_code: 'id' }, 'halo');
    ok(ms && /bot game BVR/.test(ms.params.text) && two(ms, 'Hoki', 'Semua game'), 'a plain message in Indonesian');
    ok((await say(S1, '/start', { id: -100123, type: 'group' })).length === 0, 'a group chat: no answer');
    // /paysupport sends to a person; /terms says what stars and coins are and what the game stores
    for (const lang of ['ru', 'en', 'id']) {
      const [ps] = await say({ ...S1, language_code: lang }, '/paysupport'), [tm] = await say({ ...S1, language_code: lang }, '/terms');
      ok(ps && /@Bikmetov_vr/.test(ps.params.text) && /3/.test(ps.params.text), `/paysupport (${lang}) → @Bikmetov_vr ${ps && ps.params.text}`);
      ok(tm && /Telegram id|id Telegram/.test(tm.params.text) && /username/.test(tm.params.text) && /\/paysupport/.test(tm.params.text) && /(монет|coins|koin)/i.test(tm.params.text), `/terms (${lang}) ${tm && tm.params.text.slice(0, 80)}`);
    }
    ok(sm.length === 2 && /support/i.test(sm[0].params.text) && /Telegram id/.test(sm[1].params.text) && /монет/.test(sm[1].params.text), `/paysupport and /terms answer ${JSON.stringify(sm.map((x) => x.params.text.slice(0, 40)))}`);
    // ---- coins for stars (the shop): one way, one transaction, idempotent by idem, never below zero, outside the caps
    {
      const X = { id: A.id + 40, first_name: 'Shop', last_name: 'Per', language_code: 'ru' }, ix = initData(X);
      const buy = (pack, idem, idata = ix) => call('POST', '/v1/shop/coins', idata, { pack, idem });
      const bal = async () => { const j = (await call('GET', '/v1/profile', ix)).j; return [j.coins, j.stars]; };
      let pr = (await call('GET', '/v1/profile', ix)).j;
      ok(pr.coinPacks && pr.coinPacks.map((x) => `${x.coins}/${x.stars}`).join(' ') === '100/20 300/50 700/100', `shop: coin packs from the server ${JSON.stringify(pr.coinPacks)}`);
      ok((await buy('c100', 'idem-zero-0001')).status === 402 && JSON.stringify(await bal()) === '[0,0]', 'shop: no stars → 402, nothing changes');
      const ord = (await call('POST', '/v1/stars/invoice', ix, { pack: 's300' })).j.order, chX = 'stxSHOP' + Date.now();
      await pay(X, ord, chX, 250);
      ok(JSON.stringify(await bal()) === '[0,300]', 'shop: 300 stars bought for the test');
      let rr = await buy('c100', 'idem-c100-0001');
      ok(rr.status === 200 && rr.j.coins === 100 && rr.j.stars === 20 && rr.j.balance.coins === 100 && rr.j.balance.stars === 280 && !rr.j.repeat, `shop: c100 → +100 coins −20 stars ${JSON.stringify(rr.j)}`);
      rr = await buy('c300', 'idem-c300-0001');
      ok(rr.status === 200 && rr.j.balance.coins === 400 && rr.j.balance.stars === 230, `shop: c300 → +300 −50 ${JSON.stringify(rr.j)}`);
      rr = await buy('c700', 'idem-c700-0001');
      ok(rr.status === 200 && rr.j.balance.coins === 1100 && rr.j.balance.stars === 130, `shop: c700 → +700 −100 ${JSON.stringify(rr.j)}`);
      rr = await buy('c700', 'idem-c700-0001');
      ok(rr.status === 200 && rr.j.repeat === true && JSON.stringify(await bal()) === '[1100,130]', `shop: the same idem again takes nothing twice ${JSON.stringify(rr.j)}`);
      rr = await buy('c100', 'idem-c700-0001');
      ok(rr.j.repeat === true && JSON.stringify(await bal()) === '[1100,130]', 'shop: the same idem with another pack — still nothing');
      await buy('c700', 'idem-c700-0002');
      rr = await buy('c300', 'idem-c300-0002');
      ok(rr.status === 402 && rr.j.need === 50 && rr.j.have === 30 && JSON.stringify(await bal()) === '[1800,30]', `shop: 30 stars left, c300 → 402, not below zero ${JSON.stringify(rr.j)}`);
      ok((await buy('c999', 'idem-x-000001')).status === 422 && (await buy('c100', 'bad idem!')).status === 422 && (await buy('c100', 'idem-unsigned-01', null)).status === 401,
        'shop: unknown pack / bad idem → 422, unsigned → 401');
      // bought coins are outside the daily match cap: a win still pays its 15, the day counts 15
      rr = await call('POST', '/v1/match', ix, summary());
      ok(rr.status === 200 && rr.j.coins === 15 && rr.j.day.coins === 15 && rr.j.balance === 1815, `shop: bought coins are not in the daily cap ${JSON.stringify(rr.j)}`);
      // a refund of the stars after they went on coins: the stars left go (30 of 300), the coins stay, the order marks 270
      await refund(X, chX, 250);
      ok(JSON.stringify(await bal()) === '[1815,0]', `refund after the exchange: stars 0, coins kept ${JSON.stringify(await bal())}`);
      ok((await call('GET', '/v1/stars/order?id=' + ord, ix)).j.status === 'refunded', 'refund after the exchange: the order is refunded');
      const lgX = JSON.parse(execFileSync(join(ROOT, 'node_modules', '.bin', 'wrangler'), ['d1', 'execute', 'DB', '--local', '--persist-to', persist, '--json', '--command',
        `SELECT reason, delta, currency, ref FROM ledger WHERE user_id = ${X.id} AND reason IN ('stars_to_coins', 'coins_bought') ORDER BY id; SELECT refund_short FROM star_orders WHERE id = '${ord}'`],
        { cwd: join(ROOT, 'server'), stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } }).toString());
      const rowsX = lgX[0].results.map((x) => `${x.reason}:${x.delta}:${x.currency}`).join(' ');
      ok(rowsX === 'stars_to_coins:-20:stars coins_bought:100:coins stars_to_coins:-50:stars coins_bought:300:coins stars_to_coins:-100:stars coins_bought:700:coins stars_to_coins:-100:stars coins_bought:700:coins'
        && lgX[1].results[0].refund_short === 270, `shop: two ledger rows per purchase, refund_short 270 ${rowsX} ${JSON.stringify(lgX[1].results)}`);
    }
    // the one-time setup: without the secret 403; with it — setWebhook with the secret and the commands
    ok((await fetch(API + '/tg/setup?do=install', { method: 'POST' })).status === 403, 'setup without the secret → 403');
    botCalls.length = 0;
    r = await fetch(API + '/tg/setup?do=install', { method: 'POST', headers: { 'X-Setup-Secret': HOOK_SECRET } });
    const sw = botCalls.find((c) => c.method === 'setWebhook'), sc = botCalls.find((c) => c.method === 'setMyCommands' && !c.params.language_code);
    ok(!botCalls.some((c) => c.method === 'setChatMenuButton') && botCalls.some((c) => c.method === 'getChatMenuButton'), 'setup: the menu button (the games hub) is never changed');
    ok(r.status === 200 && sw && sw.params.url === API + '/tg/webhook' && sw.params.secret_token === HOOK_SECRET && sw.params.allowed_updates.includes('pre_checkout_query') &&
       sc && sc.params.commands.map((c) => c.command).join() === 'start,paysupport,terms', `setup: setWebhook + setMyCommands ${JSON.stringify([r.status, sw && sw.params, sc && sc.params])}`);
  }


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

  // ---------- the developer's page: 403 on every /v1/admin/* to all but ADMIN_IDS; the admin gets the data
  {
    const get = async (path, idata, pf) => { const h = {}; if (idata) h['X-Telegram-Init-Data'] = idata; if (pf) h['X-Tg-Platform'] = pf;
      const r = await fetch(API + path, { headers: h }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, j, t, ct: r.headers.get('content-type') || '' }; };
    const S1 = { id: A.id + 20, first_name: 'Star', last_name: 'Buyer', language_code: 'en' };
    const P = [`/v1/admin/me`, `/v1/admin/ui.js`, `/v1/admin/overview`, `/v1/admin/players?q=Star&sort=coins`, `/v1/admin/player?id=${S1.id}`, `/v1/admin/payments?status=paid`, `/v1/admin/nothing`];
    const forged = initData(ADMIN, { token: 'ANOTHER_BOT' }), tampered = initData(A, { tamper: { user: JSON.stringify(ADMIN) } });
    for (const path of P) {
      const got = [(await get(path, null)).status, (await get(path, ia)).status, (await get(path, forged)).status, (await get(path, tampered)).status];
      ok(got.every((x) => x === 403), `admin: ${path} → 403 unsigned / a player / signed by another bot / admin id put in (${got})`);
      const body = (await get(path, ia)).t;
      ok(!/Разработчик|BVRDev|overview|players/.test(body), `admin: a player's 403 on ${path} says nothing (${body.slice(0, 60)})`);
    }
    // who the player is: username, language, premium, platform, last seen — from initData and X-Tg-Platform
    const T1 = { id: A.id + 30, first_name: 'Track', username: 'track_me', language_code: 'id', is_premium: true };
    await get('/v1/profile', initData(T1), 'android');
    await get('/v1/profile', initData({ id: A.id + 31, first_name: 'Ios' }), 'ios');
    await get('/v1/profile', initData({ id: A.id + 32, first_name: 'Desk' }), 'tdesktop');
    await get('/v1/profile', initData({ id: A.id + 33, first_name: 'Odd' }), 'Bad Value!');
    let r = await get('/v1/admin/me', initData(ADMIN));
    ok(r.status === 200 && r.j.id === ADMIN.id && r.j.label, `admin: me → 200 ${r.t}`);
    r = await get('/v1/admin/ui.js', initData(ADMIN));
    ok(r.status === 200 && /javascript/.test(r.ct) && /function BVRDev\(K\)/.test(r.t), `admin: ui.js is the page's text (${r.status} ${r.ct} ${r.t.length} B)`);
    r = await get('/v1/admin/overview', initData(ADMIN));
    const o = r.j;
    ok(r.status === 200 && o.players.total >= 10 && o.players.new1 === o.players.total && o.newByDay.length === 30 && o.newByDay[29] === o.players.total,
      `admin: overview players ${JSON.stringify(o && o.players)}`);
    ok(o.matches.day.ai >= 10 && o.matches.day.server >= 2 && o.matches.n30 >= 12 && o.matches.avgLen > 0 && o.matches.done > 0.5 && o.matches.byDay.ai[29] === o.matches.day.ai,
      `admin: overview matches ${JSON.stringify(o.matches.day)} n30 ${o.matches.n30} avg ${o.matches.avgLen} done ${o.matches.done}`);
    ok(o.coins.issued > 100 && o.coins.circ > 0 && o.stakes.n >= 1 && o.stars.buys === 3 && o.stars.sold === 50 + 120 + 300 && o.stars.xall === 50 + 100 + 50 + 250 && o.stars.refunds === 3 && o.stars.unmatched === 1 &&
       o.stars.short === 2 && o.stars.shortStars === 100 + 270 && o.shop.n === 4 && o.shop.coinsAll === 1800 && o.shop.starsAll === 270 && o.shop.coins1 === 1800 && o.shop.stars30 === 270,
      `admin: overview coins / stakes / stars ${JSON.stringify([o.coins, o.stakes, o.stars])}`);
    ok(o.platforms.android >= 1 && o.platforms.ios >= 1 && o.platforms.pc >= 1 && o.langs.some((l) => l[0] === 'id'), `admin: platforms and languages ${JSON.stringify([o.platforms, o.langs])}`);
    r = await get('/v1/admin/players?q=track_me', initData(ADMIN));
    const t1 = r.j && r.j.rows[0];
    ok(r.status === 200 && r.j.total === 1 && t1.id === T1.id && t1.username === 'track_me' && t1.platform === 'android' && t1.lang === 'id' && t1.seen > 0, `admin: search by username, the stored player ${JSON.stringify(t1)}`);
    ok((await get('/v1/admin/players?q=' + T1.id, initData(ADMIN))).j.rows[0].id === T1.id, 'admin: search by id');
    ok((await get('/v1/admin/players?q=%25', initData(ADMIN))).j.total === 0, 'admin: % in the search is a plain character');
    r = await get('/v1/admin/players?sort=bought', initData(ADMIN));
    ok(r.j.rows[0].id === A.id + 40 && r.j.rows[0].bought === 250 && r.j.rows[1].id === S1.id && r.j.rows[1].bought === 150 && r.j.total >= 10 && r.j.size === 50,
      `admin: sorted by Stars bought ${JSON.stringify(r.j.rows.slice(0, 2))}`);
    r = await get('/v1/admin/players?sort=seen&page=1', initData(ADMIN));
    ok(r.status === 200 && r.j.page === 1 && Array.isArray(r.j.rows), 'admin: a second page');
    r = await get(`/v1/admin/player?id=${A.id + 31}`, initData(ADMIN));
    ok(r.j.user && r.j.user.platform === 'ios', `admin: the platform header is stored ${JSON.stringify(r.j.user)}`);
    ok((await get(`/v1/admin/player?id=${A.id + 33}`, initData(ADMIN))).j.user.platform === null, 'admin: a malformed platform is not stored');
    ok((await get(`/v1/admin/player?id=${T1.id}`, initData(ADMIN))).j.user.premium === 1, 'admin: premium stored');
    r = await get(`/v1/admin/player?id=${S1.id}`, initData(ADMIN));
    const c = r.j;
    ok(c.user.stars === 0 && c.user.bought === 150 && c.orders.length === 2 && c.orders.every((x) => x.status === 'refunded' && x.charge) &&
       c.ledger.filter((l) => l.currency === 'stars').length === 4, `admin: the player's card: orders and ledger ${JSON.stringify([c.user, c.orders.map((x) => x.status), c.ledger.length])}`);
    r = await get(`/v1/admin/player?id=${SH.id}`, initData(ADMIN));
    ok(r.j.stakes.length >= 1 && r.j.matches.length >= 2 && r.j.matches.some((m) => m.net === 'server'), `admin: card with stakes and server matches ${JSON.stringify([r.j.stakes.length, r.j.matches.map((m) => m.net)])}`);
    r = await get('/v1/admin/payments', initData(ADMIN));
    ok(r.j.total === 4 && r.j.rows.some((x) => x.status === 'unmatched') && r.j.rows.filter((x) => x.status === 'refunded' && x.charge && x.name === 'Star Buyer').length === 2,
      `admin: payments ${JSON.stringify(r.j.rows.map((x) => x.status + ':' + (x.charge || '')))}`);
    ok((await get('/v1/admin/payments?status=refunded', initData(ADMIN))).j.total === 3, 'admin: payments filtered by status');
    r = await get('/v1/admin/payments?status=short', initData(ADMIN));
    ok(r.j.total === 2 && r.j.rows.some((x) => x.short === 270 && x.name === 'Shop Per'), `admin: refunds short of stars shown apart ${JSON.stringify(r.j.rows.map((x) => [x.name, x.short]))}`);
    r = await get(`/v1/admin/player?id=${A.id + 40}`, initData(ADMIN));
    ok(r.j.shop && r.j.shop.length === 4 && r.j.shop[0].coins === 700 && r.j.shop[0].stars === 100, `admin: the card lists coins bought for stars ${JSON.stringify(r.j.shop)}`);
    ok((await get('/v1/admin/player?id=abc', initData(ADMIN))).status === 422, 'admin: a bad id → 422');
  }

  // the game itself: queue on start, profile, reward on the result screen
  {
    const E = { id: A.id + 4, first_name: 'Game' };
    const queued = summary();
    const tg = fakeTelegram().replace(/initData:'[^']*'/, 'initData:' + JSON.stringify(initData(E)));
    const srv = await startServer(port + 1);
    const g = await openGame('chromium', { tg });
    const adminReqs = []; g.page.on('request', (q) => { if (/\/v1\/admin\//.test(q.url())) adminReqs.push(q.url().replace(API, '')); });
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
      // a regular player: no item, no texts, no requests to the developer's page beyond the one /v1/admin/me (403)
      await g.page.waitForTimeout(1500);
      await g.page.evaluate(() => { __hk.menu('settings'); __hk.menu('main'); __hk.menu('profile'); __hk.menu('main'); });
      await g.page.waitForTimeout(2500);
      const ex = await g.page.evaluate(() => ({ ...__hk.ext(), html: document.getElementById('start').innerHTML }));
      ok(!ex.ok && ex.item === 0 && ex.st === 'no' && !/Разработчик|BVRDev/.test(ex.html) && adminReqs.join() === '/v1/admin/me', `admin: a player has no item and asks only /me once, 403 is not repeated (menu visited) ${JSON.stringify([ex, adminReqs].map((x) => x.html ? { ...x, html: 0 } : x))}`);
      // ---- stars: «+» at the stars in the wallet → packs from the server → invoice → Telegram says 'paid' → the client
      // waits for the webhook's payment, then the stars fly into the wallet; 'cancelled' credits nothing
      await g.page.evaluate(() => { __hk.result(); __hk.menu('main'); });
      await g.page.waitForTimeout(300);
      let sb = await g.page.evaluate(() => __hk.sb());
      ok(sb.ok && sb.btn === 2 && sb.packs && sb.packs.length === 3, `stars: «+» in the wallet on the main menu and the profile, packs from the profile ${JSON.stringify(sb)}`);
      await g.page.click('#start section.cur .mtopup');
      await g.page.waitForTimeout(300);
      ok((await g.page.evaluate(() => __hk.menuState().stack.join('>'))) === 'main>stars', 'stars: «+» opens the packs screen');
      await g.page.click('#start section.cur .msbp[data-pack="s50"]');
      await g.page.waitForFunction(() => window.__tgInvoice && __hk.sb().st === 'open', null, { timeout: 10000 }).catch(() => {});
      const inv = await g.page.evaluate(() => ({ url: (window.__tgInvoice || {}).url, sb: __hk.sb() }));
      ok(inv.sb.st === 'open' && inv.url === 'https://t.me/$smoke_' + inv.sb.order, `stars: the invoice opened in Telegram ${JSON.stringify(inv)}`);
      await g.page.evaluate(() => __tgInvoiceClose('paid'));
      await g.page.waitForTimeout(2500);
      sb = await g.page.evaluate(() => __hk.sb());
      ok(sb.st === 'wait' && (await g.page.evaluate(() => __hk.coins().stars)) === 0, `stars: 'paid' from Telegram alone credits nothing — waits for the server ${JSON.stringify(sb)}`);
      const hook = (upd) => fetch(API + '/tg/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': HOOK_SECRET }, body: JSON.stringify(upd) });
      await hook({ update_id: 50, message: { message_id: 50, from: E, chat: { id: E.id, type: 'private' }, date: Math.floor(Date.now() / 1000),
        successful_payment: { currency: 'XTR', total_amount: 50, invoice_payload: inv.sb.order, telegram_payment_charge_id: 'stxGAME' + Date.now(), provider_payment_charge_id: '' } } });
      let flewS = 0;
      for (let t = 0; t < 60; t++) { await g.page.waitForTimeout(100); sb = await g.page.evaluate(() => __hk.sb()); flewS = Math.max(flewS, sb.fly); if (sb.st === 'done' && !sb.fly && t > 10) break; }
      const st50 = await g.page.evaluate(() => ({ stars: __hk.coins().stars, wal: document.querySelector('#start section.cur [data-stars]').textContent }));
      ok(sb.st === 'done' && /50/.test(sb.text) && flewS >= 3 && st50.stars === 50 && st50.wal === '50', `stars: confirmed → +50 flew into the wallet ${JSON.stringify([sb, flewS, st50])}`);
      await g.page.click('#start section.cur .msbp[data-pack="s120"]');
      await g.page.waitForFunction(() => window.__tgInvoiceClose && __hk.sb().st === 'open', null, { timeout: 10000 }).catch(() => {});
      await g.page.evaluate(() => __tgInvoiceClose('cancelled'));
      await g.page.waitForTimeout(500);
      sb = await g.page.evaluate(() => __hk.sb());
      ok(sb.st === 'cancel' && sb.text.length > 5 && (await g.page.evaluate(() => __hk.coins().stars)) === 50, `stars: 'cancelled' → a calm message, nothing credited ${JSON.stringify(sb)}`);
      // ---- the shop: coins for stars — confirm, buy, coins fly into the wallet; not enough stars → «top up»
      await g.page.evaluate(() => { __hk.menu('main'); __hk.menu('shop'); });
      await g.page.waitForTimeout(300);
      let sh = await g.page.evaluate(() => __hk.sh());
      ok(sh.ok && sh.cards === 3, `shop: three coin packs in the shop ${JSON.stringify(sh)}`);
      const c0 = await g.page.evaluate(() => __hk.coins());
      await g.page.click('#start section.cur .mshc[data-pack="c100"]');
      await g.page.waitForTimeout(200);
      sh = await g.page.evaluate(() => __hk.sh());
      ok(sh.st === 'ask' && /100/.test(sh.text) && /20/.test(sh.text), `shop: a tap asks first ${JSON.stringify(sh.text)}`);
      await g.page.click('#start section.cur [data-act="cyes"]');
      let flewC = 0;
      for (let t = 0; t < 60; t++) { await g.page.waitForTimeout(100); sh = await g.page.evaluate(() => __hk.sh()); flewC = Math.max(flewC, sh.fly); if (sh.st === 'done' && !sh.fly && t > 10) break; }
      const c1 = await g.page.evaluate(() => ({ ...__hk.coins(), wal: document.querySelector('#start section.cur [data-coins]').textContent }));
      ok(sh.st === 'done' && flewC >= 3 && c1.coins === c0.coins + 100 && c1.stars === c0.stars - 20 && c1.wal === String(c1.coins), `shop: bought — +100 coins flew, −20 stars ${JSON.stringify([c0.coins, c0.stars, c1.coins, c1.stars, flewC])}`);
      await g.page.click('#start section.cur .mshc[data-pack="c300"]');
      await g.page.waitForTimeout(200);
      sh = await g.page.evaluate(() => __hk.sh());
      ok(sh.st === 'no' && (await g.page.$('#start section.cur [data-act="topup"]')), `shop: ${c1.stars} stars for 50 → not enough, «top up» ${JSON.stringify(sh.text)}`);
      await g.page.click('#start section.cur .mshq [data-act="topup"]');
      await g.page.waitForTimeout(300);
      ok((await g.page.evaluate(() => __hk.menuState().stack.join('>'))) === 'main>shop>stars', 'shop: «top up» opens the stars packs');
      // the request aborted on purpose above; the 403 of /v1/admin/me (a regular player) is the expected answer
      const errs = g.logs.filter(isError).filter((e) => !/ERR_FAILED/.test(e.text) && !/status of 403/.test(e.text));
      ok(!errs.length, `game: page errors ${JSON.stringify(errs).slice(0, 400)}`);
    } finally { await g.browser.close(); srv.close(); }
    // the admin: the item comes with the server's label, the page is loaded from the Worker and shows the overview
    {
      const srv3 = await startServer(port + 1);
      const tga = fakeTelegram().replace(/initData:'[^']*'/, 'initData:' + JSON.stringify(initData(ADMIN)));
      const ga = await openGame('chromium', { w: 844, h: 390, tg: tga });
      try {
        // the first 4 /v1/admin/me fail on the network: retried after 2 and 5 s (no item yet), then 12 s; after that —
        // once more on coming back to the main menu, and that one gets through
        let meFail = 4, meN = 0;
        await ga.page.route(/\/v1\/admin\/me/, (rt) => { meN++; if (meFail-- > 0) rt.abort(); else rt.continue(); });
        await ga.page.addInitScript(() => { try { localStorage.setItem('bvr_onboard', '1'); } catch (e) {} });
        await ga.page.goto(`http://127.0.0.1:${port + 1}/index.html?nomusic&api=${encodeURIComponent(API)}`, { waitUntil: 'load', timeout: 120000 });
        await ga.page.waitForFunction(() => window.__hk && __hk.ext && __hk.ext().n >= 3, null, { timeout: 20000 }).catch(() => {});
        let ee = await ga.page.evaluate(() => __hk.ext());
        ok(ee.n === 3 && ee.item === 0 && meN === 3, `admin: a network error is retried (3 tries in ~9 s) ${JSON.stringify([ee, meN])}`);
        await ga.page.waitForFunction(() => __hk.ext().n === 4 && __hk.ext().st === 'err', null, { timeout: 20000 }).catch(() => {});
        await ga.page.waitForTimeout(1000);
        ee = await ga.page.evaluate(() => __hk.ext());
        ok(ee.n === 4 && ee.st === 'err' && ee.item === 0, `admin: after the retries — waits for the main menu ${JSON.stringify(ee)}`);
        await ga.page.evaluate(() => { __hk.menu('settings'); __hk.menu('main'); });
        await ga.page.waitForFunction(() => window.__hk && __hk.ext && __hk.ext().item === 1, null, { timeout: 20000 }).catch(() => {});
        ee = await ga.page.evaluate(() => __hk.ext());
        ok(ee.item === 1 && ee.n === 5 && meN === 5, `admin: back in the main menu → asked again, the item is in the admin's main menu ${JSON.stringify([ee, meN])}`);
        await ga.page.evaluate(() => { __hk.menu('settings'); __hk.menu('main'); });
        await ga.page.waitForTimeout(500);
        ok(meN === 5, 'admin: no more /me once it is known');
        await ga.page.click('#start section.cur [data-act="ext"]');
        await ga.page.waitForFunction(() => /Игроки/.test((document.querySelector('#start section[data-s="ext"]') || {}).textContent || '') && /всего/.test(document.querySelector('#start section[data-s="ext"]').textContent), null, { timeout: 15000 }).catch(() => {});
        const tx = await ga.page.evaluate(() => ({ e: __hk.ext(), top: __hk.menuState().stack.join('>'), t: document.querySelector('#start section[data-s="ext"]').textContent.slice(0, 200) }));
        ok(tx.e.mod && tx.top === 'main>ext' && /Обзор/.test(tx.t) && /всего/.test(tx.t), `admin: the page opened on the overview ${JSON.stringify(tx)}`);
        await ga.page.click('#start section.cur .mtab[data-tab="1"]');
        await ga.page.waitForFunction(() => document.querySelectorAll('#start section.cur .xd-r.mf').length > 0, null, { timeout: 10000 }).catch(() => {});
        await ga.page.fill('#xq', 'track_me');
        await ga.page.waitForFunction(() => document.querySelectorAll('#start section.cur .xd-r.mf').length === 1, null, { timeout: 10000 }).catch(() => {});
        await ga.page.click('#start section.cur .xd-r.mf');
        await ga.page.waitForFunction(() => /последние матчи/i.test(document.querySelector('#start section.cur').textContent), null, { timeout: 10000 }).catch(() => {});
        const card = await ga.page.evaluate(() => document.querySelector('#start section.cur').textContent);
        ok(/track_me/.test(card) && /Android/.test(card) && /последние матчи/i.test(card), `admin: search → the player's card ${card.slice(0, 160)}`);
        await ga.page.evaluate(() => __tgBackClick());
        await ga.page.waitForTimeout(300);
        ok((await ga.page.evaluate(() => __hk.menuState().stack.join('>'))) === 'main>ext' && (await ga.page.evaluate(() => !!document.getElementById('xq'))), 'admin: «Назад» from the card returns to the list');
        const ae = ga.logs.filter(isError).filter((e) => !/ERR_FAILED/.test(e.text));   // /v1/admin/me aborted on purpose above
        ok(!ae.length, `admin: page errors ${JSON.stringify(ae).slice(0, 300)}`);
      } finally { await ga.browser.close(); srv3.close(); }
    }
    // outside Telegram (no initData, no openInvoice) there is no «+»
    const srv2 = await startServer(port + 1), g2 = await openGame('chromium');
    try {
      await g2.page.goto(`http://127.0.0.1:${port + 1}/index.html?nomusic&api=${encodeURIComponent(API)}`, { waitUntil: 'load', timeout: 120000 });
      await g2.page.waitForFunction('window.__hk && __hk.menuState && __hk.menuState().layer==="menu"', null, { timeout: 60000 });
      await g2.page.evaluate(() => { __hk.menu('main'); __hk.menu('profile'); });
      const sb2 = await g2.page.evaluate(() => __hk.sb());
      ok(!sb2.ok && sb2.btn === 0, `stars: no «+» outside Telegram ${JSON.stringify(sb2)}`);
    } finally { await g2.browser.close(); srv2.close(); }
  }


  // ---------- no result from the room → refund: a Worker whose stakes are already past their deadline when locked
  // (STAKE_GRACE far below zero) — the room's alarm and the profile's sweep refund it; the match's own end later pays nothing
  w.close(); await sleep(800);
  w = await startWrangler(port, { args: ['--persist-to', persist, ...VARS, '--var', 'MATCH_GAP:0', '--var', 'MIN_LEN:10', '--var', 'STAKE_GRACE:-100000'] });
  {
    // the staked match above may have left the loser with 5 coins: a won match against the AI each (+15) for the stake of 10
    for (const u of [SH, SG]) await call('POST', '/v1/match', initData(u), summary());
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
  botSrv.close();
  try { rmSync(persist, { recursive: true, force: true }); } catch (e) {}
}
console.log(`smoke-api: ${fails.length ? 'FAIL' : 'OK'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
for (const f of fails) console.log('  ✗ ' + f);
process.exit(fails.length ? 1 : 0);
