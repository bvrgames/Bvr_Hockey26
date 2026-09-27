// Scripted play-through for audits (after INKWAVE's tools/play.mjs by Jayden Davis, MIT — see THIRD_PARTY.md).
// usage: node tools/play.mjs "<query>" '<script.json | inline json>' [--browser chromium|webkit] [--w 1280 --h 720] [--headed]
//   query: e.g. "?autostart=60&autopilot&seed=7#q2" (appended to the local server's index.html)
// script steps: {"until":"js expr"} {"wait":ms} {"down":"KeyW"} {"up":"KeyW"} {"press":"Space"} {"click":[x,y]}
//               {"eval":"js","log":"label"} {"shot":"shots/x.png"} {"freeze":true} {"step":ms} {"unfreeze":true}
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { startServer } from './serve.mjs';
import { openGame } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const query = args[0] || '?autostart=60&autopilot';
const raw = args[1] || '[{"wait":5000},{"eval":"JSON.stringify(__hk.snap())","log":"snap"}]';
const steps = JSON.parse(existsSync(raw) ? readFileSync(raw, 'utf8') : raw);
const port = +opt('port', 8491);

const srv = await startServer(port);
const { browser, page, logs } = await openGame(opt('browser', 'chromium'), { w: +opt('w', 1280), h: +opt('h', 720), headed: args.includes('--headed') });
try {
  await page.goto(`http://127.0.0.1:${port}/index.html${query}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__hk', null, { timeout: 120000 });
  for (const s of steps) {
    if (s.until) { try { await page.waitForFunction(s.until, null, { timeout: s.timeout || 60000, polling: 150 }); } catch { console.log('until timeout', s.until); } }
    if (s.wait) await page.waitForTimeout(s.wait);
    if (s.down) await page.keyboard.down(s.down);
    if (s.up) await page.keyboard.up(s.up);
    if (s.press) await page.keyboard.press(s.press);
    if (s.click) await page.mouse.click(s.click[0], s.click[1]);
    if (s.freeze) await page.evaluate('__hk.freeze()');
    if (s.step) await page.evaluate(`__hk.step(${+s.step})`);
    if (s.unfreeze) await page.evaluate('__hk.unfreeze()');
    if (s.eval) {
      try { const r = await page.evaluate(s.eval); if (r !== undefined) console.log((s.log || 'eval') + ' ->', typeof r === 'string' ? r : JSON.stringify(r)); }
      catch (e) { console.log('eval error', e.message); }
    }
    if (s.shot) { mkdirSync(dirname(s.shot), { recursive: true }); await page.screenshot({ path: s.shot }); console.log('shot', s.shot); }
  }
} finally {
  if (logs.length) console.log(logs.slice(0, 40).map((l) => `[${l.type}] ${l.text}`).join('\n'));
  await browser.close();
  srv.close();
}
