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
// tgLang = Telegram's own UI language (width of its "Close" button), independent of the game language
const SETUPS = [
  { name: 'land', tgLang: 'ru', w: 844, h: 390, safe: { left: 47, right: 47, bottom: 21 }, content: { top: 46 } },
  { name: 'land-tgen', tgLang: 'en', w: 844, h: 390, safe: { left: 47, right: 47, bottom: 21 }, content: { top: 46 } },
  { name: 'land-se', tgLang: 'ru', w: 667, h: 375, safe: {}, content: { top: 46 } },          // iPhone SE-size landscape, no notch
  { name: 'port', tgLang: 'ru', w: 390, h: 844, safe: { top: 47, bottom: 34 }, content: { top: 90 } },
];
// Telegram's buttons as drawn in the test — measured-ish real widths, NOT the game's estimate (the game must keep clear)
const CLOSE_W = { ru: 100, en: 76, id: 76 }, RIGHT_W = 96;
const LANGS = ['ru', 'en', 'id'];
const PAD_KEYS = { bA: ['padA1', 'padA2'], bB: ['padB1', 'padB2'], bX: ['padX1', 'padX2'], bY: ['padY1', 'padY2'], bRT: ['hRT'] };

const srv = await startServer(port);
mkdirSync('shots/ui', { recursive: true });
const fails = [];

