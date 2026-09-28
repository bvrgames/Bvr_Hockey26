// Deterministic pose screenshots for the secondary-animation (springs) work: the human player is driven by script
// (no autopilot) from a frozen start, frame by frame with rendering, and captured at the same moments every run:
// acceleration, braking, a 90° turn, right after a shot.
// usage: node tools/pose-shots.mjs <out-dir> [--prefix before] [--browser chromium] [--query "#q2"]
import { mkdirSync } from 'node:fs';
import { startServer } from './serve.mjs';
import { openGame, isError } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const out = args[0] || 'shots/springs';
const prefix = opt('prefix', 'after');
const port = +opt('port', 8500);
mkdirSync(out, { recursive: true });

const srv = await startServer(port);
const g = await openGame(opt('browser', 'chromium'), { w: 1280, h: 720 });
const { page } = g;
const frames = (n) => page.evaluate(`(function(){ for(var i=0;i<${n};i++) __hk.step(1000/60); })()`);   // render every frame
const shot = async (name) => {
  // side camera close to the controlled player (lean / bank / stick read best from the side), one rendered frame,
  // then hand the camera back to the game
  await page.evaluate(`(function(){ var c=__hk.ctrl(); __hk.camLock({x:c.x, y:1.55, z:c.z-4.6, pitch:0.15, yaw:0}); __hk.step(1000/60); })()`);
  await page.screenshot({ path: `${out}/${prefix}-${name}.png`, clip: { x: 340, y: 110, width: 600, height: 500 } });
  await page.evaluate('__hk.camLock(null)');
  console.log('shot', `${out}/${prefix}-${name}.png`);
};
try {
  await page.goto(`http://127.0.0.1:${port}/index.html?autostart=120&seed=4&frozen${opt('query', '#q2')}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__hk && __hk.match().id', null, { timeout: 60000 });
  await frames(100);                                      // faceoff → play
  // 1. acceleration from standstill
  await page.evaluate('__hk.move(1,0)'); await frames(22); await shot('1-accel');
  // 2. braking: full speed, then let go of the stick
  await frames(60); await page.evaluate('__hk.move(0,0)'); await frames(14); await shot('2-brake');
  // 3. turn: skate, then push the stick 90° to the side
  await page.evaluate('__hk.move(1,0)'); await frames(60); await page.evaluate('__hk.move(0,-1)'); await frames(18); await shot('3-turn');
  // 4. shot: give the controlled player the puck, hold B (charge), release, capture just after the release
  await page.evaluate('__hk.move(0.4,0); __hk.puck.owner=__hk.ctrl(); __hk.press("B")'); await frames(20);
  await new Promise((r) => setTimeout(r, 120));           // __hk.press releases B after 60 ms of real time
  await frames(26); await shot('4-after-shot');
  const errs = g.logs.filter(isError).map((l) => l.text).concat(await page.evaluate('__hk.errors()'));
  if (errs.length) { console.log('ERRORS:\n  ' + errs.join('\n  ')); process.exitCode = 1; }
} finally {
  await g.browser.close();
  srv.close();
}
