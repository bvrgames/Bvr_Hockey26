// Coins and stats API test (server/api.js) on `wrangler dev` with a throwaway local D1 and a test bot token.
// Checks: the initData signature (missing, forged, stale, a changed field → 401), an empty profile, a win against the
// AI gives coins and moves the profile, the same match again → 409, the next one too soon → 429, implausible
// summaries → 422, 'left' gives no coins, the daily cap ends in verdict 'capped', CORS preflight.
// usage: node tools/smoke-api.mjs [--port 8799] [--verbose]
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startWrangler } from './wrangler-dev.mjs';

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
  w = await startWrangler(port, { args: ['--persist-to', persist, '--var', `BOT_TOKEN:${TOKEN}`, '--var', 'MATCH_GAP:0'] });
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
