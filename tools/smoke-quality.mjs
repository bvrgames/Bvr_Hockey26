// Graphics quality (phase E): start-up choice by device, dynamic resolution before preset changes, the player's
// manual choice survives a reload and is not overridden, #q in the link wins and is not saved. Prints the decisions of
// the device auto-choice on typical devices. Last step — in real time: a match on HIGH with AUTO where the high preset
// costs +20 ms a frame (a weak phone GPU, ~45 fps); the real frame clock must bring it down to MEDIUM in about 10 s.
// usage: node tools/smoke-quality.mjs [--browser chromium|webkit]
import { startServer } from './serve.mjs';
import { openGame, isError } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const port = +opt('port', 8501);
const url = (q = '') => `http://127.0.0.1:${port}/index.html${q}`;
const srv = await startServer(port);
const g = await openGame(opt('browser', 'chromium'), { w: 1280, h: 720 });
const { page } = g;
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };
const Q = () => page.evaluate('__hk.qInfo()');
const load = async (q) => { await page.goto(url(q), { waitUntil: 'load' }); await page.waitForFunction('window.__hk'); };

try {
  // 1. no saved choice, no #q → device auto-choice
  await load('?menu');
  let q = await Q();
  ok(q.src === 'device' && q.auto && q.guess, `start: expected device auto-choice, got ${JSON.stringify(q)}`);
  console.log(`this machine: level ${q.level} — ${q.guess && q.guess.reason} (GPU "${q.info && q.info.gpu}")`);

  // 2. dynamic resolution first, preset second (simulated fps; 0.5 s per tick). Target: steady 60 fps.
  await page.evaluate('__hk.q(2,true); __hk.qReset()');
  const cw0 = (await page.evaluate('__hk.wh()')).cvw;
  let r = await page.evaluate('__hk.qTickSim(52, 2)');
  const cw1 = (await page.evaluate('__hk.wh()')).cvw;
  ok(cw1 < cw0, `dynamic resolution must shrink the canvas: ${cw0} → ${cw1}`);
  ok(r.level === 2 && r.dyn < 1, `52 fps: resolution should drop first (level 2 kept), got ${JSON.stringify(r)}`);
  r = await page.evaluate('__hk.qTickSim(52, 6)');
  ok(r.level === 2 && Math.abs(r.dyn - 0.75) < 1e-6, `52 fps: resolution should bottom out at 0.75 before the preset drops, got ${JSON.stringify(r)}`);
  r = await page.evaluate('__hk.qTickSim(52, 5)');
  ok(r.level === 2, `under 55 fps at min resolution for 2.5 s: preset must hold, got ${JSON.stringify(r)}`);
  r = await page.evaluate('__hk.qTickSim(52, 1)');
  ok(r.level === 1, `under 55 fps at min resolution for 3 s: preset should drop to 1, got ${JSON.stringify(r)}`);
  r = await page.evaluate('__hk.qTickSim(60, 60)');
  ok(r.dyn === 1 && r.level === 1, `60 fps after the drop: resolution back to 1, level 2 stays banned, got ${JSON.stringify(r)}`);
  r = await page.evaluate('__hk.qTickSim(60, 1200)');
  ok(r.level === 1 && r.dyn === 1, `a level that failed once is banned for the session (10 minutes at 60 fps), got ${JSON.stringify(r)}`);
  r = await page.evaluate('__hk.qTickSim(56, 30)');
  ok(r.level === 1 && r.dyn === 1, `56 fps is inside the hysteresis band (55–58): nothing should change, got ${JSON.stringify(r)}`);
  r = await page.evaluate('__hk.qTickSim(30, 60)');
  ok(r.level === 0, `very slow: down to 0, got ${JSON.stringify(r)}`);
  r = await page.evaluate('__hk.qTickSim(30, 30)');
  ok(r.level === 0 && Math.abs(r.dyn - 0.75) < 1e-6, `level 0 is the floor, got ${JSON.stringify(r)}`);
  await page.evaluate('__hk.qReset()');

  // 3. manual choice: saved, survives reload, not touched by auto-adjust
  await page.evaluate('document.querySelectorAll("#qT .chip")[1].click()');   // LOW
  await load('?menu');
  q = await Q();
  ok(q.src === 'saved' && q.level === 0 && !q.auto, `manual LOW after reload: got ${JSON.stringify(q)}`);
  r = await page.evaluate('__hk.qTickSim(20, 30)');
  ok(r.level === 0 && r.dyn === 1, `manual choice must not be auto-adjusted, got ${JSON.stringify(r)}`);
  ok((await page.evaluate('localStorage.getItem("bvr_quality")')) === '0', 'manual choice not in localStorage');

  // 4. #q wins over the saved choice and is not saved
  await load('?menu&fresh=1#q2');                           // a real reload (a hash-only change would not reload)
  q = await Q();
  ok(q.src === 'url' && q.level === 2 && !q.auto, `#q2: got ${JSON.stringify(q)}`);
  ok((await page.evaluate('localStorage.getItem("bvr_quality")')) === '0', '#q2 must not overwrite the saved choice');

  // 5. back to AUTO → saved as auto, next start uses the device choice again
  await load('?menu');
  await page.evaluate('document.querySelectorAll("#qT .chip")[0].click()');
  await load('?menu');
  q = await Q();
  ok(q.src === 'device' && q.auto, `AUTO after reload: got ${JSON.stringify(q)}`);

  // 6. decisions on typical devices
  const devices = [
    ['iPhone SE (1st gen), Telegram iOS', { platform: 'ios', ua: 'iPhone', touch: true, dpr: 2, sw: 320, sh: 568, gpu: 'Apple GPU' }],
    ['iPhone 8 / SE 2-3, Telegram iOS', { platform: 'ios', ua: 'iPhone', touch: true, dpr: 2, sw: 375, sh: 667, gpu: 'Apple GPU' }],
    ['iPhone 13 / 14 / 15, Telegram iOS', { platform: 'ios', ua: 'iPhone', touch: true, dpr: 3, sw: 390, sh: 844, gpu: 'Apple GPU' }],
    ['iPhone 15 Pro Max, Telegram iOS', { platform: 'ios', ua: 'iPhone', touch: true, dpr: 3, sw: 430, sh: 932, gpu: 'Apple GPU' }],
    ['iPad Air, Telegram iOS', { platform: 'ios', ua: 'Macintosh', touch: true, dpr: 2, sw: 820, sh: 1180, gpu: 'Apple GPU' }],
    ['Samsung A12 (Helio P35, 3 GB)', { platform: 'android', ua: 'Android', touch: true, dpr: 2, sw: 360, sh: 800, cores: 8, mem: 3, gpu: 'PowerVR Rogue GE8320' }],
    ['Xiaomi Redmi 9 (Mali-G52, 4 GB)', { platform: 'android', ua: 'Android', touch: true, dpr: 2.75, sw: 393, sh: 851, cores: 8, mem: 4, gpu: 'Mali-G52 MC2' }],
    ['Samsung A54 (Mali-G68, 8 GB)', { platform: 'android', ua: 'Android', touch: true, dpr: 2.625, sw: 412, sh: 915, cores: 8, mem: 8, gpu: 'Mali-G68' }],
    ['Pixel 7 (Mali-G710)', { platform: 'android', ua: 'Android', touch: true, dpr: 2.625, sw: 412, sh: 915, cores: 8, mem: 8, gpu: 'Mali-G710' }],
    ['Galaxy S23 (Adreno 740)', { platform: 'android', ua: 'Android', touch: true, dpr: 3, sw: 360, sh: 780, cores: 8, mem: 8, gpu: 'Adreno (TM) 740' }],
    ['old Android 4 cores (Adreno 308)', { platform: 'android', ua: 'Android', touch: true, dpr: 1.5, sw: 360, sh: 640, cores: 4, mem: 2, gpu: 'Adreno (TM) 308' }],
    ['Telegram Desktop, Windows (RTX)', { platform: 'tdesktop', ua: 'Windows', touch: false, dpr: 1, sw: 1920, sh: 1080, cores: 12, gpu: 'ANGLE (NVIDIA GeForce RTX 3060)' }],
    ['MacBook Air M1, browser', { platform: '', ua: 'Macintosh', touch: false, dpr: 2, sw: 1440, sh: 900, cores: 8, gpu: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1)' }],
    ['old laptop (Intel HD Graphics 520)', { platform: '', ua: 'Windows', touch: false, dpr: 1, sw: 1366, sh: 768, cores: 4, gpu: 'ANGLE (Intel, Intel(R) HD Graphics 520 Direct3D11)' }],
    ['VM / no GPU (SwiftShader)', { platform: '', ua: 'Linux', touch: false, dpr: 1, sw: 1280, sh: 720, cores: 2, gpu: 'Google SwiftShader' }],
  ];
  const names = ['LOW', 'MEDIUM', 'HIGH'];
  console.log('\nautochoice on typical devices (start level; auto-adjust refines it within seconds):');
  for (const [n, d] of devices) {
    const gq = await page.evaluate((d) => __hk.qGuessFor(d), d);
    console.log(`  ${n.padEnd(38)} → ${names[gq.level].padEnd(6)} ${gq.reason}`);
  }

  // 7. real time, real frame clock (RT.ms → qualityTick): a weak GPU that cannot hold 55 fps on HIGH at any resolution
  await page.addInitScript(`(function(){ var r=window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame=function(cb){ return r(function(t){ var b=(window.__hk && __hk.qInfo().level===2)?20:0, s=performance.now();
      while(performance.now()-s<b){} cb(t); }); }; })()`);
  await load('?autostart=600&autopilot');
  await page.waitForFunction('__hk.st()!=="menu"');
  await page.evaluate('__hk.q(2,true); __hk.qReset()');
  const t0 = Date.now(), line = []; let prev = '', tDown = 0, fpsHigh = 0;
  while (Date.now() - t0 < 26000) {
    const s = await page.evaluate('(function(){var q=__hk.qInfo();return {l:q.level,d:q.dyn,f:Math.round(q.fps)}})()');
    const t = (Date.now() - t0) / 1000;
    if (s.l === 2 && t > 2) fpsHigh = s.f;
    if (s.l + '/' + s.d !== prev) { prev = s.l + '/' + s.d; line.push(`${t.toFixed(1)} s q${s.l}×${s.d}`); }
    if (s.l < 2 && !tDown) tDown = t;
    await page.waitForTimeout(100);
  }
  q = await Q();
  console.log(`\nreal time, HIGH at ~${fpsHigh} fps with AUTO: ${line.join(' → ')}`);
  ok(fpsHigh > 0 && fpsHigh < 55, `the slow-HIGH model did not slow the game down (fps ${fpsHigh})`);
  ok(tDown > 0, 'AUTO never left HIGH in 26 s at under 55 fps');
  ok(!tDown || (tDown > 5 && tDown < 13), `HIGH → MEDIUM took ${tDown.toFixed(1)} s (expected about 9–10: 2 s warm-up, 4 resolution steps, 3 s under 55 fps)`);
  ok(q.level === 1 && q.fps > 55, `after the drop: expected MEDIUM at full speed, got level ${q.level}, ${q.fps} fps`);
  console.log(`  HIGH → MEDIUM after ${tDown.toFixed(1)} s; then ${q.fps} fps on MEDIUM, resolution ×${q.dyn}`);

  for (const e of g.logs.filter(isError)) fails.push(`[${e.type}] ${e.text}`);
  for (const e of await page.evaluate('__hk.errors()')) fails.push(`[window] ${e}`);
} catch (e) {
  fails.push('runner error: ' + e.message.split('\n')[0]);
} finally {
  await g.browser.close();
  srv.close();
}
if (fails.length) console.log('\nFAIL:\n  ' + fails.join('\n  '));
console.log(fails.length ? 'QUALITY FAIL' : '\nQUALITY OK');
process.exit(fails.length ? 1 : 0);
