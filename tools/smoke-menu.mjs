// Menu test (docs/MENU_PLAN.md, stage 2) in a fake full-screen Telegram, landscape phone.
//   · keyboard only: main → Vs computer → setup (team, 5 min, tactics; saved at once) → Start → the match runs with them;
//     Esc → pause → Controls → back → Settings → back → Main menu; Quick match starts with the saved setup;
//     Settings: language and music volume change and survive a reload
//   · gamepad only (fake navigator.getGamepads): D-pad + A to a match, Start → pause, B → resume
//   · touch only (tap): Vs computer → kit swatches (the rival's kit is taken) → length → Start; the pause button → Resume
//   · Telegram BackButton: shown on sub-screens, hidden on the main menu, its click goes back; in a match — pause
//   · with a friend (relay-mock, server mode): the host lands on the match setup when the friend joins, the guest sees
//     the host's teams and length change before the start; the host's keyboard Start begins the match for both
//   · Settings → Controls; Training → the hockey rules tab; no Rules on the main menu
//   · portrait: the rotate screen with the track line; menu music plays; with autoplay refused — no "tap for sound"
//     button or hint, the first tap anywhere starts it; the music fades out when a match starts
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
    await keys(page, ['ArrowDown', 'Enter', 'Enter']);             // Game modes → Vs computer
    s = await MS(page); ok(s.stack.join() === 'main,modes,prep' && s.focus === 'home', `keyboard: team select not open / focus: ${JSON.stringify(s)}`);
    ok(await page.evaluate('window.__tgBack.visible'), 'BackButton hidden on a sub-screen');
    // kits: nation*2 + kit (0 bright, 1 alternate): rus 0/1, can 2/3 (red/black), usa 4/5 (navy/white), blr 12 (green);
    // only the same colour never meets (red/red, white/white), different colours do (navy/black, green/black)
    ok(await page.evaluate('__hk.kitFit(0, 2) === 1 && __hk.kitFit(1, 2) === 1 && __hk.kitClash(1, 5) && !__hk.kitClash(4, 3) && !__hk.kitClash(12, 3)'),
      'keyboard: kit rule (red/red, white/white clash; navy/black, green/black do not)');
    // team select (as in NHL): ↑↓ — the nation in the active card, ←→ (Q/E) — the card; the player plays for the active card
    await keys(page, ['ArrowDown']);                               // home (mine): Russia → Canada, the bright kit at home
    s = await MS(page); ok(s.sel.side === 0 && s.sel.my === 2 && s.sel.op === 3, `keyboard: home nation ${JSON.stringify(s.sel)}`);
    await keys(page, ['ArrowRight']);                              // the away card: the player moves with it, the teams stay
    s = await MS(page); ok(s.focus === 'away' && s.sel.side === 1 && s.sel.my === 3 && s.sel.op === 2, `keyboard: side follows the card ${JSON.stringify(s)}`);
    await keys(page, ['ArrowDown']);                               // away (mine now): Canada → USA, the white kit away
    s = await MS(page); ok(s.sel.side === 1 && s.sel.my === 5 && s.sel.op === 2, `keyboard: away nation ${JSON.stringify(s.sel)}`);
    await keys(page, ['KeyQ']);                                    // Q: the home card, the player goes back home
    s = await MS(page); ok(s.focus === 'home' && s.sel.side === 0 && s.sel.my === 2 && s.sel.op === 5, `keyboard: side back ${JSON.stringify(s)}`);
    await keys(page, ['Enter']);                                   // Next: the kits
    s = await MS(page); ok(s.stack.join() === 'main,modes,prep,kits' && s.focus === 'home', `keyboard: Next → kits ${JSON.stringify(s)}`);
    await keys(page, ['ArrowDown']);                               // home: Canada red → black
    s = await MS(page); ok(s.sel.my === 3 && s.sel.op === 5, `keyboard: home kit ${JSON.stringify(s.sel)}`);
    await keys(page, ['ArrowRight', 'ArrowDown']);                 // away: USA white → navy, next to Canada's black — a different colour
    s = await MS(page); ok(s.focus === 'away' && s.sel.my === 4 && s.sel.op === 3, `keyboard: navy next to black is allowed ${JSON.stringify(s)}`);
    await keys(page, ['KeyQ', 'Enter']);                           // back home, Next: match settings
    s = await MS(page); ok(s.stack.join() === 'main,modes,prep,kits,setup' && s.focus === 'diff' && s.sel.my === 3, `keyboard: Next ${JSON.stringify(s)}`);
    await keys(page, ['ArrowDown', 'ArrowRight']);                 // length 3 → 5
    await keys(page, ['ArrowDown', 'ArrowRight']);                 // tactics: balanced → attack
    s = await MS(page); ok(s.sel.my === 3 && s.sel.min === 5 && s.sel.tac === 1, `keyboard: setup values ${JSON.stringify(s.sel)}`);
    // the choice is saved at once: Back and in again — the same setup
    await keys(page, ['Escape']); s = await MS(page); ok(s.stack.join() === 'main,modes,prep,kits', `keyboard: Back from the settings ${JSON.stringify(s)}`);
    await keys(page, ['Escape', 'Escape']); await to(page, 'vsai');
    s = await MS(page); ok(s.stack.join() === 'main,modes,prep' && s.sel.my === 3 && s.sel.op === 4 && s.sel.min === 5 && s.sel.tac === 1, `keyboard: the setup is not remembered ${JSON.stringify(s)}`);
    await keys(page, ['Enter']);
    await keys(page, ['Enter']);
    await to(page, 'tac', false);                                 // the screen keeps its focus
    await keys(page, ['ArrowDown']); s = await MS(page); ok(s.focus === 'go', `keyboard: focus should be on Start, is ${s.focus}`);
    await keys(page, ['Enter']);
    if (await inMatch(page, 'keyboard')) {
      const m = await page.evaluate('({min: __hk.menuState().matchMin, t0: __hk.team()[0].id, k0: __hk.team()[0].k, tac: __hk.tac()[__hk.human()], clock: __hk.clock()})');
      ok(m.min === 5 && m.t0 === 'can' && m.k0 === 1 && m.tac === 1 && m.clock > 290, `keyboard: match settings ${JSON.stringify(m)}`);
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
      const m = await page.evaluate('({min: __hk.menuState().matchMin, t0: __hk.team()[0].id, k0: __hk.team()[0].k})');
      ok(m.min === 5 && m.t0 === 'can' && m.k0 === 1, `quick match should repeat the saved setup: ${JSON.stringify(m)}`);
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
    await btn(13); await btn(0); await btn(0);                     // down, A: Game modes, A: Vs computer
    let s = await MS(page); ok(s.stack.join() === 'main,modes,prep' && s.via === 'pad', `gamepad: setup ${JSON.stringify(s)}`);
    ok((await page.evaluate("document.querySelector('#start .mhints').textContent")).length > 0, 'gamepad: no button hints');
    const g0 = s.sel;
    await btn(13);                                                 // down: the next team in my card
    await btn(15); await btn(5);                                   // right: the away card, the player moves with it; RB: stays there
    s = await MS(page); ok(s.focus === 'away' && s.sel.side === 1 && s.sel.op !== g0.my && s.sel.my === g0.op, `gamepad: team select ${JSON.stringify(s)} from ${JSON.stringify(g0)}`);
    await btn(0); await btn(0);                                    // A: Next (kits), A: Next
    s = await MS(page); ok(s.stack.join() === 'main,modes,prep,kits,setup', `gamepad: A should open the match settings ${JSON.stringify(s)}`);
    for (let i = 0; i < 3; i++) await btn(13);                     // to Start
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
    await page.tap('#start .mscr.cur [data-act="modes"]'); await page.waitForTimeout(150);
    await page.tap('#start .mscr.cur [data-act="vsai"]'); await page.waitForTimeout(150);
    let s = await MS(page); ok(s.stack.join() === 'main,modes,prep', `touch: Vs computer ${JSON.stringify(s)}`);
    await page.evaluate('window.__tgBackClick()'); await page.waitForTimeout(150);
    s = await MS(page); ok(s.stack.join() === 'main,modes', `BackButton click should go back: ${JSON.stringify(s)}`);
    await page.tap('#start .mscr.cur [data-act="vsai"]'); await page.waitForTimeout(150);
    // ▼ under a card — the next nation; a tap on the card selects it (the player moves there); a swipe up — the next nation
    const sel0 = (await MS(page)).sel, nt = (c) => c >> 1, nx = (c) => (nt(c) + 1) % 8;
    await page.tap('#start .mscr.cur .mtar.dn[data-for="home"]'); await page.waitForTimeout(150);
    s = await MS(page); ok(nt(s.sel.my) === nx(sel0.my) && s.sel.op === sel0.op, `touch: ▼ on my card ${JSON.stringify(s.sel)} from ${JSON.stringify(sel0)}`);
    const sel1 = s.sel;
    await page.tap('#start .mscr.cur [data-adj="away"] .cpos'); await page.waitForTimeout(150);
    s = await MS(page); ok(s.focus === 'away' && s.sel.side === 1 && s.sel.my === sel1.op && s.sel.op === sel1.my, `touch: a tap on the card selects it, the player moves there ${JSON.stringify(s)}`);
    const sel1b = s.sel;
    const box = await page.locator('#start .mscr.cur [data-adj="away"]').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy + 30); await page.mouse.down();
    for (let k = 1; k <= 6; k++) { await page.mouse.move(cx, cy + 30 - k * 9); await page.waitForTimeout(16); }   // 54 px up: one step
    await page.mouse.up(); await page.waitForTimeout(150);
    s = await MS(page); ok(nt(s.sel.my) === nx(sel1b.my) && s.sel.op === sel1b.op, `touch: swipe up on the away card ${JSON.stringify(s.sel)} from ${JSON.stringify(sel1b)}`);
    const sel2 = s.sel;
    await page.tap('#start .mscr.cur [data-adj="home"] .cpos'); await page.waitForTimeout(150);
    s = await MS(page); ok(s.sel.side === 0 && s.sel.my === sel2.op && s.sel.op === sel2.my, `touch: back to the home card ${JSON.stringify(s.sel)} from ${JSON.stringify(sel2)}`);
    await page.tap('#start .mscr.cur [data-act="next"]'); await page.waitForTimeout(150);
    s = await MS(page); ok(s.stack.join() === 'main,modes,prep,kits' && await page.evaluate("document.querySelectorAll('#start .mscr.cur .ckimg').length === 2"), `touch: Next → kits (pictures) ${JSON.stringify(s)}`);
    await page.tap('#start .mscr.cur [data-act="next"]'); await page.waitForTimeout(150);
    s = await MS(page); ok(s.stack.join() === 'main,modes,prep,kits,setup', `touch: Next ${JSON.stringify(s)}`);
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

