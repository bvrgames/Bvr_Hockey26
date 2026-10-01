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
 *     now,                    // optional, unix seconds (tests)
 *   }) → Response, or null when the path is not /v1/*
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
 *   profile(uid) → { coins, stars, matches, wins, draws, losses, goals, goals_against, streak, best_streak, online,
 *                    inventory: [item ids] } | null
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
  'access-control-allow-headers': 'Content-Type, X-Telegram-Init-Data',
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
  if (!initData || !botToken || initData.length > 4096) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = await hmac('WebAppData', botToken);
  const want = enc.encode(hex(await hmac(secret, dcs)));
  if (!sameBytes(want, enc.encode(hash))) return null;
  const at = +p.get('auth_date');
  if (!(at > 0) || nowSec - at > maxAge || at - nowSec > 300) return null;
  let u = null; try { u = JSON.parse(p.get('user') || 'null'); } catch (e) {}
  if (!u || !Number.isSafeInteger(u.id) || u.id <= 0) return null;
  const name = ((u.first_name || '') + ' ' + (u.last_name || '')).trim().slice(0, 64) || (u.username || '').slice(0, 64);
  return { id: u.id, name };
}

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
export function matchReward(s, conf = confFrom(null)) {
  const k = Math.max(0.4, Math.min(s.len, 300) / 180);
  let c = Math.round((REWARD[s.result] || 0) * k);
  if (s.result === 'left') return 0;
  let bonus = 0;
  if (Array.isArray(s.players)) for (const p of s.players) if (p && p.t === s.team) bonus += (int(p.g) ? p.g : 0) + (int(p.a) ? p.a : 0);
  c += Math.min(BONUS_MAX, bonus);
  return Math.min(c, Math.round(conf('AI_COIN_CAP_MATCH') * k));
}

export const dayStart = (sec) => sec - (sec % 86400);

async function postMatch(request, d, user, now) {
  const { store, conf } = d;
  let s = null;
  try { const txt = await request.text(); if (txt.length > 32768) return json(413, { reason: 'size' }); s = JSON.parse(txt); } catch (e) {}
  const bad = checkSummary(s, conf('MIN_LEN'));
  if (bad) return json(422, { reason: bad });
  const uid = user.id;
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
  const want = matchReward(s, conf);
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
  return json(200, { accepted: true, id: s.id, coins, balance, verdict, kind: reason, day: { coins: earned + coins, cap } });
}

async function getProfile(d, user, now) {
  const { store, conf } = d;
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
  });
}

// /v1/* — returns a Response, or null when the path is not the API's
export async function handleCoins(request, d) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/v1/')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const route = request.method + ' ' + path;
  if (route !== 'POST /v1/match' && route !== 'GET /v1/profile') return json(404, { reason: 'route' });
  if (!d.store || !d.botToken) return json(503, { reason: 'not configured' });
  const conf = d.conf || confFrom(null), dd = { ...d, conf };
  const now = d.now || Math.floor(Date.now() / 1000);
  const user = await verifyInitData(request.headers.get('X-Telegram-Init-Data'), d.botToken, now, conf('AUTH_MAX_AGE'));
  if (!user) return json(401, { reason: 'auth' });
  try {
    return route === 'POST /v1/match' ? await postMatch(request, dd, user, now) : await getProfile(dd, user, now);
  } catch (e) {
    console.error('api', route, e && e.stack || e);
    return json(500, { reason: 'server' });
  }
}
