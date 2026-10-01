/**
 * BVR Hockey — coins and player stats API (Worker + D1), docs/EVENTS.md «Итог матча и бэкенд».
 *
 *   POST /v1/match    body: match:summary  → 200 { accepted, coins, balance, verdict, day: { coins, cap } }
 *                     401 bad signature · 409 this match id is already in · 422 { reason } implausible ·
 *                     429 { reason } too often (the client keeps the match in its queue and tries again later)
 *   GET  /v1/profile  → { user: { id, name }, coins, stars, totals: { m, w, d, l, g, ga, streak, best, online },
 *                         inventory: [], equipped: null, day: { coins, cap } }
 *
 * Matches against a person in server mode (net: 'server', room: code) are checked against the room's own result:
 * the Durable Object counted the match and keeps its final score (worker.js, saveResult), so the client's score has to
 * match it (otherwise 422 'mismatch'); such matches pay from their own daily cap (ledger reason 'match_duo'). Matches
 * the server did not count (host mode, an unknown room) are paid like a match against the AI, from the AI cap.
 *
 * Every request carries the header X-Telegram-Init-Data (Telegram.WebApp.initData). The Worker checks its HMAC with
 * the bot token (secret BOT_TOKEN) and takes the player only from there: user.id is the account, the body says
 * nothing about who sent it. The client never adds coins: it says how the match went, the reward is decided here.
 */

