/**
 * BVR Hockey — coins and player stats: the platform-neutral part (docs/EVENTS.md «Итог матча и бэкенд», «Перенос API»).
 *
 * Everything that decides who the player is and how many coins a match is worth lives here, with no Cloudflare in it:
 * the Telegram initData check (WebCrypto — the same in Workers, Node.js ≥ 20, Deno, Bun), the plausibility check of a
 * match:summary, the reward formula, the daily caps and rate limits, and the HTTP handler itself on the standard Fetch
 * API (Request → Response). What depends on the platform comes in from outside (server/api.js on Cloudflare):
 *
 *   handleCoins(request, {
 *     botToken,               // the bot token (secret)
 *     conf(key) → number,     // overrides of DEF below (Worker vars), or undefined
 *     store,                  // the database, see STORE below (server/coins-d1.js — D1 / SQLite)
 *     roomResult(room, id),   // → { len, score } of a server-mode match the room counted itself, or null
 *     bot(method, params),    // the Bot API (botApiFrom below) — star invoices
 *     adminIds,               // ADMIN_IDS: Telegram ids allowed on /v1/admin/* (comma separated), adminUi — its page (text)
 *     now,                    // optional, unix seconds (tests)
 *   }) → Response, or null when the path is not /v1/*
 *   handleBot(request, { secret, store, bot }) → the bot's webhook (/tg/webhook): star payments, /paysupport, /terms
 *
 * STORE (all async; one player = one Telegram user id):
 *   matchSeen(uid, id) → bool                  this match id is already in for this player
 *   lastMatch(uid) → { at, len } | null        the latest accepted match
 *   matchesSince(uid, t) → n                   accepted matches since t
 *   coinsSince(uid, reason, t) → n             coins paid since t with this ledger reason ('match_ai' | 'match_duo')
 *   recordMatch(m) → 'ok' | 'duplicate'        in one transaction: create the player if new, store the match, move the
 *                                              totals and the balance, write the ledger row (when coins > 0);
 *                                              'duplicate' — the same (uid, id) got in first (two copies of one request)
 *   balance(uid) → coins
 *   stakeLock(s) → 'ok' | 'funds' | 'duplicate'  s = { id, room, amount, uids: [host, guest], len, now, deadline }: in one
 *                                              transaction the stake row, −amount from both balances (never below
 *                                              zero: 'funds' and nothing changes), ledger rows 'stake'; 'duplicate' —
 *                                              this match id already has a stake
 *   stakeGet(id) → { id, room, amount, uids, len, status: 'locked' | 'settled', outcome, created, deadline } | null
 *   stakeSettle(id, outcome, pays, now)        in one transaction, only while the stake is 'locked': pays [[uid, delta,
 *                                              reason]] into balances and ledger, status 'settled' (else nothing)
 *   stakesOverdue(uid, now) → [stake]          this player's stakes still locked after their deadline
 *   profile(uid) → { coins, stars, matches, wins, draws, losses, goals, goals_against, streak, best_streak, online,
 *                    inventory: [item ids] } | null
 *   stars (an order: { id, uid, pack, stars, price, status: 'pending' | 'paid' | 'refunded' | 'failed' | 'unmatched',
 *          charge, created, paid, refunded, short }):
 *   starOrderNew(o)                            create the player if new, the order 'pending'
 *   starOrderGet(id) → order | null            starOrderFail(id, now): 'pending' → 'failed' (no invoice was made)
 *   starOrdersSince(uid, t) → n                orders made since t
 *   starPaid({ id, uid, stars, charge, now }) → 'ok' | 'repeat'   in one transaction, only from 'pending': the order
 *                                              'paid' with the charge id, users.stars += stars, ledger 'stars_buy'
 *   starRefund({ charge, now }) → { r: 'ok' | 'repeat' | 'unknown', id, taken, short }   only from 'paid': stars back,
 *                                              never below zero (short — what was already spent), ledger 'stars_refund'
 *   starUnmatched({ uid, name, charge, amount, payload, now })   a payment no order matches, kept as 'unmatched'
 *   starsBalance(uid) → stars
 *   touch(user, platform, now)                 who the player is on every signed request (creates the row if new)
 *   the developer's page (read only): adminOverview(t) → raw counts (coins.js overviewShape), adminPlayers({ q, id, sort,
 *   page, size }) → { total, rows }, adminPlayer(id) → { user, matches, stakes, ledger, orders }, adminPayments({ status,
 *   page, size }) → { total, rows }
 *
 * The client never adds coins: it says how the match went, the reward is decided here; the player is taken only from
 * the signed initData (user.id), the body says nothing about who sent it.
 */

export const DEF = {
  AI_COIN_CAP_MATCH: 15,   // per 3-minute match; scales with the match length like the reward
  AI_COIN_CAP_DAY: 100,    // per player per UTC day (ledger reason 'match_ai'); over it — coins 0, verdict 'capped'
  DUO_COIN_CAP_DAY: 100,   // the same for server-mode matches against a person (reason 'match_duo')
  MIN_LEN: 60,             // shorter matches are not accepted (s)
  MATCHES_DAY: 40,         // accepted matches per player per UTC day
  MATCH_GAP: 0.8,          // the next match is accepted not sooner than MATCH_GAP × len after the previous one
  AUTH_MAX_AGE: 86400,     // initData older than this (s) is refused
  STAKE_GRACE: 900,        // a stake still locked 2 × len + this (s) after the start, with no result from the room → refund
  INVOICES_HOUR: 20,       // star invoices one player may open per hour
  ADMIN_CACHE: 60,         // the developer's overview is counted again at most this often (s)
};
const REWARD = { win: 10, draw: 5, loss: 3, left: 0 };
const BONUS_MAX = 5;

// a Worker var / an environment variable overriding DEF (numbers only), else the default
export function confFrom(vars) {
  return (k) => { const v = vars ? vars[k] : undefined; return v !== undefined && v !== null && v !== '' && isFinite(+v) ? +v : DEF[k]; };
}

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, X-Telegram-Init-Data, X-Tg-Platform',
  'access-control-max-age': '86400',
};
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });
}

