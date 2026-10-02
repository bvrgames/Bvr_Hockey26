// Screenshots of the star top-up (docs/EVENTS.md «Звёзды»): `wrangler dev` (Worker + a throwaway local D1, a test bot
// token, the Bot API faked by a local server), the game in a fake Telegram with signed initData, landscape 844×390 at
// dpr 2, RU / EN / ID: the wallet with «+» on the main menu and the profile, the packs screen, waiting for the payment
// and the stars credited (the payment is posted to the bot's webhook as Telegram would); the shop: coins for stars —
// packs, the question, bought, not enough stars. shots/stars/<screen>-<lang>.png;
// exit 1 on a failed check.
// usage: node tools/stars-shots.mjs [--lang ru] [--port 8813]
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
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
const port = +opt('port', 8813), LANGS = opt('lang', '') ? [opt('lang')] : ['ru', 'en', 'id'];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'TEST_BOT_TOKEN_stars_shots', SECRET = 'stars-shots-secret', API = `http://127.0.0.1:${port}`;
const O = { w: 844, h: 390, safe: { left: 47, right: 47, bottom: 21 }, content: { top: 46 } };
const fails = [], ok = (c, m) => { if (!c) fails.push(m); else console.log('ok  ', m); };
function initData(user) {
  const f = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAH' + user.id, user: JSON.stringify(user) };
  const dcs = Object.keys(f).sort().map((k) => k + '=' + f[k]).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  return new URLSearchParams({ ...f, hash: createHmac('sha256', secret).update(dcs).digest('hex') }).toString();
}
const hook = (upd) => fetch(API + '/tg/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET }, body: JSON.stringify(upd) });
const paid = (from, order, amount) => hook({ update_id: 1, message: { message_id: 1, from, chat: { id: from.id, type: 'private' }, date: Math.floor(Date.now() / 1000),
  successful_payment: { currency: 'XTR', total_amount: amount, invoice_payload: order, telegram_payment_charge_id: 'stxSHOT' + order, provider_payment_charge_id: '' } } });

mkdirSync('shots/stars', { recursive: true });
const persist = mkdtempSync(join(tmpdir(), 'bvr-stars-'));
const bot = createServer((rq, rs) => { let b = ''; rq.on('data', (c) => { b += c; }); rq.on('end', () => {
  const m = rq.url.split('/').pop(); let p = {}; try { p = JSON.parse(b || '{}'); } catch (e) {}
  rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ ok: true, result: m === 'createInvoiceLink' ? 'https://t.me/$shot_' + p.payload : true }));
}); });
await new Promise((r) => bot.listen(port + 3, '127.0.0.1', r));
let w = null, srv = null;
try {
  execFileSync(join(ROOT, 'node_modules', '.bin', 'wrangler'), ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist],
    { cwd: join(ROOT, 'server'), stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
  w = await startWrangler(port, { args: ['--persist-to', persist, '--var', `BOT_TOKEN:${TOKEN}`, '--var', `TG_API:http://127.0.0.1:${port + 3}`, '--var', `TG_WEBHOOK_SECRET:${SECRET}`] });
  srv = await startServer(port + 1);
  for (const [i, lang] of LANGS.entries()) {
    const U = { id: 555000100 + i, first_name: { ru: 'Вадим', en: 'Alex', id: 'Budi' }[lang], username: 'player_' + lang, language_code: lang };
    // a balance to show: 35 stars bought before (one paid order of 50 … simply s50 paid, then the screen buys s120)
    const inv = await (await fetch(API + '/v1/stars/invoice', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData(U) }, body: JSON.stringify({ pack: 's50' }) })).json();
    await paid(U, inv.order, 50);
    const tg = fakeTelegram({ fullscreen: true, safe: O.safe, content: O.content, lang }).replace(/initData:'[^']*'/, 'initData:' + JSON.stringify(initData(U)))
      .replace(/initDataUnsafe:\{user:\{[^}]*\}\}/, 'initDataUnsafe:{user:' + JSON.stringify(U) + '}');
    const g = await openGame('chromium', { w: O.w, h: O.h, mobile: true, dpr: 2, tg });
    const { page } = g;
    try {
      await page.addInitScript(`try{ localStorage.setItem('bvr_lang','${lang}'); localStorage.setItem('bvr_onboard','1'); }catch(e){}`);
      await page.goto(`http://127.0.0.1:${port + 1}/index.html?nomusic&api=${encodeURIComponent(API)}`, { waitUntil: 'load' });
      await page.waitForFunction('window.__hk && __hk.menuState && __hk.menuState().layer==="menu"', null, { timeout: 60000 });
      await page.waitForFunction('__hk.coins().stars===50 && __hk.sb().packs', null, { timeout: 20000 }).catch(() => {});
      await page.evaluate(`__hk.menu('main')`);
      await page.evaluate('document.fonts.ready'); await page.waitForTimeout(900);
      const sb0 = await page.evaluate(() => __hk.sb());
      ok(sb0.ok && sb0.btn === 2 && (await page.evaluate(() => __hk.coins().stars)) === 50, `${lang}: «+» in the wallet, 50 stars from the server`);
      await page.screenshot({ path: `shots/stars/main-${lang}.png` });
      await page.evaluate(`__hk.menu('profile')`); await page.waitForTimeout(300);
      await page.screenshot({ path: `shots/stars/profile-${lang}.png` });
      await page.evaluate(`__hk.menu('main')`); await page.waitForTimeout(200);
      await page.click('#start section.cur .mtopup'); await page.waitForTimeout(400);
      await page.screenshot({ path: `shots/stars/packs-${lang}.png` });
      await page.click('#start section.cur .msbp[data-pack="s120"]');
      await page.waitForFunction(() => window.__tgInvoiceClose && __hk.sb().st === 'open', null, { timeout: 10000 });
      await page.evaluate(() => __tgInvoiceClose('paid')); await page.waitForTimeout(500);
      await page.screenshot({ path: `shots/stars/wait-${lang}.png` });
      await paid(U, await page.evaluate(() => __hk.sb().order), 100);
      await page.waitForFunction(() => __hk.sb().st === 'done' && __hk.sb().fly > 0, null, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(450);
      await page.screenshot({ path: `shots/stars/fly-${lang}.png` });
      await page.waitForFunction(() => __hk.sb().st === 'done' && !__hk.sb().fly, null, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(300);
      await page.screenshot({ path: `shots/stars/done-${lang}.png` });
      ok((await page.evaluate(() => __hk.coins().stars)) === 170, `${lang}: +120 credited after the webhook`);
      await page.click('#start section.cur .msbp[data-pack="s300"]');
      await page.waitForFunction(() => window.__tgInvoiceClose && __hk.sb().st === 'open', null, { timeout: 10000 });
      await page.evaluate(() => __tgInvoiceClose('cancelled')); await page.waitForTimeout(300);
      await page.screenshot({ path: `shots/stars/cancel-${lang}.png` });
      // the shop: coins for stars (170 stars now) — the packs, the question, bought, not enough
      await page.evaluate(`__hk.menu('main'); __hk.menu('shop')`); await page.waitForTimeout(400);
      await page.screenshot({ path: `shots/stars/shop-${lang}.png` });
      await page.click('#start section.cur .mshc[data-pack="c300"]'); await page.waitForTimeout(250);
      await page.screenshot({ path: `shots/stars/shop-ask-${lang}.png` });
      await page.click('#start section.cur [data-act="cyes"]');
      await page.waitForFunction(() => __hk.sh().st === 'done' && __hk.sh().fly > 0, null, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(400);
      await page.screenshot({ path: `shots/stars/shop-fly-${lang}.png` });
      await page.waitForFunction(() => __hk.sh().st === 'done' && !__hk.sh().fly, null, { timeout: 10000 }).catch(() => {});
      ok((await page.evaluate(() => [__hk.coins().coins, __hk.coins().stars].join())) === '300,120', `${lang}: 300 coins for 50 stars`);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `shots/stars/shop-done-${lang}.png` });
      await page.click('#start section.cur .mshc[data-pack="c700"]'); await page.waitForTimeout(250);
      await page.click('#start section.cur [data-act="cyes"]');
      await page.waitForFunction(() => __hk.sh().st === 'done' && !__hk.sh().fly && __hk.coins().coins === 1000, null, { timeout: 10000 }).catch(() => {});
      await page.click('#start section.cur .mshc[data-pack="c300"]'); await page.waitForTimeout(250);
      await page.screenshot({ path: `shots/stars/shop-nostars-${lang}.png` });
      ok((await page.evaluate(() => [__hk.sh().st, __hk.coins().stars].join())) === 'no,20', `${lang}: 20 stars left, 300 for 50 → not enough`);
      const errs = g.logs.filter(isError).filter((e) => !/status of 403/.test(e.text));   // /v1/admin/me → 403: a regular player
      ok(!errs.length, `${lang}: no page errors ${JSON.stringify(errs).slice(0, 300)}`);
    } finally { await g.browser.close(); }
  }
} catch (e) {
  fails.push('exception: ' + (e && e.stack || e));
  if (w) console.log(w.log().slice(-2000));
} finally {
  if (w) w.close(); if (srv) srv.close(); bot.close();
  try { rmSync(persist, { recursive: true, force: true }); } catch (e) {}
}
console.log(`stars-shots: ${fails.length ? 'FAIL' : 'OK'} → shots/stars/`);
for (const f of fails) console.log('  ✗ ' + f);
process.exit(fails.length ? 1 : 0);
