// Screenshots of off-puck support and the through pass (tools/offball.mjs, scenario 'zone', in the real game):
// the player's centre has the puck in the attacking zone against a set defence and skates slowly to the half-wall;
// the partners look for space for 1 s (shot 1 — with the hint markers over the Y and A receivers), then Y: shot 2 — 0.35 s after the
// pass (the receiver's run), shot 3 — 0.8 s after it. Frozen game, frame by frame, the same seeds every run.
// usage: node tools/offball-shots.mjs [out-dir=shots/offball] [--prefix after] [--seeds 3,7,12] [--browser chromium]
import { mkdirSync } from 'node:fs';
import { startServer } from './serve.mjs';
import { openGame, isError } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : 'shots/offball';
const prefix = opt('prefix', 'after');
const seeds = opt('seeds', '3,7,12').split(',').map(Number);
const port = +opt('port', 8502);
mkdirSync(out, { recursive: true });

// the same placement as tools/offball.mjs 'zone' (scenario numbers from its own generator)
const SETUP = `(function(seed){
  var a=(seed*7919+13)>>>0, rnd=function(){ a|=0; a=(a+0x6d2b79f5)|0; var r=Math.imul(a^(a>>>15),1|a);
    r=(r+Math.imul(r^(r>>>7),61|r))^r; return ((r^(r>>>14))>>>0)/4294967296; }, rr=function(x,y){ return x+rnd()*(y-x); };
  var S=__hk.sim(), H=__hk.human(), ad=S.attackDir(H);
  S.placeFaceoff(ad*rr(10,12), rr(-5,5)); S.state='play';
  var mine=S.teamOf(H), me=mine.filter(function(p){ return p.role===1; })[0];
  S.teamOf(1-H).forEach(function(p){ p.x+=5*ad; });
  mine.forEach(function(p){ if(p.role!==1) p.x=ad>0 ? Math.min(p.x, S.BLUE_X+0.5) : Math.max(p.x, -S.BLUE_X-0.5); });
  me.x=ad*rr(10.5,12.5); me.z=rr(-4,4);
  S.puck.owner=me; S.lastTouch=me; S.HS[H].ctrl=me;
})`;
const frames = (page, n) => page.evaluate(`(function(){ for(var i=0;i<${n};i++) __hk.step(1000/60); })()`);

const srv = await startServer(port);
const g = await openGame(opt('browser', 'chromium'), { w: 1280, h: 720 });
const { page } = g;
let bad = 0;
try {
  for (const seed of seeds) {
    await page.goto(`http://127.0.0.1:${port}/index.html?autostart=180&seed=${seed}&frozen&nomusic#q1`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction('window.__hk && __hk.match().id', null, { timeout: 60000 });
    await frames(page, 100);                                 // faceoff → play
    await page.evaluate(`${SETUP}(${seed})`);
    // high camera over the attacking zone: the whole five and the defence in one frame
    await page.evaluate(`__hk.camLock({x:__hk.ad()*15, y:17, z:-17, pitch:0.78, yaw:0})`);
    await frames(page, 60);
    const shot = async (name) => { const f = `${out}/${prefix}-s${seed}-${name}.png`; await page.screenshot({ path: f }); console.log('shot', f); };
    const owner = await page.evaluate('__hk.puck.owner===__hk.ctrl()');
    await shot('1-carry');
    if (!owner) { console.log(`seed ${seed}: the puck was lost before the pass`); continue; }
    await page.evaluate(`(function(){ __hk.press('Y'); __hk.step(1000/60); })()`);
    await new Promise((r) => setTimeout(r, 120));          // __hk.press lets go of Y after 60 ms of real time
    await frames(page, 20); await shot('2-run');
    await frames(page, 27); await shot('3-after');
  }
  const errs = g.logs.filter(isError);
  if (errs.length) { bad = 1; console.log('page errors:', errs.slice(0, 3)); }
} finally { await g.browser.close(); srv.close(); }
process.exit(bad);