const enc = new TextEncoder();
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
function hex(b) { let s = ''; for (const x of b) s += (x < 16 ? '0' : '') + x.toString(16); return s; }
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);   // Workers
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0;   // elsewhere: constant time by hand
}

// Telegram Mini Apps initData check (core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
// Returns { id, name } or null.
export async function verifyInitData(initData, botToken, nowSec, maxAge = DEF.AUTH_MAX_AGE) {
  return (await checkInitData(initData, botToken, nowSec, maxAge)).user;
}
// the same with the reason of a refusal, for the owner's logs: { user } or { user: null, why: 'none' | 'format' | 'hash'
// (signed for another bot token — e.g. BOT_TOKEN is outdated after a token was revoked in @BotFather) | 'expired' |
// 'future' | 'user', age (s) }
export async function checkInitData(initData, botToken, nowSec, maxAge = DEF.AUTH_MAX_AGE) {
  const no = (why, age) => ({ user: null, why, age });
  if (!initData || !botToken) return no('none');
  if (initData.length > 4096) return no('format');
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return no('format');
  p.delete('hash');
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = await hmac('WebAppData', botToken);
  const want = enc.encode(hex(await hmac(secret, dcs)));
  const at = +p.get('auth_date');
  if (!sameBytes(want, enc.encode(hash))) return no('hash', at > 0 ? nowSec - at : null);
  if (!(at > 0) || nowSec - at > maxAge) return no('expired', at > 0 ? nowSec - at : null);
  if (at - nowSec > 300) return no('future', nowSec - at);
  let u = null; try { u = JSON.parse(p.get('user') || 'null'); } catch (e) {}
  if (!u || !Number.isSafeInteger(u.id) || u.id <= 0) return no('user');
  const name = ((u.first_name || '') + ' ' + (u.last_name || '')).trim().slice(0, 64) || (u.username || '').slice(0, 64);
  const str = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
  return { user: { id: u.id, name, username: str(u.username, 64), lang: str(u.language_code, 16), premium: u.is_premium ? 1 : 0 } };
}
// one line in `wrangler tail` per refused signature: why (no id — it is not proven when the signature is wrong)
function authLog(path, c) { console.warn('auth refused', JSON.stringify({ path, why: c.why, age: c.age })); }

const int = (v) => Number.isInteger(v) && v >= 0 && v < 1e6;
const TEAM_KEYS = ['shots', 'sog', 'goals', 'passes', 'passesDone', 'saves', 'hits'];

// null when the summary is plausible, otherwise the reason (422)
export function checkSummary(s, minLen = DEF.MIN_LEN) {
  if (!s || typeof s !== 'object' || s.v !== 1) return 'format';
  if (typeof s.id !== 'string' || !/^[0-9a-f]{8,32}$/.test(s.id)) return 'id';
  if (s.mode !== 'ai' && s.mode !== 'online') return 'mode';
  if (!['solo', 'host', 'guest'].includes(s.role) || (s.mode === 'ai') !== (s.role === 'solo')) return 'role';
  if (s.team !== 0 && s.team !== 1) return 'team';
  if (s.mode === 'online' && s.team !== (s.role === 'host' ? 0 : 1)) return 'team';
  if (!['win', 'loss', 'draw', 'left'].includes(s.result)) return 'result';
  if (s.test) return 'test';
  if (!int(s.len) || s.len < minLen || s.len > 600) return 'len';
  if (!int(s.played) || !int(s.score && s.score[0]) || !int(s.score[1])) return 'format';
  const left = s.result === 'left';
  // a player who dropped and never came back sends the match as it was at that moment
  if (!left && s.played < 0.9 * s.len) return 'played';
  if (!(s.endedAt - s.startedAt >= (s.played - 5) * 1000)) return 'time';
  const my = s.score[s.team], op = s.score[1 - s.team];
  if (!left && s.result !== (my > op ? 'win' : my < op ? 'loss' : 'draw')) return 'result';
  if (my + op > 20) return 'score';
  if (!Array.isArray(s.teams) || s.teams.length !== 2) return 'format';
  for (let t = 0; t < 2; t++) {
    const T = s.teams[t];
    if (!T || TEAM_KEYS.some((k) => !int(T[k]))) return 'format';
    if (T.goals !== s.score[t]) return 'score';
    if (T.sog > T.shots || T.passesDone > T.passes) return 'stats';
  }
  return null;
}

// coins for one match before the daily cap: result × length + goals and assists of the player's team (≤ 5)
export function matchReward(s, conf = confFrom(null)) { return rewardParts(s, conf).total; }
// the same, by parts — the result screen says what the coins are for: { base (the result), bonus (goals and assists,
// what is left of them under the per-match cap), total }
export function rewardParts(s, conf = confFrom(null)) {
  if (s.result === 'left') return { base: 0, bonus: 0, total: 0 };
  const k = Math.max(0.4, Math.min(s.len, 300) / 180);
  const cap = Math.round(conf('AI_COIN_CAP_MATCH') * k);
  const base = Math.min(cap, Math.round((REWARD[s.result] || 0) * k));
  let bonus = 0;
  if (Array.isArray(s.players)) for (const p of s.players) if (p && p.t === s.team) bonus += (int(p.g) ? p.g : 0) + (int(p.a) ? p.a : 0);
  bonus = Math.min(BONUS_MAX, bonus, cap - base);
  return { base, bonus, total: base + bonus };
}

export const dayStart = (sec) => sec - (sec % 86400);

// ---------- stakes: a coin bet on a match with a friend (server mode only), docs/EVENTS.md «Ставка на матч»
// Only coins are staked. Stars (Telegram Stars) are a donation currency: they are never staked and never turn into
// coins — otherwise this would be gambling on real money. The stake is outside the daily coin caps (own ledger
// reasons). The outcome is decided only by the room's own result (the server match), never by a client:
//   the room has a result: the winner takes both stakes, a draw gives each their own back; a player who dropped and
//   did not come back (result.left) loses the stake whatever the score (both gone — both get it back);
//   no result (the match never ended, the server went down, the room forgot it) — both get it back.
// Idempotent: one stake per match id (stakes primary key), settlement only from status 'locked', every ledger row is
// unique per (player, reason, match id).
export const STAKES = [0, 10, 25, 50, 100];

