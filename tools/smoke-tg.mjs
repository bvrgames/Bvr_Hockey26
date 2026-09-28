// Telegram full-screen layout test: a fake Telegram.WebApp (Bot API 8.0, isFullscreen, safeAreaInset,
// contentSafeAreaInset) in a mobile viewport, landscape and portrait, RU / EN / ID, FPS on / off.
// Checks that the scoreboard, the pause button and the FPS label stay out of Telegram's button zones
// ("Close" top-left, "⌄ •••" top-right: width __hk.tgBtnW, height contentSafeAreaInset.top) and the device
// safe area, do not overlap each other or the on-screen controls, and that every on-screen button label fits its
// button in every language. Screenshots with the Telegram zones drawn: shots/ui/tg-<orient>-<lang>-<fps>.png.
// usage: node tools/smoke-tg.mjs [--browser chromium|webkit]
import { mkdirSync } from 'node:fs';
import { startServer } from './serve.mjs';
import { openGame, fakeTelegram, isError } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const browserName = opt('browser', 'chromium');
const port = +opt('port', 8498);
const SETUPS = [
  { name: 'land', w: 844, h: 390, safe: { left: 47, right: 47, bottom: 21 }, content: { top: 46 } },
  { name: 'port', w: 390, h: 844, safe: { top: 47, bottom: 34 }, content: { top: 90 } },
];
const LANGS = ['ru', 'en', 'id'];
const PAD_KEYS = { bA: ['padA1', 'padA2'], bB: ['padB1', 'padB2'], bX: ['padX1', 'padX2'], bY: ['padY1', 'padY2'], bRT: ['hRT'] };

const srv = await startServer(port);
mkdirSync('shots/ui', { recursive: true });
const fails = [];

