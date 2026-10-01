// Screenshots of the developer's page (docs/EVENTS.md «Страница разработчика») on test data: `wrangler dev` with a
// throwaway local D1 filled by SQL (40 players over 30 days, matches of all kinds, stakes, star orders in every status),
// the game in a fake Telegram signed as the admin (ADMIN_IDS), landscape 844×390 at dpr 2: overview (top and bottom),
// players, search, a player's card, payments → shots/dev/*.png. Also a regular player: no item. Exit 1 on a failed check.
// usage: node tools/dev-shots.mjs [--port 8823]
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startWrangler } from './wrangler-dev.mjs';
import { startServer } from './serve.mjs';
import { openGame, fakeTelegram, isError } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const port = +opt('port', 8823);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'TEST_BOT_TOKEN_dev_shots', API = `http://127.0.0.1:${port}`;
const ADMIN = { id: 454163382, first_name: 'Вадим', username: 'Bikmetov_vr', language_code: 'ru' };
const O = { w: 844, h: 390, safe: { left: 47, right: 47, bottom: 21 }, content: { top: 46 } };
const fails = [], ok = (c, m) => { if (!c) fails.push(m); else console.log('ok  ', m); };
function initData(user) {
  const f = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAH' + user.id, user: JSON.stringify(user) };
  const dcs = Object.keys(f).sort().map((k) => k + '=' + f[k]).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  return new URLSearchParams({ ...f, hash: createHmac('sha256', secret).update(dcs).digest('hex') }).toString();
}

// ---- test data: deterministic pseudo-random, times relative to now
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const now = Math.floor(Date.now() / 1000), DAY = 86400;
const q = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const NAMES = ['Алексей Смирнов', 'Мария', 'Дмитрий К', 'Budi Santoso', 'Anna', 'Иван', 'Siti', 'Олег Петров', 'Tom', 'Екатерина', 'Рустам', 'Dewi', 'Сергей',
  'Ольга', 'Max', 'Арсений', 'Putri', 'Никита', 'Laura', 'Тимур'];
