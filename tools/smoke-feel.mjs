// Game feel (phase F): shot / hit / post / goal effects switch on and fade back to nothing, «Less shake» drops the punch
// and the edge flash, «low» quality has no particles, and the effects never call Math.random (in single play the
// simulation uses it, so a visual-only call would shift the match — npm run balance would catch it).
// Frozen match (?frozen + __hk.step), events through __hk.fxTest (real bus events), effects alone through __hk.fxRaw
// (fading is run on the effects alone, so a real hit in the autopilot match can't interfere).
// usage: node tools/smoke-feel.mjs [--browser chromium|webkit]
import { startServer } from './serve.mjs';
import { openGame, isError } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const port = +opt('port', 8503);
// the quality differs in the hash only — `&lv` makes every load a real navigation, not a same-page hash change
const url = (q) => `http://127.0.0.1:${port}/index.html?autostart=120&autopilot&seed=3&frozen&lv=${q.slice(-1)}${q}`;
const srv = await startServer(port);
const g = await openGame(opt('browser', 'chromium'), { w: 844, h: 390 });
const { page } = g;
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };
const S = () => page.evaluate('__hk.fxState()');
const quiet = (s) => !s.trauma && !s.zoom && !s.streak && !s.parts && !s.edge && !s.ring;
const load = async (q) => {
  await page.goto(url(q), { waitUntil: 'load' });
  await page.waitForFunction('window.__hk && __hk.match().id', null, { timeout: 60000 });
  await page.evaluate('__hk.fx(null, false); __hk.step(3000)');
};

try {
  // 1. every event switches its effects on, and 1.5 s later nothing is left
  await load('#q2');
  const want = {
    shot: (s) => s.zoom > 0 && s.streak > 0 && s.parts > 0,
    hit: (s) => s.trauma >= 0.8 && s.parts > 0 && s.edge > 0 && !s.pulse,
    post: (s) => s.trauma >= 0.6 && s.parts > 0 && s.ring,
    goal: (s) => s.trauma >= 0.8 && s.parts > 0 && s.edge > 1 && s.pulse,
  };
  for (const k of Object.keys(want)) {
    const s = await page.evaluate(`__hk.fxTest('${k}')`);
    ok(want[k](s), `${k}: effects did not switch on ${JSON.stringify(s)}`);
    const s2 = await page.evaluate(`__hk.fxRaw('fade', 90)`);   // effects alone: a real hit in the match can't interfere
    ok(quiet(s2), `${k}: effects did not fade out in 1.5 s ${JSON.stringify(s2)}`);
  }
  ok(await page.evaluate(`document.getElementById('s1').classList.contains('pop') || document.getElementById('s2').classList.contains('pop')`),
    'goal: the score digit did not pop');

  // 2. no Math.random in the effects: the effect code itself (with 30 frames of fading), and a rendered frame with
  //    effects on draws exactly as many random numbers as one without (FX.old burns them only for hits and posts)
  const rnd = await page.evaluate(`(function(){
    var n=0, R=Math.random; Math.random=function(){ n++; return R(); };
    try{
      var out={raw:{}};
      ['shot','hit','post','goal'].forEach(function(k){ n=0; __hk.fxRaw(k, 30); out.raw[k]=n; });
      __hk.fxRaw('reset'); n=0; __hk.benchGpu(4); out.base=n;
      __hk.fxRaw('shot'); __hk.fxRaw('goal'); n=0; __hk.benchGpu(4); out.fx=n;
      return out;
    } finally { Math.random=R; }
  })()`);
  for (const k of Object.keys(rnd.raw)) ok(rnd.raw[k] === 0, `${k}: effects called Math.random ${rnd.raw[k]} times`);
  ok(rnd.fx === rnd.base, `a frame with effects calls Math.random ${rnd.fx} times, without — ${rnd.base}`);

  // 3. «Less shake»: no camera punch, no edge flash, shake ×0.25
  await page.evaluate(`__hk.fxRaw('reset'); __hk.fx(null, true)`);
  const ls = await page.evaluate(`__hk.fxTest('shot')`);
  ok(ls.zoom === 0 && ls.less, `less shake: the shot still punches the camera ${JSON.stringify(ls)}`);
  await page.evaluate(`__hk.fxRaw('reset')`);
  const lh = await page.evaluate(`__hk.fxTest('hit')`);
  ok(lh.edge === 0 && lh.trauma > 0, `less shake: the hit still flashes the edges ${JSON.stringify(lh)}`);
  await page.evaluate('__hk.fx(null, false)');

  // 4. «low»: no particles, no ring, no streak — shake, punch and flashes stay
  await load('#q0');
  const lp = await page.evaluate(`__hk.fxTest('post')`);
  ok(lp.parts === 0 && !lp.ring && lp.trauma > 0, `low: post has particles ${JSON.stringify(lp)}`);
  await page.evaluate(`__hk.fxRaw('reset')`);
  const lsh = await page.evaluate(`__hk.fxTest('shot')`);
  ok(lsh.parts === 0 && lsh.streak === 0 && lsh.zoom > 0, `low: shot ${JSON.stringify(lsh)}`);
  await page.evaluate(`__hk.fxRaw('reset')`);
  const lg = await page.evaluate(`__hk.fxTest('goal')`);
  ok(lg.parts === 0 && lg.edge > 1, `low: goal ${JSON.stringify(lg)}`);

  for (const e of g.logs.filter(isError)) fails.push(`[${e.type}] ${e.text}`);
  for (const e of await page.evaluate('__hk.errors()')) fails.push(`[window] ${e}`);
} catch (e) {
  fails.push('runner error: ' + e.message.split('\n')[0]);
} finally {
  await g.browser.close();
  srv.close();
}
if (fails.length) console.log('\nFAIL:\n  ' + fails.join('\n  '));
console.log(fails.length ? 'FEEL FAIL' : 'FEEL OK');
process.exit(fails.length ? 1 : 0);
