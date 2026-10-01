// Screenshots of the screens that show the currency (main menu wallet, profile, shop, result screen) in a fake
// Telegram, landscape 844×390 at dpr 2, RU / EN / ID: shots/wallet/<tag>-<screen>-<lang>.png.
// The balance is seeded into localStorage (bvr_coins / bvr_stars), the API is not called.
//   node tools/wallet-shots.mjs before|after [--only main,profile] [--lang ru]
import { mkdirSync } from 'node:fs';
import { startServer } from './serve.mjs';
import { openGame, fakeTelegram } from './browser.mjs';

const args = process.argv.slice(2);
const tag = args[0] || 'after';
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const ONLY = (opt('only', '') || 'main,profile,shop').split(',');
const LANGS = opt('lang', '') ? [opt('lang')] : ['ru', 'en', 'id'];
const O = { w: 844, h: 390, safe: { left: 47, right: 47, bottom: 21 }, content: { top: 46 } };

mkdirSync('shots/wallet', { recursive: true });
const port = 8547, srv = await startServer(port);
for (const lang of LANGS) {
  const g = await openGame('chromium', { w: O.w, h: O.h, mobile: true, dpr: 2, tg: fakeTelegram({ fullscreen: true, safe: O.safe, content: O.content, lang }) });
  const { page } = g;
  await page.addInitScript(`try{ localStorage.setItem('bvr_lang','${lang}'); localStorage.setItem('bvr_coins','1250'); localStorage.setItem('bvr_stars','35'); }catch(e){}`);
  await page.goto(`http://127.0.0.1:${port}/index.html?seed=5&nomusic`, { waitUntil: 'load' });
  await page.waitForFunction('window.__hk && __hk.menuState && __hk.menuState().layer==="menu"', null, { timeout: 60000 });
  await page.evaluate('document.fonts.ready'); await page.waitForTimeout(900);
  for (const s of ONLY) {
    await page.evaluate(`__hk.menu('main'); ${s === 'main' ? '' : `__hk.menu('${s}')`}`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `shots/wallet/${tag}-${s}-${lang}.png` });
  }
  await g.browser.close();
}
srv.close();
console.log('shots/wallet/' + tag + '-*.png');