for (const S of SETUPS) {
  const g = await openGame(browserName, { w: S.w, h: S.h, mobile: true, tg: fakeTelegram({ fullscreen: true, safe: S.safe, content: S.content, lang: S.tgLang }) });
  const isPort = S.name.startsWith('port');
  const { page } = g;
  try {
    await page.goto(`http://127.0.0.1:${port}/index.html?autostart=120&autopilot&seed=4`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction('window.__hk && __hk.st()==="play"', null, { timeout: 60000 });
    const env = await page.evaluate('__hk.safe()');
    if (env.band !== S.content.top) fails.push(`${S.name}: game sees contentSafeAreaInset.top=${env.band}, expected ${S.content.top}`);
    // Playwright's WebKit cannot emulate portrait orientation (screen.orientation stays landscape): there the portrait
    // setup runs as a narrow landscape screen — still a useful layout stress test.
    const noPortrait = browserName === 'webkit' && isPort;
    if (noPortrait) console.log('note: WebKit cannot emulate portrait — "port" runs as a narrow landscape screen');
    else if (env.portrait !== (isPort)) fails.push(`${S.name}: game thinks portrait=${env.portrait}`);
    // Portrait: the game asks to rotate the phone (#rotate covers everything). Check that screen, then hide it so the
    // portrait layout underneath (used if the overlay is ever dropped) can be inspected too.
    if (isPort && !noPortrait) {
      const rot = await page.evaluate('getComputedStyle(document.getElementById("rotate")).display');
      if (rot === 'none') fails.push('port: the "rotate your phone" screen is not shown in portrait');
      if (browserName === 'chromium') await page.screenshot({ path: 'shots/ui/tg-port-rotate.png' });
      await page.evaluate('document.getElementById("rotate").style.visibility="hidden"');
    }
    for (const lang of LANGS) {
      for (const fps of [false, true]) {
        await page.evaluate(`__hk.lang('${lang}'); __hk.showFps(${fps}); __hk.layoutTop();`);
        await page.waitForTimeout(700);   // one fps refresh (the label text is filled every 0.5 s)
        const r = await page.evaluate(({ sa, band, cw, rw }) => {
          const W = innerWidth, H = innerHeight;
          const rect = (el) => { if (!el) return null; const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return null;
            const b = el.getBoundingClientRect(); return b.width && b.height ? { x: b.left, y: b.top, w: b.width, h: b.height } : null; };
          const zones = [{ n: 'tg-close', x: sa.left || 0, y: sa.top || 0, w: cw, h: band },
                         { n: 'tg-right', x: W - (sa.right || 0) - rw, y: sa.top || 0, w: rw, h: band }];
          // draw the Telegram zones for the screenshot
          document.querySelectorAll('.tgzone').forEach((e) => e.remove());
          for (const z of zones) { const d = document.createElement('div'); d.className = 'tgzone';
            d.style.cssText = `position:fixed;left:${z.x}px;top:${z.y}px;width:${z.w}px;height:${z.h}px;background:rgba(255,40,60,.35);border:1px solid #f24;z-index:99999;pointer-events:none`;
            document.body.appendChild(d); }
          const ids = ['hud', 'bPause', 'fps', 'tacbadge'];
          const el = {}; for (const id of ids) el[id] = rect(document.getElementById(id));
          const pads = ['bA', 'bB', 'bX', 'bY', 'bRT'].map((id) => rect(document.getElementById(id))).filter(Boolean);
          return { W, H, zones, el, pads, fpsText: document.getElementById('fps').textContent };
        }, { sa: S.safe, band: S.content.top, cw: CLOSE_W[S.tgLang], rw: RIGHT_W });
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
        const sa = S.safe, rowTop = sa.top || 0, rowBot = rowTop + S.content.top, hud = r.el.hud;
        if (hud && !isPort) {
          // landscape full screen: scoreboard on the left, right after "Close", aligned with that row — or below the band
          if (hud.x + hud.w / 2 >= r.W / 2) fails.push(`${tag}: scoreboard not left of centre (x ${Math.round(hud.x)}, w ${Math.round(hud.w)})`);
          const inRow = hud.y < rowBot;
          if (inRow) {
            const closeR = (sa.left || 0) + CLOSE_W[S.tgLang];
            if (hud.y < rowTop - 0.5 || hud.y + hud.h > rowBot + 0.5) fails.push(`${tag}: scoreboard sticks out of the Telegram button row`);
            if (Math.abs((hud.y + hud.h / 2) - (rowTop + rowBot) / 2) > 2) fails.push(`${tag}: scoreboard not vertically aligned with the "Close" row`);
            if (hud.x - closeR > 40) fails.push(`${tag}: scoreboard ${Math.round(hud.x - closeR)} px away from "Close" (should sit right after it)`);
          } else if (hud.y < rowBot) fails.push(`${tag}: scoreboard below-band fallback still in the band`);
          if (!inRow && hud.x > (sa.left || 0) + 20) fails.push(`${tag}: scoreboard fallback not at the left edge`);
        }
        if (r.el.fps) {
          // FPS in the bottom-left corner, inside the safe area (checked above)
          if (r.el.fps.x > (sa.left || 0) + 20 || r.el.fps.y + r.el.fps.h < r.H - (sa.bottom || 0) - 20) fails.push(`${tag}: FPS not in the bottom-left corner`);
        }
        if (hit(r.el.fps, r.el.hud)) fails.push(`${tag}: FPS overlaps scoreboard`);
        if (hit(r.el.fps, r.el.bPause)) fails.push(`${tag}: FPS overlaps pause`);
        for (const p of r.pads) if (hit(r.el.fps, p)) fails.push(`${tag}: FPS overlaps an on-screen button`);
        for (const p of r.pads) if (hit(r.el.tacbadge, p)) fails.push(`${tag}: tactic badge overlaps an on-screen button`);
        if (fps && !/\d+ fps/.test(r.fpsText)) fails.push(`${tag}: FPS text "${r.fpsText}"`);
        if (browserName === 'chromium') await page.screenshot({ path: `shots/ui/tg-${S.name}${isPort ? '-layout' : ''}-${lang}-${fps ? 'fps' : 'nofps'}.png` });
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
// ---------- the menu (docs/MENU_PLAN.md): every screen and the pause, landscape setups, RU / EN / ID.
// Nothing under Telegram's buttons or outside the device safe area, texts fit their items, the screen content stays
// above the footer (now playing + button hints) and the two columns do not overlap.
const MENU_SCREENS = [['main'], ['welcome'], ['mode'], ['prep'], ['friend'], ['settings'], ['profile'], ['shop'], ['train'], ['rules', 0], ['rules', 1], ['pause'], ['lesson', 4], ['lesson', 8]];
for (const S of SETUPS.filter((x) => !x.name.startsWith('port'))) {
  const g = await openGame(browserName, { w: S.w, h: S.h, mobile: true, tg: fakeTelegram({ fullscreen: true, safe: S.safe, content: S.content, lang: S.tgLang }) });
  const { page } = g;
  try {
    await page.goto(`http://127.0.0.1:${port}/index.html?seed=4&nomusic`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction('window.__hk && __hk.menuState && __hk.menuState().layer==="menu"', null, { timeout: 60000 });
    await page.evaluate('document.fonts.ready');
    for (const lang of LANGS) {
      await page.evaluate(`__hk.lang('${lang}')`);
      for (const [scr, key] of MENU_SCREENS) {
        const tag = `menu ${S.name} ${lang} ${scr}${key !== undefined ? ' tab ' + key : ''}`;
        if (scr === 'lesson') {
          // a lesson screen: task, counter, medal thresholds, button tip (and the tactics buttons in lesson 9)
          await page.evaluate(`__hk.menu('main'); __hk.train(${key})`); await page.waitForTimeout(400);
          const r = await page.evaluate(({ sa, band, cw, rw }) => {
            const W = innerWidth, H = innerHeight, out = [];
            const vis = (e) => { if (!e) return null; const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return null; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 ? b : null; };
            const zones = [{ n: 'tg-close', x: sa.left || 0, y: sa.top || 0, w: cw, h: band }, { n: 'tg-right', x: W - (sa.right || 0) - rw, y: sa.top || 0, w: rw, h: band }];
            const hit = (a, z) => a.left < z.x + z.w && z.x < a.right && a.top < z.y + z.h && z.y < a.bottom;
            const boxes = ['.lh-task', '.lh-cnt', '.lh-med', '.lh-tip', '.lh-tac'].map((q) => [q, vis(document.querySelector('#lhud ' + q))]).filter((x) => x[1]);
            const pads = ['bA', 'bB', 'bX', 'bY', 'bRT', 'bPause'].map((id) => [id, vis(document.getElementById(id))]).filter((x) => x[1]);
            for (const [q, b] of boxes) {
              for (const z of zones) if (hit(b, z)) out.push(`${q} under ${z.n}`);
              if (b.left < (sa.left || 0) - 0.5 || b.right > W - (sa.right || 0) + 0.5 || b.top < (sa.top || 0) - 0.5 || b.bottom > H - (sa.bottom || 0) + 0.5) out.push(`${q} outside the safe area`);
              for (const [id, pb] of pads) if (hit(b, { x: pb.left, y: pb.top, w: pb.width, h: pb.height })) out.push(`${q} overlaps #${id}`);
            }
            for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i][1], b = boxes[j][1]; if (hit(a, { x: b.left, y: b.top, w: b.width, h: b.height })) out.push(`${boxes[i][0]} overlaps ${boxes[j][0]}`); }
            const t = document.getElementById('lhTask'); if (t && t.scrollWidth > t.clientWidth + 1) out.push('task text cut');
            return out;
          }, { sa: S.safe, band: S.content.top, cw: CLOSE_W[S.tgLang], rw: RIGHT_W });
          for (const x of r) fails.push(`${tag}: ${x}`);
          if (browserName === 'chromium' && lang === 'ru' && S.name === 'land') await page.screenshot({ path: `shots/ui/tg-menu-lesson${key}.png` });
          await page.evaluate("__hk.menu('main')");
          continue;
        }
        if (scr === 'pause') {
          await page.evaluate("__hk.menu('main'); __hk.start()");
          await page.waitForFunction('__hk.st()==="face" || __hk.st()==="play"', null, { timeout: 60000 });
          await page.waitForTimeout(200); await page.keyboard.press('Escape');
        } else await page.evaluate(`__hk.menu('main'); ${scr === 'main' ? '' : `__hk.menu('${scr}'${key !== undefined ? ', ' + key : ''})`}`);
        await page.waitForTimeout(150);
        const r = await page.evaluate(({ sa, band, cw, rw, pause }) => {
          const W = innerWidth, H = innerHeight, out = [];
          const root = pause ? document.getElementById('pausescr') : document.getElementById('start');
          const scr = root.querySelector('.mscr.cur'), foot = root.querySelector('.mfoot');
          if (!scr) return ['no current screen'];
          const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden' ? b : null; };
          const zones = [{ n: 'tg-close', x: sa.left || 0, y: sa.top || 0, w: cw, h: band }, { n: 'tg-right', x: W - (sa.right || 0) - rw, y: sa.top || 0, w: rw, h: band }];
          const hit = (a, z) => a.left < z.x + z.w && z.x < a.right && a.top < z.y + z.h && z.y < a.bottom;
          const name = (e) => (e.id ? '#' + e.id : '.' + [...e.classList].join('.')) + ' "' + e.textContent.trim().slice(0, 24) + '"';
          const els = [...scr.querySelectorAll('.mi,.mrow,.mbtn,.mtc,.mtab,.mlang,.mtitle,.mbrand,.mpill,.mcard,.mroom,.mscore,.mtbl .tr,.mback,.mprof,.mprofbig,.pst,.mshop,.mwallet')]
            .concat(foot ? [...foot.querySelectorAll('.mnp,.mh')] : []);
          const fb = foot && vis(foot);
          for (const e of els) {
            const b = vis(e); if (!b) continue;
            // rows scrolled out of a scrolling list (the lessons) are not on screen
            const sc = e.closest('.mles'); if (sc) { const cb = sc.getBoundingClientRect(); if (b.bottom <= cb.top + 1 || b.top >= cb.bottom - 1) continue; }
            for (const z of zones) if (hit(b, z)) out.push(`${name(e)} under ${z.n}`);
            if (b.left < (sa.left || 0) - 0.5 || b.right > W - (sa.right || 0) + 0.5 || b.top < (sa.top || 0) - 0.5 || b.bottom > H - (sa.bottom || 0) + 0.5)
              out.push(`${name(e)} outside the safe area ${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}`);
            if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible') out.push(`${name(e)} text cut (${e.scrollWidth} > ${e.clientWidth})`);
            if (fb && !foot.contains(e) && b.bottom > fb.top + 1 && b.right > fb.left && getComputedStyle(e).position !== 'absolute')
              { const hs = [...foot.querySelectorAll('.mnp,.mh')].map(vis).filter(Boolean); if (hs.some((h) => hit(b, { x: h.left, y: h.top, w: h.width, h: h.height }))) out.push(`${name(e)} overlaps the footer`); }
          }
          // items of the left list must fit the left column
          const L = scr.querySelector('.mleft'), R = scr.querySelector('.mright'), lb = L && vis(L), rb = R && vis(R);
          if (lb) for (const e of L.querySelectorAll('.mi,.mrow')) { const b = vis(e); if (b && b.right > lb.right + 1) out.push(`${name(e)} wider than the left column`); }
          if (lb && rb && !scr.classList.contains('wide')) for (const e of R.querySelectorAll('.mcard,.mroom,.mtbl,.mteams,.mwallet,.mscore')) { const b = vis(e); if (b && b.left < lb.right - 1 && b.right > lb.left && b.top < lb.bottom && b.bottom > lb.top) out.push(`${name(e)} overlaps the left column`); }
          return out;
        }, { sa: S.safe, band: S.content.top, cw: CLOSE_W[S.tgLang], rw: RIGHT_W, pause: scr === 'pause' });
        for (const x of r) fails.push(`${tag}: ${x}`);
        // the currency: an icon next to the number (no word «монеты / coins / koin» by a number), the icon as tall as
        // the digits; the wallet (main) shows coins and stars — a number or «—», never an empty spot
        if (scr === 'main' || scr === 'profile' || scr === 'shop') {
          const w = await page.evaluate((main) => {
            const out = [], scr = document.querySelector('#start .mscr.cur');
            const txt = scr.textContent;
            if (/\d\s*(монет|coins?\b|koin)/i.test(txt) || /(монет[аы]?|coins?|koin)\s*:?\s*\d/i.test(txt)) out.push('currency word next to a number: ' + txt.replace(/\s+/g, ' ').slice(0, 120));
            for (const id of ['ic-coin', 'ic-star']) if (!document.getElementById(id)) out.push('#' + id + ' symbol missing');
            const curs = [...scr.querySelectorAll('.cval')];
            if (curs.length < 2) out.push(`${curs.length} currency labels`);
            for (const c of curs) {
              const ic = c.querySelector('.ic'), b = c.querySelector('.cn');
              if (!ic || !ic.querySelector('use') || !b) { out.push('currency label without an icon'); continue; }
              if (!b.getBoundingClientRect().height) continue;   // not on screen (a lesson is still running over the menu)
              if (!b.textContent.trim()) out.push('currency label without a number');
              const ib = ic.getBoundingClientRect(), fs = parseFloat(getComputedStyle(b).fontSize);
              // digits of the menu font are ~0.7 em tall: the icon 0.7…0.95 em
              if (!(ib.height >= fs * 0.7 && ib.height <= fs * 0.95)) out.push(`icon ${ib.height.toFixed(1)} px next to ${fs} px text`);
              if (Math.abs((ib.top + ib.bottom) / 2 - (b.getBoundingClientRect().top + b.getBoundingClientRect().bottom) / 2) > fs * 0.2) out.push('icon not centred on the number');
            }
            if (main) { const wl = scr.querySelector('.mwallet'); if (!wl || wl.querySelectorAll('.cval').length !== 2) out.push('main: no wallet with coins and stars'); }
            return out;
          }, scr === 'main');
          for (const x of w) fails.push(`${tag}: ${x}`);
        }
        if (browserName === 'chromium' && lang === 'ru' && S.name === 'land') await page.screenshot({ path: `shots/ui/tg-menu-${scr}${key ? '-tab2' : ''}.png` });
        if (scr === 'pause') { await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter'); await page.waitForTimeout(150); }
      }
    }
    for (const e of g.logs.filter(isError)) fails.push(`menu ${S.name} [${e.type}] ${e.text}`);
    for (const e of await page.evaluate('__hk.errors()')) fails.push(`menu ${S.name} [window] ${e}`);
  } catch (e) {
    fails.push(`menu ${S.name}: runner error: ${e.message.split('\n')[0]}`);
  } finally {
    await g.browser.close();
  }
}

srv.close();
if (fails.length) console.log('FAIL:\n  ' + fails.join('\n  '));
console.log(fails.length ? `\nTG LAYOUT FAIL (${browserName})` : `TG LAYOUT OK (${browserName}) — screenshots in shots/ui/tg-*.png`);
process.exit(fails.length ? 1 : 0);