for (const S of SETUPS) {
  const g = await openGame(browserName, { w: S.w, h: S.h, mobile: true, tg: fakeTelegram({ fullscreen: true, safe: S.safe, content: S.content }) });
  const { page } = g;
  try {
    await page.goto(`http://127.0.0.1:${port}/index.html?autostart=120&autopilot&seed=4`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction('window.__hk && __hk.st()==="play"', null, { timeout: 60000 });
    const env = await page.evaluate('__hk.safe()');
    if (env.band !== S.content.top) fails.push(`${S.name}: game sees contentSafeAreaInset.top=${env.band}, expected ${S.content.top}`);
    // Playwright's WebKit cannot emulate portrait orientation (screen.orientation stays landscape): there the portrait
    // setup runs as a narrow landscape screen — still a useful layout stress test.
    const noPortrait = browserName === 'webkit' && S.name === 'port';
    if (noPortrait) console.log('note: WebKit cannot emulate portrait — "port" runs as a narrow landscape screen');
    else if (env.portrait !== (S.name === 'port')) fails.push(`${S.name}: game thinks portrait=${env.portrait}`);
    // Portrait: the game asks to rotate the phone (#rotate covers everything). Check that screen, then hide it so the
    // portrait layout underneath (used if the overlay is ever dropped) can be inspected too.
    if (S.name === 'port' && !noPortrait) {
      const rot = await page.evaluate('getComputedStyle(document.getElementById("rotate")).display');
      if (rot === 'none') fails.push('port: the "rotate your phone" screen is not shown in portrait');
      if (browserName === 'chromium') await page.screenshot({ path: 'shots/ui/tg-port-rotate.png' });
      await page.evaluate('document.getElementById("rotate").style.visibility="hidden"');
    }
    for (const lang of LANGS) {
      for (const fps of [false, true]) {
        await page.evaluate(`__hk.lang('${lang}'); __hk.showFps(${fps}); __hk.layoutTop();`);
        await page.waitForTimeout(700);   // one fps refresh (the label text is filled every 0.5 s)
        const r = await page.evaluate(({ sa, band }) => {
          const W = innerWidth, H = innerHeight, bw = __hk.tgBtnW;
          const rect = (el) => { if (!el) return null; const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return null;
            const b = el.getBoundingClientRect(); return b.width && b.height ? { x: b.left, y: b.top, w: b.width, h: b.height } : null; };
          const zones = [{ n: 'tg-left', x: sa.left || 0, y: sa.top || 0, w: bw, h: band },
                         { n: 'tg-right', x: W - (sa.right || 0) - bw, y: sa.top || 0, w: bw, h: band }];
          // draw the Telegram zones for the screenshot
          document.querySelectorAll('.tgzone').forEach((e) => e.remove());
          for (const z of zones) { const d = document.createElement('div'); d.className = 'tgzone';
            d.style.cssText = `position:fixed;left:${z.x}px;top:${z.y}px;width:${z.w}px;height:${z.h}px;background:rgba(255,40,60,.35);border:1px solid #f24;z-index:99999;pointer-events:none`;
            document.body.appendChild(d); }
          const ids = ['hud', 'bPause', 'fps', 'tacbadge'];
          const el = {}; for (const id of ids) el[id] = rect(document.getElementById(id));
          const pads = ['bA', 'bB', 'bX', 'bY', 'bRT'].map((id) => rect(document.getElementById(id))).filter(Boolean);
          return { W, H, zones, el, pads, fpsText: document.getElementById('fps').textContent };
        }, { sa: S.safe, band: S.content.top });
        const hit = (a, b) => a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        const tag = `${S.name} ${lang} fps:${fps ? 'on' : 'off'}`;
        for (const id of ['hud', 'bPause', 'fps']) {
          const e = r.el[id];
          if (id === 'fps') { if (fps && !e) fails.push(`${tag}: FPS on but not visible`); if (!fps && e) fails.push(`${tag}: FPS off but visible`); }
          if (!e) { if (id !== 'fps') fails.push(`${tag}: #${id} not visible`); continue; }
          for (const z of r.zones) if (hit(e, z)) fails.push(`${tag}: #${id} overlaps ${z.n}`);
          const sa = S.safe;
          if (e.x < (sa.left || 0) - 0.5 || e.x + e.w > r.W - (sa.right || 0) + 0.5 || e.y < (sa.top || 0) - 0.5 || e.y + e.h > r.H - (sa.bottom || 0) + 0.5)
            fails.push(`${tag}: #${id} outside the device safe area ${JSON.stringify(e)}`);
        }
        if (hit(r.el.hud, r.el.bPause)) fails.push(`${tag}: scoreboard overlaps pause`);
        if (hit(r.el.fps, r.el.hud)) fails.push(`${tag}: FPS overlaps scoreboard`);
        if (hit(r.el.fps, r.el.bPause)) fails.push(`${tag}: FPS overlaps pause`);
        for (const p of r.pads) if (hit(r.el.fps, p)) fails.push(`${tag}: FPS overlaps an on-screen button`);
        for (const p of r.pads) if (hit(r.el.tacbadge, p)) fails.push(`${tag}: tactic badge overlaps an on-screen button`);
        if (fps && !/\d+ fps/.test(r.fpsText)) fails.push(`${tag}: FPS text "${r.fpsText}"`);
        if (browserName === 'chromium') await page.screenshot({ path: `shots/ui/tg-${S.name}${S.name === 'port' ? '-layout' : ''}-${lang}-${fps ? 'fps' : 'nofps'}.png` });
      }
      // on-screen button labels: every text this button can show must fit inside it
      const bad = await page.evaluate((PAD_KEYS) => {
        const out = [];
        for (const id in PAD_KEYS) {
          const b = document.getElementById(id), l = b.querySelector('i'), orig = l.textContent;
          for (const k of PAD_KEYS[id]) {
            l.textContent = __hk.T(k); __hk.fitPad();
            const bb = b.getBoundingClientRect(), lb = l.getBoundingClientRect();
            const round = id !== 'bRT';
            // round buttons: the label must fit the circle's inscribed width at its height; RT: the pill
            const maxW = round ? bb.width * 0.86 : bb.width * 0.94;
            if (l.scrollWidth > l.clientWidth + 1 || lb.width > maxW + 0.5 || lb.left < bb.left || lb.right > bb.right || lb.bottom > bb.bottom - 2)
              out.push(`${id} "${l.textContent}" ${Math.round(lb.width)}x${Math.round(lb.height)} in ${Math.round(bb.width)}x${Math.round(bb.height)}`);
          }
          l.textContent = orig; __hk.fitPad();
        }
        return out;
      }, PAD_KEYS);
      for (const b of bad) fails.push(`${S.name} ${lang}: label does not fit: ${b}`);
    }
    for (const e of g.logs.filter(isError)) fails.push(`${S.name} [${e.type}] ${e.text}`);
    for (const e of await page.evaluate('__hk.errors()')) fails.push(`${S.name} [window] ${e}`);
  } catch (e) {
    fails.push(`${S.name}: runner error: ${e.message.split('\n')[0]}`);
  } finally {
    await g.browser.close();
  }
}
srv.close();
if (fails.length) console.log('FAIL:\n  ' + fails.join('\n  '));
console.log(fails.length ? `\nTG LAYOUT FAIL (${browserName})` : `TG LAYOUT OK (${browserName}) — screenshots in shots/ui/tg-*.png`);
process.exit(fails.length ? 1 : 0);