const DEF = {
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

function conf(env, k) { const v = env && env[k]; return v !== undefined && v !== '' && isFinite(+v) ? +v : DEF[k]; }

const CORS = {
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
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0;
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
export function matchReward(s, env) {
  const k = Math.max(0.4, Math.min(s.len, 300) / 180);
  let c = Math.round((REWARD[s.result] || 0) * k);
  if (s.result === 'left') return 0;
  let bonus = 0;
  if (Array.isArray(s.players)) for (const p of s.players) if (p && p.t === s.team) bonus += (int(p.g) ? p.g : 0) + (int(p.a) ? p.a : 0);
  c += Math.min(BONUS_MAX, bonus);
  return Math.min(c, Math.round(conf(env, 'AI_COIN_CAP_MATCH') * k));
}

const dayStart = (sec) => sec - (sec % 86400);

async function dayCoins(db, uid, now, reason = 'match_ai') {
  const r = await db.prepare('SELECT COALESCE(SUM(delta), 0) AS c FROM ledger WHERE user_id = ? AND reason = ? AND created_at >= ?')
    .bind(uid, reason, dayStart(now)).first();
  return r ? r.c : 0;
}

// the server match's final result kept by the room (worker.js), or null
async function roomResult(env, room, id) {
  if (!env.ROOMS || typeof room !== 'string' || !/^[A-Za-z0-9_-]{2,16}$/.test(room)) return null;
  const stub = env.ROOMS.get(env.ROOMS.idFromName(room.toUpperCase()));
  const r = await stub.fetch('https://room/result?id=' + encodeURIComponent(id), { headers: { 'X-Internal': 'result' } });
  return r.ok ? r.json() : null;
}

async function postMatch(request, env, user, now) {
  let s = null;
  try { const txt = await request.text(); if (txt.length > 32768) return json(413, { reason: 'size' }); s = JSON.parse(txt); } catch (e) {}
  const bad = checkSummary(s, conf(env, 'MIN_LEN'));
  if (bad) return json(422, { reason: bad });
  const db = env.DB, uid = user.id;
  if (await db.prepare('SELECT 1 FROM matches WHERE user_id = ? AND match_id = ?').bind(uid, s.id).first()) {
    return json(409, { reason: 'duplicate' });
  }
  const recent = await db.prepare('SELECT created_at, len FROM matches WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').bind(uid).first();
  if (recent && now - recent.created_at < conf(env, 'MATCH_GAP') * Math.min(recent.len, s.len)) return json(429, { reason: 'gap' });
  const today = await db.prepare('SELECT COUNT(*) AS n FROM matches WHERE user_id = ? AND created_at >= ?').bind(uid, dayStart(now)).first();
  if (today && today.n >= conf(env, 'MATCHES_DAY')) return json(429, { reason: 'day' });

  // a server-mode match: the room says how it ended
  let duo = false, checked = null;
  if (s.mode === 'online' && s.net === 'server' && s.result !== 'left') {
    checked = await roomResult(env, s.room, s.id);
    if (checked) {
      if (checked.len !== s.len || checked.score[0] !== s.score[0] || checked.score[1] !== s.score[1]) return json(422, { reason: 'mismatch' });
      duo = true;
    }
  }
  const reason = duo ? 'match_duo' : 'match_ai';
  const cap = conf(env, duo ? 'DUO_COIN_CAP_DAY' : 'AI_COIN_CAP_DAY');
  const earned = await dayCoins(db, uid, now, reason);
  const want = matchReward(s, env);
  const coins = Math.max(0, Math.min(want, cap - earned));
  const verdict = s.result === 'left' ? 'left' : (coins < want ? 'capped' : (s.mode === 'online' && !duo ? 'unverified' : 'ok'));
  const my = s.score[s.team], op = s.score[1 - s.team];
  const win = s.result === 'win' ? 1 : 0, draw = s.result === 'draw' ? 1 : 0;

  const q = [
    db.prepare('INSERT OR IGNORE INTO users (user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(uid, user.name, now, now),
    db.prepare(`INSERT INTO matches (user_id, match_id, mode, role, team, len, played, score_my, score_op, result, summary, reward, verdict, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(uid, s.id, s.mode, s.role, s.team, s.len, s.played, my, op, s.result, JSON.stringify(s), coins, verdict, now),
    db.prepare(`UPDATE users SET name = ?, coins = coins + ?, matches = matches + 1, wins = wins + ?, draws = draws + ?, losses = losses + ?,
                  goals = goals + ?, goals_against = goals_against + ?,
                  streak = CASE WHEN ? THEN streak + 1 ELSE 0 END,
                  best_streak = MAX(best_streak, CASE WHEN ? THEN streak + 1 ELSE 0 END),
                  online = online + ?, updated_at = ? WHERE user_id = ?`)
      .bind(user.name, coins, win, draw, 1 - win - draw, my, op, win, win, s.mode === 'online' ? 1 : 0, now, uid),
  ];
  if (coins > 0) {
    q.push(db.prepare(`INSERT INTO ledger (user_id, delta, reason, ref, balance_after, created_at)
                       VALUES (?, ?, ?, ?, (SELECT coins FROM users WHERE user_id = ?), ?)`).bind(uid, coins, reason, s.id, uid, now));
  }
  try { await db.batch(q); }
  catch (e) {
    // two copies of one request at once: the primary key lets only one through
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(e && e.message))) return json(409, { reason: 'duplicate' });
    throw e;
  }
  const u = await db.prepare('SELECT coins FROM users WHERE user_id = ?').bind(uid).first();
  return json(200, { accepted: true, id: s.id, coins, balance: u ? u.coins : coins, verdict, kind: reason, day: { coins: earned + coins, cap } });
}

async function getProfile(env, user, now) {
  const db = env.DB;
  const u = await db.prepare('SELECT * FROM users WHERE user_id = ?').bind(user.id).first();
  const inv = u ? (await db.prepare('SELECT item_id FROM inventory WHERE user_id = ? ORDER BY acquired_at').bind(user.id).all()).results : [];
  const earned = u ? await dayCoins(db, user.id, now) : 0, earnedDuo = u ? await dayCoins(db, user.id, now, 'match_duo') : 0;
  return json(200, {
    user: { id: user.id, name: user.name },
    coins: u ? u.coins : 0, stars: u ? u.stars : 0,
    totals: u ? { m: u.matches, w: u.wins, d: u.draws, l: u.losses, g: u.goals, ga: u.goals_against, streak: u.streak, best: u.best_streak, online: u.online }
              : { m: 0, w: 0, d: 0, l: 0, g: 0, ga: 0, streak: 0, best: 0, online: 0 },
    inventory: inv.map((r) => r.item_id), equipped: null,
    day: { coins: earned, cap: conf(env, 'AI_COIN_CAP_DAY'), duo: earnedDuo, duoCap: conf(env, 'DUO_COIN_CAP_DAY') },
  });
}

// /v1/* — returns a Response, or null when the path is not the API's
export async function handleApi(request, env) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/v1/')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const route = request.method + ' ' + path;
  if (route !== 'POST /v1/match' && route !== 'GET /v1/profile') return json(404, { reason: 'route' });
  if (!env.DB || !env.BOT_TOKEN) return json(503, { reason: 'not configured' });
  const now = Math.floor(Date.now() / 1000);
  const user = await verifyInitData(request.headers.get('X-Telegram-Init-Data'), env.BOT_TOKEN, now, conf(env, 'AUTH_MAX_AGE'));
  if (!user) return json(401, { reason: 'auth' });
  try {
    return route === 'POST /v1/match' ? await postMatch(request, env, user, now) : await getProfile(env, user, now);
  } catch (e) {
    console.error('api', route, e && e.stack || e);
    return json(500, { reason: 'server' });
  }
}
