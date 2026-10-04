// Menu screenshots for the menu redesign (docs/MENU_PLAN.md), in a fake Telegram (safe areas as in smoke-tg.mjs):
//   node tools/menu-shots.mjs before   — the game's current menu and pause → shots/menu/before-<screen>-<orient>.png
//   node tools/menu-shots.mjs mock     — stage 1 mock-ups (tools/menu-mock/index.html) → shots/menu/mock-<screen>-<orient>.png
//   node tools/menu-shots.mjs after    — the game's new menu (every screen, pause, result; portrait = the rotate screen)
//                                        → shots/menu/after-<screen>-<orient>.png
//   [--lang ru|en|id] [--only main,prep,…] [--zones] (--zones draws Telegram's button zones and the device safe area)
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { startServer } from './serve.mjs';
import { openGame, fakeTelegram } from './browser.mjs';

const args = process.argv.slice(2);
const what = args[0] || 'mock';
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const LANG = opt('lang', 'ru'), ZONES = args.includes('--zones'), ONLY = opt('only', '');
const ORIENT = [
  { name: 'land', w: 844, h: 390, safe: { left: 47, right: 47, bottom: 21 }, content: { top: 46 } },
  { name: 'port', w: 390, h: 844, safe: { top: 47, bottom: 34 }, content: { top: 90 } },
];
// 'mode~notg' — the same screen outside Telegram (own Back button instead of Telegram's)
const SCREENS = ['main', 'mode', 'mode~notg', 'prep', 'prepfriend', 'friend', 'train', 'lesson', 'lessondone', 'rules', 'controls', 'settings', 'pause'];
// Telegram's own buttons: "Close" top-left, "⌄ •••" top-right, inside contentSafeAreaInset.top
const ZONE_JS = (o) => `(function(){ var t=${o.safe.top || 0}, c=${o.content.top}, l=${o.safe.left || 0}, r=${o.safe.right || 0}, b=${o.safe.bottom || 0};
  function box(css){ var d=document.createElement('div'); d.style.cssText='position:fixed;z-index:9999;pointer-events:none;'+css; document.body.appendChild(d); }
  box('left:'+(l+8)+'px;top:'+t+'px;width:112px;height:'+c+'px;background:rgba(255,40,90,.28);outline:1px dashed #ff2a5a');
  box('right:'+(r+8)+'px;top:'+t+'px;width:100px;height:'+c+'px;background:rgba(255,40,90,.28);outline:1px dashed #ff2a5a');
  box('inset:'+t+'px '+r+'px '+b+'px '+l+'px;outline:1px dashed rgba(255,230,0,.8)'); })()`;