// ---------- 4. portrait: rotate screen, music; autoplay refused → the first tap starts it (no button)
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
    // no «tap for sound» button or hint: the first tap anywhere starts the music
    const hint = await page.evaluate("({rot: !!document.getElementById('rotSnd'), np: document.getElementById('mnpTx').textContent})");
    ok(!hint.rot && !/🔊/.test(hint.np), `a "tap for sound" hint is still shown ${JSON.stringify(hint)}`);
    await page.tap(noPortrait ? '#start .mscr.cur .mbrand' : '#rotate');
    await page.waitForTimeout(700);
    m = await page.evaluate('__hk.music()');
    // iPhone silent switch: the audio session is «playback» where the browser has the API (Safari / WKWebView 16.4+)
    ok((m.session === 'none' || m.session === 'playback') && m.ac === 'running', `audio session / context after the tap ${JSON.stringify(m)}`);
    console.log(`note: audio session ${m.session}, AudioContext ${m.ac}`);
    ok(!m.blocked && m.playing && /^assets\/dist\/music-|\/assets\/dist\/music-/.test(m.src.replace(/^https?:\/\/[^/]+\//, '')), `after the first tap the music should play ${JSON.stringify(m)}`);
    // match sounds: every recording (assets/dist/sfx-*.m4a) decodes, the crowd plays the recording instead of the synth
    let s = null;
    for (let i = 0; i < 40; i++) { s = await page.evaluate('__hk.sfx()'); if (s.want && s.ready.length === s.want && s.crowd) break; await page.waitForTimeout(200); }
    ok(s.want >= 12 && s.ready.length === s.want && !Object.keys(s.err).length && s.crowd && !s.synthCrowd, `match sounds should load from the recordings ${JSON.stringify(s)}`);
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
    await H.page.waitForFunction('__hk.net().role==="host" && __hk.net().peer && __hk.menuState().stack.join()==="main,modes,friend,prep"', null, { timeout: 30000 })
      .catch(() => fails.push('friend: the host is not on the match setup after the friend joined'));
    await G.page.waitForFunction('__hk.net().role==="guest" && __hk.menuState().stack.join()==="main,modes,friend,prep"', null, { timeout: 30000 })
      .catch(() => fails.push('friend: the guest is not on the match setup'));
    ok((await G.page.evaluate("document.getElementById('go').disabled")), 'friend: the guest can press Start');
    ok((await MS(H.page)).focus === 'home' && (await MS(G.page)).focus === 'away', 'friend: the host edits the home card, the guest the away card');
    await H.page.keyboard.press('ArrowDown'); await H.page.waitForTimeout(300);              // host: home Russia → Canada (red)
    await G.page.keyboard.press('ArrowDown'); await G.page.waitForTimeout(100);              // guest: its own Canada → USA (white)
    await H.page.waitForFunction('__hk.menuState().sel.my===2 && __hk.menuState().sel.op===5', null, { timeout: 5000 })
      .catch(async () => fails.push(`friend: the host does not get the guest's team ${JSON.stringify((await H.page.evaluate('__hk.menuState().sel')))}`));
    await H.page.keyboard.press('Enter'); await H.page.waitForTimeout(100);                 // Next: kits
    await H.page.keyboard.press('Enter'); await H.page.waitForTimeout(100);                 // Next: settings
    await H.page.keyboard.press('ArrowRight');                                               // length 3 → 5 (no difficulty row online)
    const want = await H.page.evaluate('__hk.menuState().sel');
    await G.page.waitForFunction(`(function(){ var s=__hk.menuState().sel; return s.my===${want.my} && s.op===${want.op} && s.min===${want.min}; })()`, null, { timeout: 5000 })
      .catch(async () => fails.push(`friend: the guest does not see the host's choice: host ${JSON.stringify(want)}, guest ${JSON.stringify((await G.page.evaluate('__hk.menuState().sel')))}`));
    for (let i = 0; i < 6 && (await MS(H.page)).focus !== 'go'; i++) await H.page.keyboard.press('ArrowDown');
    await H.page.keyboard.press('Enter');
    for (const [who, g] of [['host', H], ['guest', G]]) {
      const r = await g.page.waitForFunction('__hk.st()==="face" || __hk.st()==="play"', null, { timeout: 30000 }).then(() => true, () => false);
      ok(r, `friend: the match did not start for the ${who}`);
      if (r) { const m = await g.page.evaluate('({min: __hk.menuState().matchMin, t0: __hk.team()[0].id, t1: __hk.team()[1].id, k0: __hk.team()[0].k, k1: __hk.team()[1].k})'); ok(m.min === 5 && m.t0 === 'can' && m.t1 === 'usa' && m.k0 === 0 && m.k1 === 1, `friend: ${who} match ${JSON.stringify(m)}`); }
    }
    await collect(H, 'friend host'); await collect(G, 'friend guest');
  } catch (e) { fails.push('friend: runner error: ' + e.message.split('\n')[0]); } finally { await H.browser.close(); await G.browser.close(); relay.close(); }
}

srv.close();
if (fails.length) console.log('FAIL:\n  ' + fails.join('\n  '));
console.log(fails.length ? `\nMENU FAIL (${browserName})` : `MENU OK (${browserName})`);
process.exit(fails.length ? 1 : 0);
