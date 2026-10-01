/**
 * BVR Hockey — coins and player stats API on Cloudflare (Worker + D1), docs/EVENTS.md «Итог матча и бэкенд».
 *
 *   POST /v1/match    body: match:summary  → 200 { accepted, coins, balance, verdict, day: { coins, cap },
 *                                                  parts: { res, base, bonus } — what the coins are for (result screen) }
 *                     401 bad signature · 409 this match id is already in · 422 { reason } implausible ·
 *                     429 { reason } too often (the client keeps the match in its queue and tries again later)
 *   GET  /v1/profile  → { user: { id, name }, coins, stars, totals: { m, w, d, l, g, ga, streak, best, online },
 *                         inventory: [], equipped: null, day: { coins, cap } }
 *
 * This file is only the Cloudflare glue; the rules (initData check, plausibility, reward, caps, limits) are in
 * server/coins.js, which knows nothing about Cloudflare, and the SQL is in server/coins-d1.js. Moving the API
 * elsewhere (a VPS in Moscow: Node.js + SQLite or Postgres) means a new glue file and, for Postgres, a new store —
 * docs/EVENTS.md «Перенос API».
 *
 * Here: the secret BOT_TOKEN, the D1 binding DB, numeric Worker vars overriding the limits (coins.js DEF), and where a
 * server-mode match's own result comes from — the room's Durable Object (worker.js, saveResult): the client's score has
 * to match it (otherwise 422 'mismatch'); such matches pay from their own daily cap (ledger reason 'match_duo'). Matches
 * the server did not count (host mode, an unknown room) are paid like a match against the AI, from the AI cap.
 */
import { handleCoins, confFrom } from './coins.js';
import { d1Store } from './coins-d1.js';

export { verifyInitData, checkSummary, matchReward } from './coins.js';

// the server match's final result kept by the room (worker.js, saveResult), or null
function roomResultFrom(env) {
  return async (room, id) => {
    if (!env.ROOMS) return null;
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
    const r = await stub.fetch('https://room/result?id=' + encodeURIComponent(id), { headers: { 'X-Internal': 'result' } });
    return r.ok ? r.json() : null;
  };
}

// /v1/* — returns a Response, or null when the path is not the API's
export function handleApi(request, env) {
  return handleCoins(request, {
    botToken: env.BOT_TOKEN,
    conf: confFrom(env),
    store: env.DB ? d1Store(env.DB) : null,
    roomResult: roomResultFrom(env),
  });
}
