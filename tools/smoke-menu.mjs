// Menu test (docs/MENU_PLAN.md, stage 2) in a fake full-screen Telegram, landscape phone.
//   · keyboard only: main → Game mode → Vs computer → setup (team, 5 min, tactics) → Start → the match runs with them;
//     Esc → pause → Controls → back → Settings → back → Main menu; Quick match starts with the saved setup;
//     Settings: language and music volume change and survive a reload
//   · gamepad only (fake navigator.getGamepads): D-pad + A to a match, Start → pause, B → resume
//   · touch only (tap): Game mode → Vs computer → length → Start; the pause button → Resume
//   · Telegram BackButton: shown on sub-screens, hidden on the main menu, its click goes back; in a match — pause
//   · with a friend (relay-mock, server mode): the host lands on the match setup when the friend joins, the guest sees
//     the host's teams and length change before the start; the host's keyboard Start begins the match for both
//   · portrait: the rotate screen with the track line; menu music plays; with autoplay refused — "tap for sound",
//     the first tap starts it; the music fades out when a match starts
// Fails on any console error, page error or failed request.
// usage: node tools/smoke-menu.mjs [--browser chromium|webkit]
import { startServer } from './serve.mjs';
import { openGame, fakeTelegram, isError } from './browser.mjs';
import { startRelay } from './relay-mock.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const browserName = opt('browser', 'chromium');
const port = +opt('port', 8547);
const LAND = { w: 844, h: 390, safe: { left: 47, right: 47, bottom: 21 }, content: { top: 46 } };
const PORT = { w: 390, h: 844, safe: { top: 47, bottom: 34 }, content: { top: 90 } };
const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); };

// a gamepad the page can read: window.__pad.buttons[i] = pressed
const PAD = `(() => { const bt = []; for (let i = 0; i < 17; i++) bt.push({ pressed: false, value: 0 });
  window.__pad = { id: 'test pad', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: bt, timestamp: 0 };
  navigator.getGamepads = () => [window.__pad]; })();`;
// autoplay refused until the first touch (as on iPhone in Telegram)
const NO_AUTOPLAY = `(() => { const P = HTMLMediaElement.prototype, orig = P.play; window.__allowPlay = false; window.__playCalls = 0;
  window.addEventListener('touchend', () => { window.__allowPlay = true; }, true);
  window.addEventListener('pointerdown', () => { window.__allowPlay = true; }, true);
  P.play = function () { window.__playCalls++; if (!window.__allowPlay) return Promise.reject(new DOMException('autoplay refused', 'NotAllowedError')); return orig.call(this); }; })();`;

const srv = await startServer(port);
const url = (q = '') => `http://127.0.0.1:${port}/index.html?seed=11${q}`;

async function open(S, init = [], firstRun = false) {
  const g = await openGame(browserName, { w: S.w, h: S.h, mobile: true, tg: fakeTelegram({ fullscreen: true, safe: S.safe, content: S.content, lang: 'ru' }) });
  // the first-launch offer is tested on its own (section 0); the other sections start on the main menu
  await g.page.addInitScript(`try{ if(!sessionStorage.getItem('__kept')){ localStorage.setItem('bvr_lang','ru'); ${firstRun ? '' : "localStorage.setItem('bvr_onboard','1');"} sessionStorage.setItem('__kept','1'); } }catch(e){}`);
  for (const s of init) await g.page.addInitScript(s);
  await g.page.goto(url(), { waitUntil: 'load', timeout: 120000 });
  await g.page.waitForFunction('window.__hk && __hk.menuState', null, { timeout: 30000 });   // (portrait: layer null — the rotate screen)
  await g.page.waitForTimeout(300);
  return g;
}
const MS = (page) => page.evaluate('__hk.menuState()');
async function keys(page, list) { for (const k of list) { await page.keyboard.press(k); await page.waitForTimeout(90); } }
// keyboard: ArrowDown until the focus is on this item (data-act / data-adj / id), then optionally Enter
async function to(page, name, enter = true) {
  for (let i = 0; i < 12 && (await MS(page)).focus !== name; i++) await keys(page, ['ArrowDown']);
  const f = (await MS(page)).focus;
  if (f !== name) fails.push(`keyboard: cannot reach "${name}" (focus ${f}) ` + JSON.stringify(await page.evaluate(`({st:__hk.st(), start:document.getElementById('start').style.display, over:document.getElementById('overscr').style.display, rot:document.getElementById('rotate').style.display, pause:document.getElementById('pausescr').style.display, paused:__hk.paused()})`)));
  if (enter) await keys(page, ['Enter']);
}
async function inMatch(page, what) {
  const r = await page.waitForFunction('__hk.st()==="face" || __hk.st()==="play"', null, { timeout: 60000 }).then(() => true, () => false);
  ok(r, `${what}: the match did not start`);
  return r;
}
async function collect(g, tag) {
  for (const e of g.logs.filter(isError)) fails.push(`${tag} [${e.type}] ${e.text}`);
  for (const e of await g.page.evaluate('__hk.errors()')) fails.push(`${tag} [window] ${e}`);
}