// the room result → who takes the pot: 'host' | 'guest' | 'draw' | 'refund'
export function stakeOutcome(r) {
  if (!r || !Array.isArray(r.score)) return 'refund';
  const left = Array.isArray(r.left) ? r.left : [false, false];
  if (left[0] && left[1]) return 'refund';
  if (left[0]) return 'guest';
  if (left[1]) return 'host';
  return r.score[0] > r.score[1] ? 'host' : r.score[0] < r.score[1] ? 'guest' : 'draw';
}
// the payouts of a settled stake: [[uid, delta, ledger reason]]
export function stakePayout(st, outcome) {
  const [h, g] = st.uids, n = st.amount;
  if (outcome === 'host') return [[h, 2 * n, 'stake_win']];
  if (outcome === 'guest') return [[g, 2 * n, 'stake_win']];
  return [[h, n, 'stake_back'], [g, n, 'stake_back']];
}
// what one player sees: { n, out: 'win' | 'loss' | 'back' | 'pending', delta } (delta — what came back at the end)
export function stakeView(st, uid) {
  if (!st) return null;
  const me = st.uids[0] === uid ? 'host' : st.uids[1] === uid ? 'guest' : null;
  if (!me) return null;
  if (st.status !== 'settled') return { n: st.amount, out: 'pending', delta: 0 };
  const o = st.outcome;
  const out = o === me ? 'win' : (o === 'host' || o === 'guest') ? 'loss' : 'back';
  return { n: st.amount, out, delta: out === 'win' ? 2 * st.amount : out === 'back' ? st.amount : 0 };
}

// settle the stake of match `id` by the room's result (null = there is none: refund). Safe to call any number of
// times from anywhere (the room at the end of the match, the stats API on a report or a profile read, a timer):
// only the first call pays. → the stake after it, or null when there is no stake on this match
export async function stakeFinish(store, id, result, now) {
  const st = await store.stakeGet(id);
  if (!st || st.status !== 'locked') return st;
  const outcome = stakeOutcome(result);
  await store.stakeSettle(id, outcome, stakePayout(st, outcome), now);
  return store.stakeGet(id);
}
// the stakes of this player still locked after their deadline: settled by the room's result if it has one, else
// refunded (the match never ended — the room was restarted, both players left, the server was down)
export async function stakeSweep(store, uid, now, roomResult) {
  for (const st of await store.stakesOverdue(uid, now)) {
    let r = null; try { r = await roomResult(st.room, st.id); } catch (e) {}
    await stakeFinish(store, st.id, r, now);
  }
}

// The stake offer of one room before the match: the host picks the amount, the guest confirms it; both checked against
// the balance; the match starts with a stake only when both have agreed. The room's code feeds it the players'
// verified Telegram ids and their messages, and sends view() to both after every change. No platform API in here.
//   host → {t:'stake', n}       offer (0 — no stake); a new amount drops the guest's confirmation
//   guest → {t:'stakeOk', n}    confirm exactly this amount
//   both ← {t:'stake', n, ok:[host, guest], err?, live?}   live: {id, n} — the stake of the match being played
// the stake of this reported match as this player sees it; a locked one is settled here if the room has its result
async function stakeFor(d, uid, s, now) {
  let st = await d.store.stakeGet(s.id);
  if (!st || !st.uids.includes(uid)) return null;
  if (st.status === 'locked') {
    let r = null; try { r = await d.roomResult(st.room, st.id); } catch (e) {}
    if (r) st = await stakeFinish(d.store, st.id, r, now);
  }
  return stakeView(st, uid);
}
// the deadline of a stake locked now for a match of len seconds
export function stakeDeadline(len, now, conf = confFrom(null)) { return now + 2 * len + conf('STAKE_GRACE'); }

export class StakeRoom {
  constructor() { this.uid = [null, null]; this.n = 0; this.ok = [false, false]; this.live = null; }
  view(err) { return { t: 'stake', n: this.n, ok: [this.ok[0] ? 1 : 0, this.ok[1] ? 1 : 0], ...(this.live ? { live: this.live } : {}), ...(err ? { err } : {}) }; }
  auth(slot, uid) { if (this.uid[slot] !== uid) { this.uid[slot] = uid; this.ok[slot] = false; } }
  left(slot) { this.ok[slot] = false; }                // the player left the room: a returning one confirms again
  async canPay(store, slot, n) {
    const uid = this.uid[slot];
    if (!uid) return 'auth';
    if (this.uid[0] && this.uid[0] === this.uid[1]) return 'same';
    if ((await store.balance(uid)) < n) return 'funds';
    return null;
  }
  // → null, or the reason it was refused ('amount' | 'auth' | 'funds' | 'same' | 'role')
  async offer(store, slot, n) {
    if (slot !== 0) return 'role';
    if (!STAKES.includes(n)) return 'amount';
    if (n > 0) { const e = await this.canPay(store, 0, n); if (e) return e; }
    this.n = n; this.ok = [n > 0, false];
    return null;
  }
  async confirm(store, slot, n) {
    if (slot !== 1) return 'role';
    if (n !== this.n || !(n > 0)) return 'amount';
    const e = await this.canPay(store, 1, n); if (e) return e;
    this.ok[1] = true;
    return null;
  }
  // the host starts match `id`: null (no stake, or the stake is locked — this.live) or the reason it may not start
  async start(store, { id, room, len, now, deadline }) {
    if (!(this.n > 0)) { this.live = null; return null; }
    if (!this.ok[0] || !this.ok[1]) return 'confirm';
    if (typeof id !== 'string' || !/^[0-9a-f]{8,32}$/.test(id)) return 'id';
    const r = await store.stakeLock({ id, room, amount: this.n, uids: [this.uid[0], this.uid[1]], len, now, deadline });
    if (r !== 'ok') { this.ok = [this.n > 0, false]; return r; }   // 'funds' | 'duplicate'
    this.live = { id, n: this.n };
    this.n = 0; this.ok = [false, false];              // one stake — one match: a rematch is without a stake
    return null;
  }
}