mkdirSync('shots/menu', { recursive: true }); mkdirSync('tools/menu-mock/fonts', { recursive: true });
const port = 8541, srv = await startServer(port);
for (const o of ORIENT) {
  const g = await openGame('chromium', { w: o.w, h: o.h, mobile: true, dpr: 2, tg: fakeTelegram({ fullscreen: true, safe: o.safe, content: o.content, lang: LANG }) });
  const { page } = g;
  await page.addInitScript(`try{ localStorage.setItem('bvr_lang','${LANG}'); }catch(e){}`);
  if (what === 'after') {
    await page.goto(`http://127.0.0.1:${port}/index.html?seed=5`, { waitUntil: 'load' });
    await page.waitForFunction('window.__hk && __hk.menuState', null, { timeout: 30000 });
    await page.evaluate('document.fonts.ready'); await page.waitForTimeout(900);
    const shot = async (n) => { if (ZONES) await page.evaluate(ZONE_JS(o)); await page.screenshot({ path: `shots/menu/after-${n}-${o.name}${LANG === 'ru' ? '' : '-' + LANG}.png` });
      await page.evaluate("document.querySelectorAll('body>div[style*=\"z-index:9999\"]').forEach(function(e){e.remove();})"); };
    if (o.name === 'port') { await shot('rotate'); await g.browser.close(); continue; }
    const nav = async (keys) => { for (const k of keys) { await page.keyboard.press(k); await page.waitForTimeout(120); } };
    await page.evaluate("__hk.menu('main'); __hk.menu('welcome')"); await page.waitForTimeout(200); await shot('welcome');
    await page.evaluate("__hk.menu('main')"); await page.waitForTimeout(1600); await shot('main');
    await page.evaluate("__hk.menu('prep')"); await page.waitForTimeout(200); await shot('prep');
    await nav(['ArrowRight', 'ArrowDown']); await page.waitForTimeout(300); await shot('prep-away');
    await page.evaluate("__hk.menu('setup')"); await page.waitForTimeout(200); await shot('setup');
    await page.evaluate("__hk.menu('main'); __hk.menu('friend')"); await page.waitForTimeout(200); await shot('friend');
    await nav(['ArrowDown']); await shot('friend-join');
    await page.evaluate("__hk.menu('main'); __hk.menu('settings')"); await page.waitForTimeout(200); await nav(['ArrowDown']); await shot('settings');
    await page.evaluate("__hk.menu('main'); __hk.menu('profile')"); await page.waitForTimeout(200); await shot('profile');
    await page.evaluate("__hk.menu('main'); __hk.menu('shop')"); await page.waitForTimeout(200); await shot('shop');
    await page.evaluate("__hk.menu('main'); __hk.menu('train')"); await page.waitForTimeout(200); await nav(['ArrowDown','ArrowDown','ArrowDown','ArrowDown']); await shot('train');
    for (const [i, n] of [[0, 'lesson-skate'], [4, 'lesson-shot'], [8, 'lesson-tactic']]) {
      await page.evaluate(`__hk.train(${i}); __hk.trainBot(true)`); await page.waitForTimeout(1600); await page.evaluate('__hk.trainBot(false)'); await shot(n);
    }
    await page.evaluate('__hk.train(3); __hk.trainBot(true)'); await page.waitForFunction('__hk.trainState().res', null, { timeout: 30000 }); await page.waitForTimeout(400); await shot('lesson-result');
    await page.evaluate("__hk.menu('main')"); await page.waitForTimeout(200);
    await page.evaluate("__hk.menu('main'); __hk.menu('settings'); __hk.menu('ctrl')"); await page.waitForTimeout(200); await shot('controls');
    await page.evaluate("__hk.menu('main'); __hk.menu('train', 1)"); await page.waitForTimeout(200); await nav(['ArrowDown', 'ArrowDown']); await shot('train-rules');
    await page.evaluate("__hk.menu('main')"); await page.waitForTimeout(200);
    await page.evaluate('__hk.start()');
    await page.waitForFunction('__hk.st()==="play" || __hk.st()==="face"', null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape'); await page.waitForTimeout(300); await shot('pause');
    await nav(['ArrowDown', 'Enter']); await page.waitForTimeout(200); await shot('pause-controls');
    await nav(['Escape', 'ArrowDown', 'Enter']); await page.waitForTimeout(200); await shot('pause-settings');
    await nav(['Escape', 'Escape']);
    await page.evaluate('__hk.setClock(0.5)'); await page.waitForFunction('__hk.st()==="over"', null, { timeout: 20000 }); await page.waitForTimeout(600);
    await shot('result');
  } else if (what === 'before') {
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction('window.__hk', null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    if (ZONES) await page.evaluate(ZONE_JS(o));
    await page.screenshot({ path: `shots/menu/before-main-${o.name}.png` });
    await page.evaluate('__hk.start()');
    await page.waitForFunction('__hk.st()==="play" || __hk.st()==="face"', null, { timeout: 60000 });
    await page.waitForTimeout(2500);
    // a match frame for the mock-ups' pause / lesson background (landscape only)
    if (o.name === 'land') {
      await page.screenshot({ path: 'tools/menu-mock/game-bg.jpg', type: 'jpeg', quality: 70, scale: 'css' });
      // the lesson frame: own player with the puck 9 m in front of the opponent's goal, nobody else but the goalie, no scoreboard
      await page.evaluate(`(function(){ var c=__hk.ctrl(), ad=__hk.ad(); c.x=ad*17; c.z=1.5; c.vx=c.vz=0; c.yaw=ad>0?0:Math.PI; __hk.puck.owner=c;
        __hk.p.forEach(function(p){ if(p!==c && !p.goalie){ p.x=-ad*20; p.vx=p.vz=0; } }); })()`);
      await page.waitForTimeout(1800);
      await page.evaluate('__hk.pause(); document.getElementById("hud").style.visibility="hidden"; document.getElementById("pausescr").style.display="none"');
      await page.waitForTimeout(300);
      await page.screenshot({ path: 'tools/menu-mock/lesson-bg.jpg', type: 'jpeg', quality: 70, scale: 'css' });
      await page.evaluate('document.getElementById("hud").style.visibility=""; document.getElementById("pausescr").style.display=""; __hk.pause()');
    }
    await page.evaluate('__hk.pause()'); await page.waitForTimeout(400);
    await page.screenshot({ path: `shots/menu/before-pause-${o.name}.png` });
  } else {
    for (const sc of SCREENS.filter((x) => !ONLY || ONLY.split(',').includes(x))) {
      const [s, v] = sc.split('~');
      await page.goto(`http://127.0.0.1:${port}/tools/menu-mock/index.html?s=${s}&lang=${LANG}${v === 'notg' ? '&tg=0' : ''}` +
        `&st=${o.safe.top || 0}&sl=${o.safe.left || 0}&sr=${o.safe.right || 0}&sb=${o.safe.bottom || 0}&ct=${o.content.top}`, { waitUntil: 'load' });
      await page.evaluate('document.fonts.ready'); await page.waitForTimeout(250);
      if (ZONES) await page.evaluate(ZONE_JS(o));
      await page.screenshot({ path: `shots/menu/mock-${s}${v ? '-' + v : ''}-${o.name}${LANG === 'ru' ? '' : '-' + LANG}.png` });
    }
  }
  const errs = g.logs.filter((l) => l.type === 'pageerror' || l.type === 'error');
  if (errs.length) console.log(o.name, 'errors:', errs.map((e) => e.text).join(' | '));
  await g.browser.close();
}
srv.close();
// one local page with every screenshot (shots/ is not in git): open shots/menu/index.html
const all = readdirSync('shots/menu').filter((f) => f.endsWith('.png')).sort();
const card = (f) => `<figure><img src="${f}" loading="lazy"><figcaption>${f}</figcaption></figure>`;
const group = (title, fs) => fs.length ? `<h2>${title}</h2><div class="g">${fs.map(card).join('')}</div>` : '';
writeFileSync('shots/menu/index.html', `<!doctype html><meta charset="utf-8"><title>BVR Hockey 26 — меню, скриншоты</title>
<style>body{margin:0;padding:16px;background:#0b1320;color:#dfe7f1;font:14px system-ui}h2{margin:24px 0 8px}
.g{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start}figure{margin:0}img{display:block;max-height:420px;max-width:100%;border-radius:8px;border:1px solid #2a3a52}
figcaption{font:12px monospace;color:#9fb3c9;margin-top:4px}</style>
<h1>Меню: было, макеты, после</h1>
${group('Было (текущая игра)', all.filter((f) => f.startsWith('before-')))}
${group('После — новое меню (этап 2)', all.filter((f) => f.startsWith('after-')))}
${group('Макеты — горизонталь', all.filter((f) => f.startsWith('mock-') && /-land\.png$/.test(f)))}
${group('Макеты — вертикаль', all.filter((f) => f.startsWith('mock-') && /-port\.png$/.test(f)))}
${group('Макеты — EN / ID', all.filter((f) => f.startsWith('mock-') && /-(en|id)\.png$/.test(f)))}`);
console.log(`menu shots (${what}) → shots/menu/ (all of them on shots/menu/index.html)`);