const PLATS = ['ios', 'ios', 'android', 'android', 'android', 'tdesktop', 'macos', 'weba', null];
const sql = [], users = [];
for (let i = 0; i < 40; i++) {
  const id = 500000000 + i * 7919, created = now - Math.floor(Math.pow(rnd(), 1.6) * 29.5 * DAY), seen = Math.min(now, created + Math.floor(rnd() * (now - created)));
  const lang = pick(['ru', 'ru', 'ru', 'en', 'id', 'id', 'uk']);
  const u = { id, name: NAMES[i % NAMES.length] + (i >= NAMES.length ? ' ' + (i - NAMES.length + 2) : ''), username: rnd() < 0.7 ? 'user' + (i * 37 % 1000) : null, lang,
    premium: rnd() < 0.15 ? 1 : 0, platform: pick(PLATS), created, seen, m: 0, w: 0, d: 0, l: 0, g: 0, ga: 0, coins: 0, stars: 0 };
  users.push(u);
}
let mid = 0;
const ledger = [];
for (const u of users) {
  const n = Math.floor(rnd() * 14);
  for (let k = 0; k < n; k++) {
    const at = u.created + Math.floor(rnd() * (now - u.created)), duo = rnd() < 0.25, net = duo ? (rnd() < 0.8 ? 'server' : 'host') : null;
    const my = Math.floor(rnd() * 5), op = Math.floor(rnd() * 5), left = duo && rnd() < 0.08;
    const result = left ? 'left' : my > op ? 'win' : my < op ? 'loss' : 'draw', len = pick([60, 180, 180, 180, 300]);
    const reward = left ? 0 : Math.round(({ win: 10, draw: 5, loss: 3 })[result] * Math.max(0.4, len / 180)) + Math.min(5, my);
    const id = (++mid).toString(16).padStart(24, 'a');
    const summary = JSON.stringify({ v: 1, id, mode: duo ? 'online' : 'ai', net, len, score: [my, op] });
    sql.push(`INSERT INTO matches (user_id, match_id, mode, role, team, len, played, score_my, score_op, result, summary, reward, verdict, created_at) VALUES (${u.id}, ${q(id)}, ${q(duo ? 'online' : 'ai')}, ${q(duo ? 'host' : 'solo')}, 0, ${len}, ${len}, ${my}, ${op}, ${q(result)}, ${q(summary)}, ${reward}, ${q(left ? 'left' : duo && net === 'host' ? 'unverified' : 'ok')}, ${at});`);
    u.m++; if (result === 'win') u.w++; else if (result === 'draw') u.d++; else u.l++; u.g += my; u.ga += op; u.coins += reward;
    if (reward) ledger.push([u.id, reward, 'coins', duo && net === 'server' ? 'match_duo' : 'match_ai', id, u.coins, at]);
  }
}
// stakes between players with coins
const rich = users.filter((u) => u.coins >= 30);
for (let k = 0; k < Math.min(6, Math.floor(rich.length / 2)); k++) {
  const h = rich[2 * k], g = rich[2 * k + 1], amount = pick([10, 10, 25]), id = 'feed' + String(k).padStart(20, '0'), at = Math.max(h.created, g.created) + DAY / 3;
  const outcome = pick(['host', 'guest', 'draw', 'refund']), status = k === 0 ? 'locked' : 'settled';
  sql.push(`INSERT INTO stakes (match_id, room, amount, host_uid, guest_uid, len, status, outcome, created_at, deadline, settled_at) VALUES (${q(id)}, 'DEMO${k}', ${amount}, ${h.id}, ${g.id}, 180, ${q(status)}, ${status === 'locked' ? 'NULL' : q(outcome)}, ${at}, ${at + 1260}, ${status === 'locked' ? 'NULL' : at + 200});`);
  for (const [u, side] of [[h, 'host'], [g, 'guest']]) {
    u.coins -= amount; ledger.push([u.id, -amount, 'coins', 'stake', id, u.coins, at]);
    if (status !== 'settled') continue;
    const back = outcome === side ? 2 * amount : outcome === 'draw' || outcome === 'refund' ? amount : 0;
    if (back) { u.coins += back; ledger.push([u.id, back, 'coins', back === amount ? 'stake_back' : 'stake_win', id, u.coins, at + 200]); }
  }
}
// star orders in every status
const PACKS = [['s50', 50, 50], ['s120', 120, 100], ['s300', 300, 250]];
const orders = [['paid', 0], ['paid', 1], ['paid', 3], ['paid', 5], ['paid', 8], ['refunded', 1], ['pending', 2], ['failed', 4], ['paid', 11], ['unmatched', 6], ['paid', 13], ['pending', 0]];
orders.forEach(([status, ui], k) => {
  const u = users[ui], [pack, stars, price] = status === 'unmatched' ? ['?', 0, 50] : PACKS[k % 3];
  const at = now - Math.floor(rnd() * (k < 3 ? 0.4 : 20) * DAY), id = status === 'unmatched' ? 'u_stxDEMO' + k : (k + 1).toString(16).padStart(24, 'c');
  const charge = ['paid', 'refunded', 'unmatched'].includes(status) ? 'stxDEMO' + (k * 7919).toString(36).toUpperCase() + 'QpZ3vXk' : null;
  let short = 0;
  if (status === 'paid' || status === 'refunded') { u.stars += stars; ledger.push([u.id, stars, 'stars', 'stars_buy', id, u.stars, at + 30]); }
  if (status === 'refunded') { const take = Math.min(u.stars, stars); short = stars - take + 40; u.stars -= take - 40; ledger.push([u.id, -(take - 40), 'stars', 'stars_refund', id, u.stars, at + 3600]); }
  sql.push(`INSERT INTO star_orders (id, user_id, pack, stars, price, status, charge_id, created_at, paid_at, refunded_at, refund_short) VALUES (${q(id)}, ${u.id}, ${q(pack)}, ${stars}, ${price}, ${q(status)}, ${q(charge)}, ${at}, ${['paid', 'refunded', 'unmatched'].includes(status) ? at + 30 : 'NULL'}, ${status === 'refunded' ? at + 3600 : 'NULL'}, ${short});`);
});
const head = users.map((u) => `INSERT INTO users (user_id, name, username, language_code, is_premium, platform, coins, stars, matches, wins, draws, losses, goals, goals_against, created_at, updated_at, last_seen) VALUES (${u.id}, ${q(u.name)}, ${q(u.username)}, ${q(u.lang)}, ${u.premium}, ${q(u.platform)}, ${Math.max(0, u.coins)}, ${Math.max(0, u.stars)}, ${u.m}, ${u.w}, ${u.d}, ${u.l}, ${u.g}, ${u.ga}, ${u.created}, ${u.seen}, ${u.seen});`);
const led = ledger.map((l) => `INSERT OR IGNORE INTO ledger (user_id, delta, currency, reason, ref, balance_after, created_at) VALUES (${l[0]}, ${l[1]}, ${q(l[2])}, ${q(l[3])}, ${q(l[4])}, ${Math.max(0, l[5])}, ${l[6]});`);