// ---------- 0. first launch: "take the 2-minute training" once; Later → main menu; Start → lesson 1; the 3D menu background
{
  const g = await open(LAND, [], true); const { page } = g;
  try {
    let s = await MS(page);
    ok(s.stack.join() === 'main,welcome' && s.focus === 'wgo', `first launch: offer not shown ${JSON.stringify(s)}`);
    await keys(page, ['ArrowDown', 'Enter']);                      // Later
    s = await MS(page); ok(s.stack.join() === 'main' && s.focus === 'quick', `first launch: Later ${JSON.stringify(s)}`);
    // 3D background: on the high preset it starts ~1.2 s after the menu shows, and stops when a match starts
    await page.evaluate('__hk.q(2,false)'); await page.waitForTimeout(1800);
    ok(await page.evaluate("document.getElementById('start').classList.contains('m3d')"), 'menu: the 3D background did not start on HIGH');
    await page.reload({ waitUntil: 'load' }); await page.waitForFunction('window.__hk && __hk.menuState', null, { timeout: 30000 });
    s = await MS(page); ok(s.stack.join() === 'main', `first launch: the offer comes back after a reload ${JSON.stringify(s)}`);
    await page.evaluate('__hk.start()'); await page.waitForTimeout(400);
    ok(!(await page.evaluate("document.getElementById('start').classList.contains('m3d')")) && (await page.evaluate('__hk.cam.yaw')) === 0, 'match: the 3D background or its camera turn stays');
    await page.evaluate("localStorage.removeItem('bvr_onboard'); sessionStorage.clear()"); await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('window.__hk && __hk.menuState', null, { timeout: 30000 });
    await page.evaluate("localStorage.removeItem('bvr_onboard')");
    if ((await MS(page)).stack.join() === 'main,welcome') {
      await keys(page, ['Enter']);                                 // Start training
      const t = await page.evaluate('__hk.trainState()'); ok(t.on && t.i === 0, `first launch: Start should open lesson 1 ${JSON.stringify({ on: t.on, i: t.i })}`);
    } else fails.push('first launch: the offer did not come back with no saved flag');
    await collect(g, 'first launch');
  } catch (e) { fails.push('first launch: runner error: ' + e.message.split('\n')[0]); } finally { await g.browser.close(); }
}