// ---------- stars: in-game stars bought for Telegram Stars (XTR), docs/EVENTS.md «Звёзды»
// Stars are a donation currency only (ice, kits, no ads): never staked, never turned into coins. The prices are here and
// only here — the client gets them from the server (/v1/profile, /v1/stars/packs); an order keeps the pack it was made
// with, so changing a price never touches orders already made. id — what the client sends, stars — what the player
// gets, price — Telegram Stars the player pays.
export const STAR_PACKS = [
  { id: 's50', stars: 50, price: 50 },
  { id: 's120', stars: 120, price: 100 },
  { id: 's300', stars: 300, price: 250 },
];
export const BOT_PATH = '/tg/webhook';     // Telegram posts updates here (setWebhook with secret_token)
// the game as Telegram opens it: the Mini App's address (web_app buttons) and its direct link (t.me/<bot>/<app>, where
// ?startapp=<param> reaches the game as start_param — the way room invites work, index.html TEST.startParam)
export const GAME = { url: 'https://bvr-hockey26.vercel.app/', link: 'https://t.me/bvr_games_bot/hockeytg' };

// The Bot API over plain fetch (the same in Workers and Node.js): (method, params) → result, or throws.
// base — https://api.telegram.org, or a fake one in tests.
export function botApiFrom(token, base = 'https://api.telegram.org') {
  return async (method, params) => {
    const r = await fetch(`${base}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params || {}) });
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!j || !j.ok) throw new Error(`bot ${method}: ${(j && j.description) || r.status}`);
    return j.result;
  };
}

// texts the bot and the invoice speak (ru / en / id by the player's Telegram language, else en)
const L3 = (lang) => (lang === 'ru' || lang === 'id' ? lang : 'en');
const ruPlural = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? few : many; };
export const BOT_TEXTS = {
  paysupport: {
    ru: 'Поддержка по платежам BVR Hockey 26.\nЕсли звёзды не пришли после оплаты или нужен возврат — напишите сюда, что случилось, и время покупки. Ответим в течение 3 дней.',
    en: 'BVR Hockey 26 payment support.\nIf your stars did not arrive after paying or you need a refund, write here what happened and when you bought. We answer within 3 days.',
    id: 'Dukungan pembayaran BVR Hockey 26.\nJika bintang tidak masuk setelah membayar atau kamu perlu pengembalian dana, tulis di sini apa yang terjadi dan kapan kamu membeli. Kami menjawab dalam 3 hari.',
  },
  terms: {
    ru: 'Условия покупки — BVR Hockey 26\n\n• Звёзды игры покупаются за Telegram Stars и зачисляются после подтверждения оплаты.\n• Звёзды — только для оформления (лёд, форма) и отключения рекламы. Они не меняются на монеты, не участвуют в ставках и не имеют денежной стоимости.\n• Возврат — через /paysupport. При возврате купленные звёзды списываются; если они уже потрачены, баланс не уходит ниже нуля.\n• Игра хранит ваш Telegram id, имя и статистику матчей.',
    en: 'Purchase terms — BVR Hockey 26\n\n• In-game stars are bought for Telegram Stars and credited once the payment is confirmed.\n• Stars are only for cosmetics (ice, kits) and turning off ads. They never turn into coins, are never staked and have no cash value.\n• Refunds — via /paysupport. A refund takes the bought stars back; if they are already spent, the balance never goes below zero.\n• The game stores your Telegram id, name and match stats.',
    id: 'Ketentuan pembelian — BVR Hockey 26\n\n• Bintang game dibeli dengan Telegram Stars dan masuk setelah pembayaran dikonfirmasi.\n• Bintang hanya untuk tampilan (es, seragam) dan mematikan iklan. Bintang tidak bisa ditukar ke koin, tidak dipakai untuk taruhan dan tidak bernilai uang.\n• Pengembalian dana — lewat /paysupport. Saat dikembalikan, bintang yang dibeli ditarik; jika sudah terpakai, saldo tidak turun di bawah nol.\n• Game menyimpan id Telegram, nama, dan statistik laga kamu.',
  },
  start: {
    ru: 'BVR Hockey 26 — аркадный хоккей 5 на 5 прямо в Telegram: матчи с ИИ и с друзьями, тренировка, монеты за победы.\nЖми «Играть»!',
    en: 'BVR Hockey 26 — arcade 5-on-5 hockey right in Telegram: matches against the AI and with friends, training, coins for wins.\nTap «Play»!',
    id: 'BVR Hockey 26 — hoki arcade 5 lawan 5 langsung di Telegram: laga melawan AI dan bersama teman, latihan, koin untuk kemenangan.\nTekan «Main»!',
  },
  play: { ru: 'Играть', en: 'Play', id: 'Main' },
  other: {
    ru: 'Я бот игры BVR Hockey 26 — нажми «Играть», чтобы открыть игру. Вопросы по оплате — /paysupport.',
    en: 'I am the BVR Hockey 26 game bot — tap «Play» to open the game. Payment questions — /paysupport.',
    id: 'Aku bot game BVR Hockey 26 — tekan «Main» untuk membuka game. Pertanyaan pembayaran — /paysupport.',
  },
  commands: [
    { command: 'start', description: { ru: 'Открыть игру', en: 'Open the game', id: 'Buka game' } },
    { command: 'paysupport', description: { ru: 'Поддержка по платежам', en: 'Payment support', id: 'Dukungan pembayaran' } },
    { command: 'terms', description: { ru: 'Условия покупки', en: 'Purchase terms', id: 'Ketentuan pembelian' } },
  ],
  invoiceTitle: (n, lang) => ({ ru: `${n} ${ruPlural(n, 'звезда', 'звезды', 'звёзд')} — BVR Hockey`, en: `${n} stars — BVR Hockey`, id: `${n} bintang — BVR Hockey` })[L3(lang)],
  invoiceDesc: {
    ru: 'Звёзды BVR Hockey 26: оформление льда, форма команды, отключение рекламы. Не меняются на монеты.',
    en: 'BVR Hockey 26 stars: ice designs, team kits, no ads. They never turn into coins.',
    id: 'Bintang BVR Hockey 26: desain es, seragam tim, tanpa iklan. Tidak bisa ditukar ke koin.',
  },
  checkoutNo: {
    ru: 'Этот счёт уже недействителен. Открой пополнение в игре заново.',
    en: 'This invoice is no longer valid. Open the top-up in the game again.',
    id: 'Tagihan ini sudah tidak berlaku. Buka isi ulang di game lagi.',
  },
};

const orderId = () => { const b = new Uint8Array(12); crypto.getRandomValues(b); return hex(b); };
const ORDER_RE = /^[0-9a-f]{24}$/;
// what the client sees of an order
const orderView = (o, balance) => ({ id: o.id, status: o.status, stars: o.stars, price: o.price, balance });

// POST /v1/stars/invoice { pack } → { order, link }: the order is written 'pending' first, then the invoice is made
// with the order id as its payload (Bot API createInvoiceLink, currency XTR, provider_token empty)
async function postInvoice(request, d, user, now) {
  let b = null; try { const t = await request.text(); if (t.length < 1024) b = JSON.parse(t); } catch (e) {}
  const pack = STAR_PACKS.find((p) => b && p.id === b.pack);
  if (!pack) return json(422, { reason: 'pack' });
  if (!d.bot) return json(503, { reason: 'not configured' });
  if (await d.store.starOrdersSince(user.id, now - 3600) >= d.conf('INVOICES_HOUR')) return json(429, { reason: 'often' });
  const id = orderId();
  await d.store.starOrderNew({ id, uid: user.id, name: user.name, pack: pack.id, stars: pack.stars, price: pack.price, now });
  let link = null;
  try {
    link = await d.bot('createInvoiceLink', {
      title: BOT_TEXTS.invoiceTitle(pack.stars, user.lang), description: BOT_TEXTS.invoiceDesc[L3(user.lang)],
      payload: id, provider_token: '', currency: 'XTR', prices: [{ label: BOT_TEXTS.invoiceTitle(pack.stars, user.lang), amount: pack.price }],
    });
  } catch (e) {
    console.error('stars invoice', id, e && e.message);
    await d.store.starOrderFail(id, now);
    return json(502, { reason: 'bot' });
  }
  return json(200, { order: id, link, pack: pack.id, stars: pack.stars, price: pack.price });
}
// GET /v1/stars/order?id= → the player's own order and the stars balance (the client waits for 'paid' after paying)
async function getOrder(request, d, user) {
  const id = new URL(request.url).searchParams.get('id') || '';
  const o = ORDER_RE.test(id) ? await d.store.starOrderGet(id) : null;
  if (!o || o.uid !== user.id) return json(404, { reason: 'order' });
  return json(200, orderView(o, await d.store.starsBalance(user.id)));
}

// ---- the bot's webhook: payments and two commands. Telegram must get an answer to pre_checkout_query within 10 s.
// pre_checkout_query: the order exists, is 'pending', the payer and the sum are the order's → ok, else ok:false.
// successful_payment: the order → 'paid' and its stars to the player in one transaction, once (a repeat of the same
// payment, a retry by Telegram — nothing more). refunded_payment (also after refundStarPayment): the stars are taken
// back, never below zero — what was already spent stays as refund_short on the order.
export function checkoutCheck(o, q) {
  if (!o) return 'order';
  if (o.status !== 'pending') return 'status';
  if (!q.from || q.from.id !== o.uid) return 'user';
  if (q.currency !== 'XTR' || q.total_amount !== o.price) return 'amount';
  return null;
}
// «Играть» under the greeting: the game itself (web_app); /start <param> (a deep link t.me/<bot>?start=<param>) opens
// the game through its direct link with ?startapp=<param> — a web_app button cannot carry start_param, the direct link
// delivers it exactly like a room invite does
export function playButton(param, lang) {
  const text = BOT_TEXTS.play[L3(lang)];
  return param ? { text, url: GAME.link + '?startapp=' + encodeURIComponent(param) } : { text, web_app: { url: GAME.url } };
}
// a message to the bot in a private chat: /start, /paysupport, /terms, anything else — a hint (nobody reads the chat)
async function botMessage(d, msg) {
  if (!msg.chat || msg.chat.type !== 'private') return 'skip';
  const lang = L3(msg.from && msg.from.language_code), text = msg.text || '';
  const m = /^\/(start|paysupport|terms)(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(text);
  if (m && m[1] === 'start') {
    const param = /^[A-Za-z0-9_-]{1,64}$/.test(m[2] || '') ? m[2] : null;
    await d.bot('sendMessage', { chat_id: msg.chat.id, text: BOT_TEXTS.start[lang], reply_markup: { inline_keyboard: [[playButton(param, lang)]] } });
    return 'start';
  }
  if (m) { await d.bot('sendMessage', { chat_id: msg.chat.id, text: BOT_TEXTS[m[1]][lang] }); return m[1]; }
  await d.bot('sendMessage', { chat_id: msg.chat.id, text: BOT_TEXTS.other[lang], reply_markup: { inline_keyboard: [[playButton(null, lang)]] } });
  return 'other';
}
export async function onBotUpdate(u, d) {
  const now = d.now || Math.floor(Date.now() / 1000);
  const q = u.pre_checkout_query;
  if (q) {
    const o = typeof q.invoice_payload === 'string' && ORDER_RE.test(q.invoice_payload) ? await d.store.starOrderGet(q.invoice_payload) : null;
    const bad = checkoutCheck(o, q);
    if (bad) console.warn('stars checkout refused', JSON.stringify({ order: q.invoice_payload, from: q.from && q.from.id, amount: q.total_amount, bad }));
    await d.bot('answerPreCheckoutQuery', bad ? { pre_checkout_query_id: q.id, ok: false, error_message: BOT_TEXTS.checkoutNo[L3(q.from && q.from.language_code)] }
                                              : { pre_checkout_query_id: q.id, ok: true });
    return { kind: 'checkout', ok: !bad, bad };
  }
  const m = u.message;
  if (!m) return { kind: 'skip' };
  const from = m.from || {};
  if (m.successful_payment) {
    const p = m.successful_payment, id = p.invoice_payload, charge = String(p.telegram_payment_charge_id || '');
    const o = typeof id === 'string' && ORDER_RE.test(id) ? await d.store.starOrderGet(id) : null;
    if (!o || o.uid !== from.id || p.currency !== 'XTR' || p.total_amount !== o.price || !charge) {
      // money came in for an order we cannot match: kept for the developer's page, never lost silently
      console.error('stars payment unmatched', JSON.stringify({ id, from: from.id, amount: p.total_amount, charge }));
      if (charge && from.id) await d.store.starUnmatched({ uid: from.id, name: [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 64), charge, amount: p.total_amount | 0, payload: String(id || '').slice(0, 128), now });
      return { kind: 'paid', r: 'unmatched' };
    }
    const r = await d.store.starPaid({ id, uid: o.uid, stars: o.stars, charge, now });
    console.log('stars paid', JSON.stringify({ id, uid: o.uid, stars: o.stars, price: o.price, r }));
    return { kind: 'paid', r };
  }
  if (m.refunded_payment) {
    const p = m.refunded_payment, charge = String(p.telegram_payment_charge_id || '');
    const r = charge ? await d.store.starRefund({ charge, now }) : { r: 'unknown' };
    (r.short ? console.warn : console.log)('stars refunded', JSON.stringify({ charge, from: from.id, ...r }));
    return { kind: 'refund', ...r };
  }
  return { kind: await botMessage(d, m) };
}
// POST /tg/webhook — returns a Response, or null when the path is not the bot's. 403 without the right secret header;
// 500 lets Telegram retry (a payment that failed to be written is written on the retry, once).
export async function handleBot(request, d) {
  const path = new URL(request.url).pathname;
  if (path !== BOT_PATH) return null;
  if (request.method !== 'POST') return json(405, { reason: 'method' });
  const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!d.secret || !sameBytes(enc.encode(got), enc.encode(d.secret))) return json(403, { reason: 'secret' });
  if (!d.store || !d.bot) return json(503, { reason: 'not configured' });
  let u = null; try { u = await request.json(); } catch (e) {}
  if (!u || typeof u !== 'object') return json(400, { reason: 'body' });
  try { await onBotUpdate(u, d); return json(200, { ok: true }); }
  catch (e) { console.error('bot update', u.update_id, e && e.stack || e); return json(500, { reason: 'server' }); }
}

// One-time bot setup by the owner (POST /tg/setup, header X-Setup-Secret = the webhook secret):
//   ?do=info     — the bot's webhook and commands as they are, and whether something reads it through getUpdates
//   ?do=install  — setWebhook(<this host>/tg/webhook, secret_token) and the commands /paysupport, /terms added to the
//                  bot's own ones; refused (409) when the bot already has another webhook
export async function handleBotSetup(request, d) {
  const url = new URL(request.url);
  if (url.pathname !== '/tg/setup') return null;
  const got = request.headers.get('X-Setup-Secret') || '';
  if (request.method !== 'POST' || !d.secret || !sameBytes(enc.encode(got), enc.encode(d.secret))) return json(403, { reason: 'secret' });
  if (!d.bot) return json(503, { reason: 'not configured' });
  try { return await botSetup(url, d); }
  catch (e) { console.error('bot setup', e && e.message); return json(502, { reason: 'bot', error: String(e && e.message) }); }   // e.g. Unauthorized: BOT_TOKEN revoked
}
async function botSetup(url, d) {
  const target = (d.publicUrl || url.origin) + BOT_PATH;
  const info = await d.bot('getWebhookInfo', {});
  const cmds = await d.bot('getMyCommands', {});
  const pub = { url: info.url || '', pending: info.pending_update_count | 0, lastError: info.last_error_message || null, allowed: info.allowed_updates || null, commands: cmds,
                menuButton: await d.bot('getChatMenuButton', {}) };
  if (url.searchParams.get('do') !== 'install') {
    // no webhook: peek (no offset — nothing is confirmed) at what waits for getUpdates; old updates = nobody reads them
    if (!info.url) { try { const ups = await d.bot('getUpdates', { limit: 3, timeout: 0 }); pub.queued = ups.map((x) => ({ id: x.update_id, date: (x.message && x.message.date) || null })); } catch (e) { pub.queued = String(e.message); } }
    return json(200, { target, ...pub });
  }
  if (info.url && info.url !== target) return json(409, { reason: 'webhook exists', ...pub });
  await d.bot('setWebhook', { url: target, secret_token: d.secret, allowed_updates: ['message', 'pre_checkout_query'], max_connections: 20 });
  // our commands are added to the bot's own ones (never removed): /start first, the rest after the existing
  const merged = (own, lang) => {
    const h = new Set(own.map((c) => c.command)), mk = (c) => ({ command: c.command, description: c.description[lang] });
    const miss = BOT_TEXTS.commands.filter((c) => !h.has(c.command));
    return [...miss.filter((c) => c.command === 'start').map(mk), ...own, ...miss.filter((c) => c.command !== 'start').map(mk)];
  };
  await d.bot('setMyCommands', { commands: merged(cmds, 'en') });
  for (const lang of ['ru', 'id']) {
    const own = await d.bot('getMyCommands', { language_code: lang });
    if (!own.length && (cmds.length || lang !== 'ru')) continue;    // no own list for this language: the default one is shown
    await d.bot('setMyCommands', { language_code: lang, commands: merged(own, lang) });
  }
  // the menu button: kept if it already opens the game, else «Играть» → the game
  const mb = await d.bot('getChatMenuButton', {});
  const mbOk = mb && mb.type === 'web_app' && mb.web_app && typeof mb.web_app.url === 'string' && mb.web_app.url.startsWith(new URL(GAME.url).origin);
  if (!mbOk) await d.bot('setChatMenuButton', { menu_button: { type: 'web_app', text: BOT_TEXTS.play.ru, web_app: { url: GAME.url } } });
  return json(200, { installed: target, before: pub, info: await d.bot('getWebhookInfo', {}), commands: await d.bot('getMyCommands', {}),
                     menuButton: mbOk ? { kept: mb } : { set: GAME.url, was: mb } });
}

// ---------- the developer's page: read only, ADMIN_IDS only (docs/EVENTS.md «Страница разработчика»)
// Who is a developer: the numeric Telegram user.id from the verified initData, listed in ADMIN_IDS (a Worker secret /
// an environment variable, comma separated) — never the username, never anything the client says. Everyone else —
// unsigned, a forged or a changed initData, any other id — gets 403 on every /v1/admin/* and nothing else.
// Heavy counts (the overview) are made at most once per ADMIN_CACHE seconds per process; lists are paged (50).
export function adminIds(v) {
  return new Set(String(v || '').split(',').map((s) => +s.trim()).filter((n) => Number.isSafeInteger(n) && n > 0));
}
const PAGE = 50;
let OVERVIEW = null;     // { at, data } — the last overview of this process
const PLATFORMS = { ios: 'ios', android: 'android', android_x: 'android', macos: 'pc', tdesktop: 'pc', unigram: 'pc', weba: 'web', webk: 'web', web: 'web' };
export const PLATFORM_RE = /^[a-z_]{1,16}$/;

// the store's raw counts → what the page shows: 30 UTC days ending today, match kinds ai / server / host
export function overviewShape(r, now) {
  const today = Math.floor(now / 86400), d0 = today - 29, z = () => new Array(30).fill(0);
  const newByDay = z(), byDay = { ai: z(), server: z(), host: z() };
  for (const x of r.newByDay) if (x.d >= d0 && x.d <= today) newByDay[x.d - d0] = x.n;
  for (const x of r.matchesByDay) {
    if (x.d < d0 || x.d > today) continue;
    const k = x.mode === 'ai' ? 'ai' : x.net === 'server' ? 'server' : 'host';
    byDay[k][x.d - d0] += x.n;
  }
  const platforms = { ios: 0, android: 0, pc: 0, web: 0, other: 0 };
  for (const x of r.platforms) platforms[PLATFORMS[x.k] || 'other'] += x.n;
  const u = r.users, s = r.stars, k = r.stakes, n0 = (v) => v || 0;
  return {
    at: now, d0,
    players: { total: n0(u.total), new1: n0(u.new1), new7: n0(u.new7), new30: n0(u.new30), act1: n0(u.act1), act7: n0(u.act7), act30: n0(u.act30) },
    newByDay,
    matches: { day: { ai: byDay.ai[29], server: byDay.server[29], host: byDay.host[29] }, byDay,
               n30: n0(r.matchStats.n), avgLen: Math.round(n0(r.matchStats.avg_len)), done: r.matchStats.cnt ? n0(r.matchStats.done) / r.matchStats.cnt : 0 },
    coins: { issued: n0(r.coins.issued), spent: n0(r.coins.spent), circ: n0(r.coins.circ), staked: n0(k.lockedPot) },
    stakes: { n: n0(k.n), pot: n0(k.pot), refunds: n0(k.refunds), refundPot: n0(k.refundPot) },
    stars: { buys: n0(s.buys), sold: n0(s.sold), x1: n0(s.x1), x30: n0(s.x30), xall: n0(s.xall), refunds: n0(s.refunds), refundX: n0(s.refundX), unmatched: n0(s.unmatched) },
    platforms, langs: r.langs.map((x) => [x.k || '', x.n]),
  };
}
async function adminRoute(route, request, d, user, now) {
  const q = new URL(request.url).searchParams, page = Math.max(0, Math.min(10000, parseInt(q.get('page'), 10) || 0));
  switch (route) {
    case 'GET /v1/admin/me': return json(200, { id: user.id, name: user.name, label: 'Разработчик' });
    case 'GET /v1/admin/ui.js':
      if (!d.adminUi) return json(404, { reason: 'ui' });
      return new Response(d.adminUi, { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'private, no-store', ...CORS } });
    case 'GET /v1/admin/overview': {
      if (!OVERVIEW || now - OVERVIEW.at >= d.conf('ADMIN_CACHE')) {
        const t1 = now - (now % 86400);
        const raw = await d.store.adminOverview({ now, today: t1, d7: t1 - 6 * 86400, d30: t1 - 29 * 86400, a1: now - 86400, a7: now - 7 * 86400, a30: now - 30 * 86400 });
        OVERVIEW = { at: now, data: overviewShape(raw, now) };
      }
      return json(200, OVERVIEW.data);
    }
    case 'GET /v1/admin/players': {
      let s = (q.get('q') || '').trim().slice(0, 64); if (s[0] === '@') s = s.slice(1);
      const sort = ['seen', 'matches', 'coins', 'stars', 'bought', 'new'].includes(q.get('sort')) ? q.get('sort') : 'seen';
      const r = await d.store.adminPlayers({ q: s, id: /^\d{1,16}$/.test(s) ? +s : null, sort, page, size: PAGE });
      return json(200, { total: r.total, page, size: PAGE, rows: r.rows });
    }
    case 'GET /v1/admin/player': {
      const id = +q.get('id');
      if (!Number.isSafeInteger(id) || id <= 0) return json(422, { reason: 'id' });
      return json(200, await d.store.adminPlayer(id));
    }
    case 'GET /v1/admin/payments': {
      const st = ['paid', 'pending', 'refunded', 'failed', 'unmatched'].includes(q.get('status')) ? q.get('status') : null;
      const r = await d.store.adminPayments({ status: st, page, size: PAGE });
      return json(200, { total: r.total, page, size: PAGE, rows: r.rows });
    }
  }
  return json(404, { reason: 'route' });
}

async function postMatch(request, d, user, now) {
  const { store, conf } = d;
  let s = null;
  try { const txt = await request.text(); if (txt.length > 32768) return json(413, { reason: 'size' }); s = JSON.parse(txt); } catch (e) {}
  const bad = checkSummary(s, conf('MIN_LEN'));
  if (bad) return json(422, { reason: bad });
  const uid = user.id;
  await stakeSweep(store, uid, now, d.roomResult);
  // a stake on a server match: settled by the room's result, never by this report (outside the daily caps)
  const stake = s.mode === 'online' && s.net === 'server' ? await stakeFor(d, uid, s, now) : null;
  if (await store.matchSeen(uid, s.id)) return json(409, { reason: 'duplicate' });
  const recent = await store.lastMatch(uid);
  if (recent && now - recent.at < conf('MATCH_GAP') * Math.min(recent.len, s.len)) return json(429, { reason: 'gap' });
  if (await store.matchesSince(uid, dayStart(now)) >= conf('MATCHES_DAY')) return json(429, { reason: 'day' });

  // a server-mode match: the room says how it ended
  let duo = false;
  if (s.mode === 'online' && s.net === 'server' && s.result !== 'left' && typeof s.room === 'string' && /^[A-Za-z0-9_-]{2,16}$/.test(s.room)) {
    const checked = await d.roomResult(s.room.toUpperCase(), s.id);
    if (checked) {
      if (checked.len !== s.len || checked.score[0] !== s.score[0] || checked.score[1] !== s.score[1]) return json(422, { reason: 'mismatch' });
      duo = true;
    }
  }
  const reason = duo ? 'match_duo' : 'match_ai';
  const cap = conf(duo ? 'DUO_COIN_CAP_DAY' : 'AI_COIN_CAP_DAY');
  const earned = await store.coinsSince(uid, reason, dayStart(now));
  const parts = rewardParts(s, conf), want = parts.total;
  const coins = Math.max(0, Math.min(want, cap - earned));
  const verdict = s.result === 'left' ? 'left' : (coins < want ? 'capped' : (s.mode === 'online' && !duo ? 'unverified' : 'ok'));
  const my = s.score[s.team], op = s.score[1 - s.team];
  const r = await store.recordMatch({
    uid, name: user.name, id: s.id, mode: s.mode, role: s.role, team: s.team, len: s.len, played: s.played,
    my, op, result: s.result, summary: JSON.stringify(s), coins, verdict, reason, now,
    win: s.result === 'win' ? 1 : 0, draw: s.result === 'draw' ? 1 : 0, online: s.mode === 'online' ? 1 : 0,
  });
  if (r === 'duplicate') return json(409, { reason: 'duplicate' });
  const balance = await store.balance(uid);
  return json(200, { accepted: true, id: s.id, coins, balance, verdict, kind: reason, day: { coins: earned + coins, cap },
                     parts: { res: s.result, base: parts.base, bonus: parts.bonus }, stake });
}

async function getProfile(d, user, now) {
  const { store, conf } = d;
  await stakeSweep(store, user.id, now, d.roomResult);
  const u = await store.profile(user.id);
  const earned = u ? await store.coinsSince(user.id, 'match_ai', dayStart(now)) : 0;
  const earnedDuo = u ? await store.coinsSince(user.id, 'match_duo', dayStart(now)) : 0;
  return json(200, {
    user: { id: user.id, name: user.name },
    coins: u ? u.coins : 0, stars: u ? u.stars : 0,
    totals: u ? { m: u.matches, w: u.wins, d: u.draws, l: u.losses, g: u.goals, ga: u.goals_against, streak: u.streak, best: u.best_streak, online: u.online }
              : { m: 0, w: 0, d: 0, l: 0, g: 0, ga: 0, streak: 0, best: 0, online: 0 },
    inventory: u ? u.inventory : [], equipped: null,
    day: { coins: earned, cap: conf('AI_COIN_CAP_DAY'), duo: earnedDuo, duoCap: conf('DUO_COIN_CAP_DAY') },
    packs: STAR_PACKS,
  });
}

// /v1/* — returns a Response, or null when the path is not the API's
export async function handleCoins(request, d) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/v1/')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const route = request.method + ' ' + path;
  // the developer's page: 403 to everyone but ADMIN_IDS — unsigned, forged and other ids alike, before anything else
  if (path.startsWith('/v1/admin/')) {
    const now = d.now || Math.floor(Date.now() / 1000), conf = d.conf || confFrom(null);
    const c = await checkInitData(request.headers.get('X-Telegram-Init-Data'), d.botToken, now, conf('AUTH_MAX_AGE')), user = c.user;
    if (!user) { if (c.why !== 'none') authLog(path, c); return json(403, { reason: 'forbidden' }); }
    if (!adminIds(d.adminIds).has(user.id)) return json(403, { reason: 'forbidden' });
    if (!d.store) return json(503, { reason: 'not configured' });
    try { return await adminRoute(route, request, { ...d, conf }, user, now); }
    catch (e) { console.error('admin', route, e && e.stack || e); return json(500, { reason: 'server' }); }
  }
  const R = {
    'POST /v1/match': (dd, user, now) => postMatch(request, dd, user, now),
    'GET /v1/profile': (dd, user, now) => getProfile(dd, user, now),
    'GET /v1/stars/packs': () => json(200, { packs: STAR_PACKS }),
    'POST /v1/stars/invoice': (dd, user, now) => postInvoice(request, dd, user, now),
    'GET /v1/stars/order': (dd, user) => getOrder(request, dd, user),
  }[route];
  if (!R) return json(404, { reason: 'route' });
  if (!d.store || !d.botToken) return json(503, { reason: 'not configured' });
  const conf = d.conf || confFrom(null), dd = { ...d, conf };
  const now = d.now || Math.floor(Date.now() / 1000);
  const c = await checkInitData(request.headers.get('X-Telegram-Init-Data'), d.botToken, now, conf('AUTH_MAX_AGE')), user = c.user;
  if (!user) { if (c.why !== 'none') authLog(path, c); return json(401, { reason: 'auth' }); }
  try {
    // who the player is, for the developer's page: name, username, language, premium, the Telegram platform, last seen
    const pf = request.headers.get('X-Tg-Platform');
    if (d.store.touch) await d.store.touch(user, pf && PLATFORM_RE.test(pf) ? pf : null, now);
    return await R(dd, user, now);
  } catch (e) {
    console.error('api', route, e && e.stack || e);
    return json(500, { reason: 'server' });
  }
}
