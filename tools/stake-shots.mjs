// The stake on a match with a friend, end to end in two browsers (docs/EVENTS.md «Ставка на матч»): `wrangler dev`
// (Worker + Durable Object + a throwaway local D1, a test bot token), two players in a fake Telegram with signed
// initData earn coins, open one room by link (server mode), the host picks a stake on the match screen, the guest sees
// it and accepts, the match starts with the stake locked from both. Screenshots: shots/stake/*.png; exit 1 on a failed
// check. Also the result screen with a won / lost stake (the server's answer played on it).
// usage: node tools/stake-shots.mjs [--lang ru|en|id] [--port 8811] [--w 844 --h 390]
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startWrangler } from './wrangler-dev.mjs';
import { startServer } from './serve.mjs';
import { openGame, fakeTelegram, isError } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const port = +opt('port', 8811), LANG = opt('lang', 'ru'), W = +opt('w', 844), Hh = +opt('h', 390);   // --w 667 --h 375: iPhone SE
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'TEST_BOT_TOKEN_stake_shots', API = `http://127.0.0.1:${port}`;
const fails = [], ok = (c, m) => { if (!c) fails.push(m); else console.log('ok  ', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function initData(user) {
  const f = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAH' + user.id, user: JSON.stringify(user) };
  const dcs = Object.keys(f).sort().map((k) => k + '=' + f[k]).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  return new URLSearchParams({ ...f, hash: createHmac('sha256', secret).update(dcs).digest('hex') }).toString();
}
let n = 0;
function win() {
  const now = Date.now(), t = (g) => ({ shots: g + 6, sog: g + 3, goals: g, passes: 30, passesDone: 22, saves: 4, hits: 3 });
  return { v: 1, id: (now.toString(16) + (++n).toString(16).padStart(4, '0') + 'abcdef0123').slice(0, 24), client: 1, mode: 'ai', role: 'solo', net: null, team: 0,
    difficulty: 'normal', clubs: [0, 3], len: 180, played: 184, startedAt: now - 200000, endedAt: now, score: [3, 1], result: 'win', disconnect: null,
    teams: [t(3), t(1)], players: [{ t: 0, num: 9, g: 3, a: 2, s: 5, h: 1 }], faceoffs: 6, events: 120, test: false };
}

mkdirSync('shots/stake', { recursive: true });
const persist = mkdtempSync(join(tmpdir(), 'bvr-stake-'));
let w = null, srv = null; const pages = [];
try {
  execFileSync(join(ROOT, 'node_modules', '.bin', 'wrangler'), ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist],
    { cwd: join(ROOT, 'server'), stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
  w = await startWrangler(port, { args: ['--persist-to', persist, '--var', `BOT_TOKEN:${TOKEN}`, '--var', 'MATCH_GAP:0'] });
  srv = await startServer(port + 1);
  const U = [{ id: 500100 + Math.floor(Math.random() * 1000), first_name: 'Host' }, { id: 600100 + Math.floor(Math.random() * 1000), first_name: 'Guest' }];
  for (const u of U) for (let i = 0; i < 2; i++) {
    await fetch(API + '/v1/match', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData(u) }, body: JSON.stringify(win()) });
  }
  const room = 'BET' + Math.floor(Math.random() * 1e4);
  const url = `http://127.0.0.1:${port + 1}/index.html?nomusic&room=${room}&srv=${encodeURIComponent(API)}&api=${encodeURIComponent(API)}`;
  for (const [i, u] of U.entries()) {
    const tg = fakeTelegram({ fullscreen: true, safe: { left: 47, right: 47, bottom: 21 }, content: { top: 46 }, lang: LANG })
      .replace(/initData:'[^']*'/, 'initData:' + JSON.stringify(initData(u)));
    const g = await openGame('chromium', { w: W, h: Hh, mobile: true, dpr: 2, tg });
    await g.page.addInitScript(`try{ localStorage.setItem('bvr_lang','${LANG}'); localStorage.setItem('bvr_onboard','1'); }catch(e){}`);
    await g.page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await g.page.waitForFunction(`window.__hk && __hk.net().role==="${i ? 'guest' : 'host'}"`, null, { timeout: 30000 });
    pages.push(g);
    await sleep(500);
  }
  const [H, G] = pages.map((g) => g.page);
  const stk = (p) => p.evaluate(() => ({ top: __hk.menuState().stack.slice(-1)[0], row: (document.querySelector('[data-adj="stake"]') || {}).textContent || null,
    go: (document.getElementById('go') || {}).textContent, dis: !!(document.getElementById('go') || {}).disabled, coins: __hk.coins().coins }));
  // the stake is on the second screen (match settings): both press Next on the team select
  await H.waitForFunction(() => __hk.menuState().stack.slice(-1)[0] === 'prep', null, { timeout: 15000 }).catch(() => {});
  for (const P of [H, G]) await P.evaluate(() => { var b = document.querySelector('#start .mscr.cur [data-act="next"]'); if (b) b.click(); });
  await H.waitForFunction(() => __hk.menuState().stack.slice(-1)[0] === 'setup' && document.querySelector('[data-adj="stake"]'), null, { timeout: 15000 }).catch(() => {});
  await G.waitForFunction(() => document.querySelector('[data-adj="stake"]'), null, { timeout: 15000 }).catch(() => {});
  let h = await stk(H), gs = await stk(G);
  ok(h.row && gs.row && h.coins === 30, `the stake row on both match screens (signed in over the socket) ${JSON.stringify([h, gs])}`);
  await H.screenshot({ path: 'shots/stake/1-host-none.png' });
  // the host: › → 10, › → 25
  await H.evaluate(() => document.querySelector('[data-adj="stake"] [data-dir="1"]').click()); await sleep(500);
  await H.evaluate(() => document.querySelector('[data-adj="stake"] [data-dir="1"]').click()); await sleep(700);
  h = await stk(H); gs = await stk(G);
  ok(/25/.test(h.row) && /25/.test(gs.row) && h.dis && !gs.dis, `host offers 25: the guest sees it and may accept, the host waits ${JSON.stringify([h, gs])}`);
  await H.screenshot({ path: 'shots/stake/2-host-offer.png' }); await G.screenshot({ path: 'shots/stake/3-guest-accept.png' });
  // a third › would be 50 > 30 coins: skipped, wraps to 0
  await G.evaluate(() => document.getElementById('go').click()); await sleep(700);
  h = await stk(H); gs = await stk(G);
  ok(!h.dis && gs.dis, `the guest accepted: the host may start ${JSON.stringify([h, gs])}`);
  await H.screenshot({ path: 'shots/stake/4-host-ready.png' }); await G.screenshot({ path: 'shots/stake/5-guest-accepted.png' });
  await H.evaluate(() => document.getElementById('go').click());
  await H.waitForFunction(() => __hk.st() === 'face' || __hk.st() === 'play', null, { timeout: 20000 }).catch(() => {});
  const m = await H.evaluate(() => ({ st: __hk.st(), stake: __hk.match().stake }));
  ok(m.stake === 25, `the match started with the stake locked ${JSON.stringify(m)}`);
  const prof = await (await fetch(API + '/v1/profile', { headers: { 'X-Telegram-Init-Data': initData(U[1]) } })).json();
  ok(prof.coins === 5, `25 locked from the guest (30 → 5): ${prof.coins}`);
  // the result screen with the stake as the server answers it (a won stake for the host, a lost one for the guest)
  await H.evaluate(() => { __hk.result('ab12cd34ef'); __hk.ev.emit('match:reward', { id: 'ab12cd34ef', coins: 8, balance: 63, verdict: 'ok',
    parts: { res: 'win', base: 6, bonus: 2 }, stake: { n: 25, out: 'win', delta: 50 } }); });
  await G.evaluate(() => { __hk.result('ab12cd34ef'); __hk.ev.emit('match:reward', { id: 'ab12cd34ef', coins: 2, balance: 7, verdict: 'ok',
    parts: { res: 'loss', base: 2, bonus: 0 }, stake: { n: 25, out: 'loss', delta: 0 } }); });
  await sleep(1300); await H.screenshot({ path: 'shots/stake/6-result-won-flight.png' });
  await sleep(1800); await H.screenshot({ path: 'shots/stake/7-result-won.png' }); await G.screenshot({ path: 'shots/stake/8-result-lost.png' });
  const rh = await H.evaluate(() => __hk.rw()), rg = await G.evaluate(() => __hk.rw());
  ok(/\+50/.test(rh.text) && /\+58$/.test(rh.text) && rh.wal === '63', `host result: stake +50, total +58 ${JSON.stringify(rh)}`);
  ok(/−25/.test(rg.text) && /\+2$/.test(rg.text) && rg.wal === '7', `guest result: stake −25, total +2 ${JSON.stringify(rg)}`);
  for (const g of pages) for (const e of g.logs.filter(isError)) fails.push(`[${e.type}] ${e.text}`);
} catch (e) {
  fails.push('exception: ' + (e && e.stack || e));
} finally {
  for (const g of pages) await g.browser.close().catch(() => {});
  if (srv) srv.close(); if (w) w.close();
  try { rmSync(persist, { recursive: true, force: true }); } catch (e) {}
}
console.log(fails.length ? 'STAKE FAIL\n  ' + fails.join('\n  ') : 'STAKE OK — shots/stake/*.png');
process.exit(fails.length ? 1 : 0);