mkdirSync('shots/dev', { recursive: true });
const persist = mkdtempSync(join(tmpdir(), 'bvr-dev-'));
const seedFile = join(persist, 'seed.sql');
writeFileSync(seedFile, [...head, ...sql, ...led].join('\n'));
const wr = (a) => execFileSync(join(ROOT, 'node_modules', '.bin', 'wrangler'), a, { cwd: join(ROOT, 'server'), stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
let w = null, srv = null;
const shot = async (page, name) => { await page.waitForTimeout(350); await page.screenshot({ path: `shots/dev/${name}.png` }); };
const sec = (page) => page.evaluate(() => document.querySelector('#start section.cur').textContent);
try {
  wr(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist]);
  wr(['d1', 'execute', 'DB', '--local', '--persist-to', persist, '--file', seedFile]);
  w = await startWrangler(port, { args: ['--persist-to', persist, '--var', `BOT_TOKEN:${TOKEN}`, '--var', `ADMIN_IDS:${ADMIN.id}`] });
  srv = await startServer(port + 1);
  const open = async (user, platform) => {
    const tg = fakeTelegram({ fullscreen: true, safe: O.safe, content: O.content, lang: 'ru', platform }).replace(/initData:'[^']*'/, 'initData:' + JSON.stringify(initData(user)))
      .replace(/initDataUnsafe:\{user:\{[^}]*\}\}/, 'initDataUnsafe:{user:' + JSON.stringify(user) + '}');
    const g = await openGame('chromium', { w: O.w, h: O.h, mobile: true, dpr: 2, tg });
    await g.page.addInitScript(() => { try { localStorage.setItem('bvr_lang', 'ru'); localStorage.setItem('bvr_onboard', '1'); } catch (e) {} });
    await g.page.goto(`http://127.0.0.1:${port + 1}/index.html?nomusic&api=${encodeURIComponent(API)}`, { waitUntil: 'load' });
    await g.page.waitForFunction('window.__hk && __hk.menuState && __hk.menuState().layer==="menu"', null, { timeout: 60000 });
    await g.page.evaluate('document.fonts.ready');
    return g;
  };
  // a regular player: no item
  {
    const g = await open({ id: users[3].id, first_name: 'Budi', language_code: 'id' }, 'android');
    await g.page.waitForTimeout(2500);
    const e = await g.page.evaluate(() => __hk.ext());
    ok(!e.ok && e.item === 0, `a regular player has no developer item ${JSON.stringify(e)}`);
    await shot(g.page, 'player-main');
    await g.browser.close();
  }
  const g = await open(ADMIN, 'ios');
  const { page } = g;
  try {
    await page.waitForFunction(() => __hk.ext().item === 1, null, { timeout: 20000 });
    await page.evaluate(() => __hk.menu('main'));
    await shot(page, 'admin-main');
    await page.click('#start section.cur [data-act="ext"]');
    await page.waitForFunction(() => /всего/.test(document.querySelector('#start section.cur').textContent), null, { timeout: 15000 });
    ok(/Игроки/.test(await sec(page)), 'overview shown');
    await shot(page, 'overview-1');
    await page.evaluate(() => { const x = document.querySelector('#start section.cur .xd'); x.scrollTop = x.scrollHeight / 2 - 60; });
    await page.click('#start section.cur rect[data-tipfor="mt"]:nth-last-of-type(3)').catch(() => {});
    await shot(page, 'overview-2');
    await page.evaluate(() => { const x = document.querySelector('#start section.cur .xd'); x.scrollTop = x.scrollHeight; });
    await shot(page, 'overview-3');
    await page.click('#start section.cur .mtab[data-tab="1"]');
    await page.waitForFunction(() => document.querySelectorAll('#start section.cur .xd-r.mf').length > 5, null, { timeout: 10000 });
    await shot(page, 'players');
    await page.click('#start section.cur .xd-c[data-v="coins"]');
    await page.waitForFunction(() => document.querySelector('#start section.cur .xd-c.cur[data-v="coins"]') && document.querySelectorAll('#start section.cur .xd-r.mf').length > 5, null, { timeout: 10000 });
    await shot(page, 'players-coins');
    await page.fill('#xq', 'Олег');
    await page.waitForFunction(() => document.querySelectorAll('#start section.cur .xd-r.mf').length <= 3, null, { timeout: 10000 });
    await shot(page, 'players-search');
    await page.fill('#xq', '');
    await page.waitForFunction(() => document.querySelectorAll('#start section.cur .xd-r.mf').length > 5, null, { timeout: 10000 });
    await page.click('#start section.cur .xd-c[data-v="bought"]');
    await page.waitForFunction(() => document.querySelector('#start section.cur .xd-c.cur[data-v="bought"]') && document.querySelectorAll('#start section.cur .xd-r.mf').length > 5, null, { timeout: 10000 });
    await page.click('#start section.cur .xd-r.mf');
    await page.waitForFunction(() => /Последние матчи/i.test(document.querySelector('#start section.cur').textContent), null, { timeout: 10000 });
    ok(/Покупки звёзд/.test(await sec(page)) && /Журнал/.test(await sec(page)), 'player card shown');
    await shot(page, 'card-1');
    await page.evaluate(() => { const x = document.querySelector('#start section.cur .xd'); x.scrollTop = x.scrollHeight / 2; });
    await shot(page, 'card-2');
    await page.evaluate(() => { const x = document.querySelector('#start section.cur .xd'); x.scrollTop = x.scrollHeight; });
    await shot(page, 'card-3');
    await page.evaluate(() => __tgBackClick());
    await page.waitForTimeout(300);
    await page.click('#start section.cur .mtab[data-tab="2"]');
    await page.waitForFunction(() => /charge id/i.test(document.querySelector('#start section.cur').textContent) && document.querySelectorAll('#start section.cur .xd-r.mf').length > 3, null, { timeout: 10000 });
    ok(/не опознан/.test(await sec(page)) && /stxDEMO/.test(await sec(page)), 'payments with charge ids and statuses');
    await shot(page, 'payments');
    const errs = g.logs.filter(isError);
    ok(!errs.length, `no page errors ${JSON.stringify(errs).slice(0, 300)}`);
  } finally { await g.browser.close(); }
} catch (e) {
  fails.push('exception: ' + (e && e.stack || e));
  if (w) console.log(w.log().slice(-2500));
} finally {
  if (w) w.close(); if (srv) srv.close();
  try { rmSync(persist, { recursive: true, force: true }); } catch (e) {}
}
console.log(`dev-shots: ${fails.length ? 'FAIL' : 'OK'} → shots/dev/`);
for (const f of fails) console.log('  ✗ ' + f);
process.exit(fails.length ? 1 : 0);