// ---------- 1. keyboard only
{
  const g = await open(LAND); const { page } = g;
  try {
    let s = await MS(page);
    ok(s.layer === 'menu' && s.stack.join() === 'main' && s.focus === 'quick', `keyboard: start state ${JSON.stringify(s)}`);
    ok(!(await page.evaluate('window.__tgBack.visible')), 'BackButton visible on the main menu');
    await keys(page, ['ArrowDown', 'Enter']);                      // Game mode
    s = await MS(page); ok(s.stack.join() === 'main,mode', `keyboard: Game mode not open: ${JSON.stringify(s)}`);
    ok(await page.evaluate('window.__tgBack.visible'), 'BackButton hidden on a sub-screen');
    await keys(page, ['Enter']);                                   // Vs computer
    s = await MS(page); ok(s.stack.join() === 'main,mode,prep' && s.focus === 'my', `keyboard: setup not open / focus: ${JSON.stringify(s)}`);
    await keys(page, ['ArrowRight']);                              // my team: red → blue
    await keys(page, ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowRight']);   // length 3 → 5
    await keys(page, ['ArrowDown', 'ArrowRight']);                 // tactics: balanced → attack
    s = await MS(page); ok(s.sel.my === 1 && s.sel.min === 5 && s.sel.tac === 1, `keyboard: setup values ${JSON.stringify(s.sel)}`);
    await keys(page, ['ArrowDown']); s = await MS(page); ok(s.focus === 'go', `keyboard: focus should be on Start, is ${s.focus}`);
    await keys(page, ['Enter']);
    if (await inMatch(page, 'keyboard')) {
      const m = await page.evaluate('({min: __hk.menuState().matchMin, t0: __hk.team()[0].id, tac: __hk.tac()[__hk.human()], clock: __hk.clock()})');
      ok(m.min === 5 && m.t0 === 'blue' && m.tac === 1 && m.clock > 290, `keyboard: match settings ${JSON.stringify(m)}`);
      ok(await page.evaluate('window.__tgBack.visible'), 'BackButton hidden in a match against the AI (should open the pause)');
      await page.waitForTimeout(300);
      await keys(page, ['Escape']);
      s = await MS(page); ok(s.layer === 'pause' && s.focus === 'resume', `keyboard: pause ${JSON.stringify(s)}`);
      await keys(page, ['ArrowDown', 'Enter']);                    // Controls
      s = await MS(page); ok(s.layer === 'menu' && s.stack.join() === '@pause,ctrl', `keyboard: Controls from the pause ${JSON.stringify(s)}`);
      await keys(page, ['ArrowRight']);                            // another device tab
      await keys(page, ['Escape']);
      s = await MS(page); ok(s.layer === 'pause' && s.focus === 'pctrl', `keyboard: Esc from Controls should return to the pause, on Controls ${JSON.stringify(s)}`);
      await keys(page, ['ArrowDown', 'Enter']);                    // Settings
      s = await MS(page); ok(s.stack.join() === '@pause,settings', `keyboard: Settings from the pause ${JSON.stringify(s)}`);
      await keys(page, ['Escape', 'ArrowDown', 'Enter']);          // back (on Settings) → Main menu
      s = await MS(page); ok(s.layer === 'menu' && s.stack.join() === 'main' && (await page.evaluate('__hk.st()')) === 'menu', `keyboard: Main menu from the pause ${JSON.stringify(s)}`);
    }
    // Quick match = the setup just played (saved)
    await to(page, 'quick');
    if (await inMatch(page, 'quick match')) {
      const m = await page.evaluate('({min: __hk.menuState().matchMin, t0: __hk.team()[0].id})');
      ok(m.min === 5 && m.t0 === 'blue', `quick match should repeat the saved setup: ${JSON.stringify(m)}`);
      // play it to the end: the result screen by keyboard, then the profile counts the match
      await page.evaluate('__hk.setClock(0.3)');
      await page.waitForFunction('__hk.menuState().layer==="result"', null, { timeout: 20000 }).catch(() => fails.push('keyboard: no result screen'));
      s = await MS(page); ok(s.focus === 'again', `result: focus ${s.focus}`);
      await keys(page, ['ArrowDown', 'Enter']);                    // Main menu
      ok((await page.evaluate('__hk.st()')) === 'menu', 'keyboard: back to the menu from the result');
      await to(page, 'profile');
      s = await MS(page); ok(s.stack.join() === 'main,profile', `keyboard: profile ${JSON.stringify(s)}`);
      const pm = await page.evaluate("document.querySelector('#start .mscr.cur .pst b').textContent");
      ok(pm === '1', `profile: 1 match expected, shows "${pm}"`);
      await keys(page, ['Escape']); await to(page, 'shop');
      s = await MS(page); ok(s.stack.join() === 'main,shop', `keyboard: shop ${JSON.stringify(s)}`);
      await keys(page, ['ArrowRight', 'Escape']);
    }
    // no «Rules» on the main menu: Controls live in Settings, hockey rules — a tab of Training
    ok(!(await page.evaluate("document.querySelector('#start .mscr.cur [data-act=\"rules\"]')")), 'main menu: the Rules item is still there');
    await to(page, 'settings'); await to(page, 'ctrl', false); await keys(page, ['Enter']);
    s = await MS(page); ok(s.stack.join() === 'main,settings,ctrl', `keyboard: Controls from Settings ${JSON.stringify(s)}`);
    await keys(page, ['Escape', 'Escape']);
    await to(page, 'train');
    s = await MS(page); ok(s.stack.join() === 'main,train' && s.focus === 'lesson', `keyboard: Training ${JSON.stringify(s)}`);
    await keys(page, ['KeyE']);
    const rl = await page.evaluate("({n: document.querySelectorAll('#start .mscr.cur [data-act=\"topic\"]').length, card: !!document.querySelector('#start .mscr.cur .mrule svg')})");
    s = await MS(page); ok(rl.n === 6 && rl.card && s.focus === 'topic', `keyboard: the hockey rules tab in Training ${JSON.stringify(rl)} ${JSON.stringify(s)}`);
    await keys(page, ['KeyQ', 'Escape']);
    // Settings: language (Right) and music volume (Left), then reload
    await to(page, 'settings'); await to(page, 'lang', false);   // the screen remembers its focus (Controls, above)
    s = await MS(page); ok(s.stack.join() === 'main,settings' && s.focus === 'lang', `keyboard: Settings ${JSON.stringify(s)}`);
    await keys(page, ['ArrowRight']);                              // ru → en
    const t = await page.evaluate("document.querySelector('#start .mscr.cur .mtitle').textContent");
    ok(/settings/i.test(t), `language switch: title "${t}"`);
    await to(page, 'mus', false); await keys(page, ['ArrowLeft', 'ArrowLeft']);   // music 0.7 → 0.5
    const vol = (await page.evaluate('__hk.music()')).vol;
    ok(Math.abs(vol - 0.5) < 1e-6, `music volume ${vol}`);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('window.__hk && __hk.menuState', null, { timeout: 30000 });
    const after = await page.evaluate("({lang: document.documentElement.lang, item: document.querySelector('#start .mscr.cur .mi').textContent, vol: __hk.music().vol})");
    ok(/quick/i.test(after.item) && Math.abs(after.vol - 0.5) < 1e-6, `settings after reload: ${JSON.stringify(after)}`);
    ok(/1–0–0|0–1–0|0–0–1/.test(await page.evaluate("document.querySelector('#start .mprof').textContent")), 'profile card after reload: the finished match is gone');
    // the language switch on the main menu (last in the focus order): Up from the first item wraps to it
    await to(page, 'lang', false); await keys(page, ['ArrowRight']);   // en → id
    const idItem = await page.evaluate("document.querySelector('#start .mscr.cur .mi').textContent");
    ok(/cepat/i.test(idItem), `main-menu language switch: "${idItem}"`);
    await collect(g, 'keyboard');
  } catch (e) { fails.push('keyboard: runner error: ' + e.message.split('\n')[0]); } finally { await g.browser.close(); }
}

// ---------- 2. gamepad only
{
  const g = await open(LAND, [PAD]); const { page } = g;
  const btn = async (i, ms = 90) => { await page.evaluate(`__pad.buttons[${i}]={pressed:true,value:1}`); await page.waitForTimeout(ms);
    await page.evaluate(`__pad.buttons[${i}]={pressed:false,value:0}`); await page.waitForTimeout(90); };
  try {
    await btn(13); await btn(0);                                   // down, A: Game mode
    await btn(0);                                                  // A: Vs computer
    let s = await MS(page); ok(s.stack.join() === 'main,mode,prep' && s.via === 'pad', `gamepad: setup ${JSON.stringify(s)}`);
    ok((await page.evaluate("document.querySelector('#start .mhints').textContent")).length > 0, 'gamepad: no button hints');
    for (let i = 0; i < 5; i++) await btn(13);                     // to Start
    s = await MS(page); ok(s.focus === 'go', `gamepad: focus ${s.focus}`);
    await btn(0);
    if (await inMatch(page, 'gamepad')) {
      await page.waitForTimeout(300);
      await btn(9);                                                // Start: pause
      s = await MS(page); ok(s.layer === 'pause', `gamepad: Start should pause ${JSON.stringify(s)}`);
      await btn(1);                                                // B: resume
      ok(!(await page.evaluate('__hk.paused()')), 'gamepad: B in the pause should resume');
    }
    await collect(g, 'gamepad');
  } catch (e) { fails.push('gamepad: runner error: ' + e.message.split('\n')[0]); } finally { await g.browser.close(); }
}

// ---------- 3. touch only + Telegram BackButton
{
  const g = await open(LAND); const { page } = g;
  try {
    await page.tap('#start .mscr.cur [data-act="mode"]'); await page.waitForTimeout(150);
    let s = await MS(page); ok(s.stack.join() === 'main,mode', `touch: Game mode ${JSON.stringify(s)}`);
    await page.evaluate('window.__tgBackClick()'); await page.waitForTimeout(150);
    s = await MS(page); ok(s.stack.join() === 'main' && !(await page.evaluate('window.__tgBack.visible')), `BackButton click should go back: ${JSON.stringify(s)}`);
    await page.tap('#start .mscr.cur [data-act="mode"]'); await page.waitForTimeout(150);
    await page.tap('#start .mscr.cur [data-act="vsai"]'); await page.waitForTimeout(150);
    await page.tap('#start .mscr.cur [data-adj="min"] [data-dir="-1"]'); await page.waitForTimeout(150);   // 5 (saved? no: fresh) 3 → 1
    s = await MS(page); ok(s.sel.min === 1, `touch: length arrow ${JSON.stringify(s.sel)}`);
    await page.tap('#go');
    if (await inMatch(page, 'touch')) {
      ok((await page.evaluate('__hk.menuState().matchMin')) === 1, 'touch: 1-minute match');
      await page.waitForTimeout(300);
      await page.evaluate('window.__tgBackClick()'); await page.waitForTimeout(100);
      ok(await page.evaluate('__hk.paused()'), 'BackButton in a match should pause');
      await page.tap('#pResume'); await page.waitForTimeout(150);
      ok(!(await page.evaluate('__hk.paused()')), 'touch: Resume');
      await page.tap('#bPause'); await page.waitForTimeout(150);
      ok(await page.evaluate('__hk.paused()'), 'touch: the pause button');
    }
    await collect(g, 'touch');
  } catch (e) { fails.push('touch: runner error: ' + e.message.split('\n')[0]); } finally { await g.browser.close(); }
}

// ---------- 4. portrait: rotate screen, music; autoplay refused → "tap for sound"
{
  const noPortrait = browserName === 'webkit';   // Playwright's WebKit cannot emulate portrait (see smoke-tg.mjs)
  const g = await open(noPortrait ? LAND : PORT, [NO_AUTOPLAY]); const { page } = g;
  try {
    if (!noPortrait) {
      ok((await page.evaluate("getComputedStyle(document.getElementById('rotate')).display")) === 'flex', 'portrait: no rotate screen');
      ok(/BvR — /.test(await page.evaluate("document.getElementById('rotNp').textContent")), 'portrait: no track line on the rotate screen');
    }
    await page.waitForTimeout(400);
    let m = await page.evaluate('__hk.music()');
    ok(!m.off && m.blocked && !m.playing, `autoplay refused: music should wait for a tap ${JSON.stringify(m)}`);
    const hint = noPortrait ? await page.evaluate("document.getElementById('mnpTx').textContent") : await page.evaluate("getComputedStyle(document.getElementById('rotSnd')).display");
    ok(noPortrait ? /🔊/.test(hint) : hint !== 'none', `"tap for sound" hint not shown (${hint})`);
    await page.tap(noPortrait ? '#start .mscr.cur .mbrand' : '#rotate');
    await page.waitForTimeout(700);
    m = await page.evaluate('__hk.music()');
    ok(!m.blocked && m.playing && /^assets\/dist\/music-|\/assets\/dist\/music-/.test(m.src.replace(/^https?:\/\/[^/]+\//, '')), `after the first tap the music should play ${JSON.stringify(m)}`);
    await page.evaluate('__hk.start()');
    if (await inMatch(page, 'music fade')) {
      await page.waitForTimeout(1300);
      m = await page.evaluate('__hk.music()');
      ok(!m.playing && m.cur === 0, `music should fade out in a match ${JSON.stringify(m)}`);
    }
    await collect(g, 'portrait/music');
  } catch (e) { fails.push('portrait/music: runner error: ' + e.message.split('\n')[0]); } finally { await g.browser.close(); }
}

// ---------- 5. with a friend: the guest sees the host's setup
{
  const rport = +opt('relay', 8797), relay = await startRelay(rport, {});
  const room = 'MNU' + Math.floor(Math.random() * 1e5);
  const side = async () => { const g = await openGame(browserName, { w: LAND.w, h: LAND.h, mobile: true, tg: fakeTelegram({ fullscreen: true, safe: LAND.safe, content: LAND.content, lang: 'ru' }) });
    await g.page.goto(url(`&nomusic&room=${room}&srv=http://127.0.0.1:${rport}`), { waitUntil: 'load', timeout: 120000 }); return g; };
  const H = await side(), G = await side();
  try {
    await H.page.waitForFunction('__hk.net().role==="host" && __hk.net().peer && __hk.menuState().stack.join()==="main,mode,friend,prep"', null, { timeout: 30000 })
      .catch(() => fails.push('friend: the host is not on the match setup after the friend joined'));
    await G.page.waitForFunction('__hk.net().role==="guest" && __hk.menuState().stack.join()==="main,mode,friend,prep"', null, { timeout: 30000 })
      .catch(() => fails.push('friend: the guest is not on the match setup'));
    ok((await G.page.evaluate("document.getElementById('go').disabled")), 'friend: the guest can press Start');
    await H.page.keyboard.press('ArrowRight'); await H.page.waitForTimeout(100);            // host: my team red → blue
    await H.page.keyboard.press('ArrowDown'); await H.page.keyboard.press('ArrowDown'); await H.page.keyboard.press('ArrowRight');   // length 3 → 5 (no difficulty row online)
    const want = await H.page.evaluate('__hk.menuState().sel');
    await G.page.waitForFunction(`(function(){ var s=__hk.menuState().sel; return s.my===${want.my} && s.min===${want.min}; })()`, null, { timeout: 5000 })
      .catch(async () => fails.push(`friend: the guest does not see the host's choice: host ${JSON.stringify(want)}, guest ${JSON.stringify((await G.page.evaluate('__hk.menuState().sel')))}`));
    for (let i = 0; i < 6 && (await MS(H.page)).focus !== 'go'; i++) await H.page.keyboard.press('ArrowDown');
    await H.page.keyboard.press('Enter');
    for (const [who, g] of [['host', H], ['guest', G]]) {
      const r = await g.page.waitForFunction('__hk.st()==="face" || __hk.st()==="play"', null, { timeout: 30000 }).then(() => true, () => false);
      ok(r, `friend: the match did not start for the ${who}`);
      if (r) { const m = await g.page.evaluate('({min: __hk.menuState().matchMin, t0: __hk.team()[0].id})'); ok(m.min === 5 && m.t0 === 'blue', `friend: ${who} match ${JSON.stringify(m)}`); }
    }
    await collect(H, 'friend host'); await collect(G, 'friend guest');
  } catch (e) { fails.push('friend: runner error: ' + e.message.split('\n')[0]); } finally { await H.browser.close(); await G.browser.close(); relay.close(); }
}

srv.close();
if (fails.length) console.log('FAIL:\n  ' + fails.join('\n  '));
console.log(fails.length ? `\nMENU FAIL (${browserName})` : `MENU OK (${browserName})`);
process.exit(fails.length ? 1 : 0);
