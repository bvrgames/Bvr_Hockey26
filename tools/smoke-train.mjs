// Training test (docs/MENU_PLAN.md, stage 5): every lesson is played to "complete" by its input script (TRAIN.bot —
// it drives the player with the same stick and buttons as a person), on frozen time (?frozen + __hk.step: fast and
// reproducible). Lessons with luck in the simulation (goalie saves, the 2-on-1 rush) get up to 3 tries, like a player.
// Also: the result screen, medals saved (CloudStorage + localStorage) and shown in the lesson list after a reload,
// free skate, Pause → Main menu back to the lessons, entering a lesson by keyboard, the tactics buttons by touch,
// and no network at all during the lessons (no WebSocket, no request off this machine).
// usage: node tools/smoke-train.mjs [--browser chromium|webkit]
import { startServer } from './serve.mjs';
import { openGame, fakeTelegram, isError } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const browserName = opt('browser', 'chromium');
const port = +opt('port', 8548);
const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); };
const LIMIT = { skate: 50, pass: 65, lead: 80, lob: 60, shot: 60, poke: 65, switch: 95, goalie: 110, tactic: 95, rush: 90 };

const srv = await startServer(port);
const g = await openGame(browserName, { w: 844, h: 390, mobile: true, tg: fakeTelegram({ fullscreen: true, safe: { left: 47, right: 47, bottom: 21 }, content: { top: 46 } }) });
const { page } = g;
const offsite = [];
page.on('request', (r) => { const u = r.url(); if (!/^http:\/\/127\.0\.0\.1:/.test(u) && !/telegram\.org\/js\//.test(u) && !/^data:/.test(u)) offsite.push(u); });
await page.addInitScript(`(() => { const W = window.WebSocket; window.__ws = 0; window.WebSocket = function (u, p) { window.__ws++; return p ? new W(u, p) : new W(u); };
  window.WebSocket.prototype = W.prototype; })(); try{ localStorage.setItem('bvr_lang','ru'); }catch(e){}`);
try {
  await page.goto(`http://127.0.0.1:${port}/index.html?frozen&seed=21&nomusic`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__hk && __hk.trainState', null, { timeout: 30000 });
  // ---------- every lesson by its bot
  const keys = [];
  for (let i = 0; i < 10; i++) {
    let res = null, st = null, runs = 0;
    for (; runs < 3 && !(res && res.done); runs++) {
      res = null;
      await page.evaluate(`__hk.train(${i}); __hk.trainBot(true)`);
      st = await page.evaluate('__hk.trainState()');
      const lim = LIMIT[st.key] || 100;
      for (let k = 0; k < lim * 4 && !res; k++) { await page.evaluate('__hk.step(250)'); res = (await page.evaluate('__hk.trainState()')).res; }
      if (!res) { fails.push(`lesson ${i + 1} (${st.key}): no result after ${lim} s of play`); break; }
    }
    st = await page.evaluate('__hk.trainState()'); keys.push(st.key);
    ok(res && res.done, `lesson ${i + 1} (${st.key}) not completed by its script in 3 tries: ${JSON.stringify(res)}`);
    console.log(`lesson ${i + 1} ${st.key}: ${res && res.done ? 'complete' : 'NOT complete'}, medal ${res ? res.medal : '-'}, value ${res ? Math.round(res.v * 10) / 10 : '-'}, tries ${runs}`);
    const lay = await page.evaluate("({over: document.getElementById('overscr').style.display, layer: __hk.menuState().layer, next: getComputedStyle(document.getElementById('oNext')).display})");
    ok(lay.over === 'flex' && lay.layer === 'result', `lesson ${i + 1}: no result screen ${JSON.stringify(lay)}`);
    if (res && res.done && i < 9) ok(lay.next !== 'none', `lesson ${i + 1}: no "Next lesson" on the result screen`);
    if (res && res.done) ok((st.prog.l[st.key] || {}).m >= 1, `lesson ${i + 1}: medal not saved ${JSON.stringify(st.prog.l[st.key])}`);
  }
  // ---------- free skate; Pause → Main menu → back to the lesson list
  await page.evaluate('__hk.train(10)'); await page.evaluate('__hk.step(3000)');
  let st = await page.evaluate('__hk.trainState()');
  ok(st.on && st.key === 'free' && !st.res, `free skate: ${JSON.stringify({ on: st.on, key: st.key, res: st.res })}`);
  await page.keyboard.press('Escape'); await page.evaluate('__hk.step(100)');
  let ms = await page.evaluate('__hk.menuState()'); ok(ms.layer === 'pause', `free skate: Esc should pause (${ms.layer})`);
  await page.evaluate("document.getElementById('pMenu').click()"); await page.evaluate('__hk.step(100)');
  ms = await page.evaluate('__hk.menuState()'); st = await page.evaluate('__hk.trainState()');
  ok(ms.stack.join() === 'main,train' && !st.on, `Main menu from a lesson should open the lesson list: ${JSON.stringify(ms.stack)} on=${st.on}`);
  ok(!(await page.evaluate("document.body.classList.contains('training')")), 'the lesson screen stays after leaving');
  // ---------- tactics by touch (lesson 9)
  await page.evaluate('__hk.train(8)'); await page.evaluate('__hk.step(500)');
  await page.tap('#ltac [data-tac="2"]'); await page.evaluate('__hk.step(50)');
  ok((await page.evaluate('__hk.tac()[__hk.human()]')) === 2, 'tactics button (touch) did not switch to Defence');
  await page.evaluate("__hk.menu('main')");
  // ---------- network: none during the lessons
  ok((await page.evaluate('window.__ws')) === 0, `training opened ${await page.evaluate('window.__ws')} WebSocket(s)`);
  ok(offsite.length === 0, `requests off this machine during training: ${offsite.slice(0, 3).join(' ')}`);
  // ---------- medals survive a reload; the list shows them; keyboard into a lesson
  await page.goto(`http://127.0.0.1:${port}/index.html?frozen&seed=21&nomusic`, { waitUntil: 'load' });
  await page.waitForFunction('window.__hk && __hk.trainState', null, { timeout: 30000 });
  st = await page.evaluate('__hk.trainState()');
  ok(st.medals >= 10, `medals after reload: ${st.medals}`);
  await page.evaluate("__hk.menu('train')"); await page.evaluate('__hk.step(50)');
  const doneRows = await page.evaluate("document.querySelectorAll('#start .mscr.cur .mles .mi.ok').length");
  ok(doneRows === 10, `lesson list after reload: ${doneRows} lessons marked complete`);
  await page.evaluate("__hk.menu('main')"); await page.evaluate('__hk.step(50)');
  for (let k = 0; k < 8 && (await page.evaluate('__hk.menuState().focus')) !== 'train'; k++) { await page.keyboard.press('ArrowDown'); await page.evaluate('__hk.step(20)'); }
  await page.keyboard.press('Enter'); await page.evaluate('__hk.step(20)');
  ms = await page.evaluate('__hk.menuState()'); ok(ms.stack.join() === 'main,train' && ms.focus === 'lesson', `keyboard: Training ${JSON.stringify(ms)}`);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await page.evaluate('__hk.step(100)');
  st = await page.evaluate('__hk.trainState()'); ok(st.on && st.i === 1, `keyboard: lesson 2 should start, got ${JSON.stringify({ on: st.on, i: st.i })}`);
  for (const e of g.logs.filter(isError)) fails.push(`[${e.type}] ${e.text}`);
  for (const e of await page.evaluate('__hk.errors()')) fails.push(`[window] ${e}`);
} catch (e) {
  fails.push('runner error: ' + e.message.split('\n')[0]);
} finally {
  await g.browser.close(); srv.close();
}
if (fails.length) console.log('FAIL:\n  ' + fails.join('\n  '));
console.log(fails.length ? `\nTRAIN FAIL (${browserName})` : `TRAIN OK (${browserName})`);
process.exit(fails.length ? 1 : 0);
