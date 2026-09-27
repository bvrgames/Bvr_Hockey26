// Smoke test: boot the game in headless Chromium and WebKit, let the autopilot play, check that the match really runs,
// and fail on any console error / page error / failed request. Pattern after INKWAVE's tools/smoke.sh (Jayden Davis,
// MIT — see THIRD_PARTY.md).
//
// usage: node tools/smoke.mjs [--browser chromium|webkit|all] [--real 12] [--step 10] [--query "#q1"] [--inject "js"] [--headed]
//   --real   seconds of real-time autopilot play (checks rendering + fps)
//   --step   seconds of deterministic simulation via __hk.freeze()/step() (independent of the machine's fps)
//   --inject JS run in the page right after boot (self-test: --inject "console.error('boom')" must make the smoke fail)
// Exit code 0 = SMOKE OK, 1 = SMOKE FAIL. Screenshots land in shots/smoke-<browser>.png.
import { mkdirSync } from 'node:fs';
import { startServer } from './serve.mjs';
import { openGame, isError } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const which = opt('browser', 'all');
const browsers = which === 'all' ? ['chromium', 'webkit'] : which.split(',');
const REAL = +opt('real', 12), STEP = +opt('step', 10);
const port = +opt('port', 8492);
const query = `?autostart=180&autopilot&seed=7${opt('query', '')}`;

const srv = await startServer(port);
mkdirSync('shots', { recursive: true });
let failed = false;

for (const name of browsers) {
  const fails = [];
  const t0 = Date.now();
  let g;
  try {
    g = await openGame(name, { headed: args.includes('--headed') });
    const { page } = g;
    await page.goto(`http://127.0.0.1:${port}/index.html${query}`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction('window.__hk && __hk.st()==="play"', null, { timeout: 60000, polling: 200 })
      .catch(() => fails.push('match never reached state "play"'));
    const boot = await page.evaluate('__hk.snap()');
    if (!boot.gl) fails.push('WebGL2 init failed: ' + boot.initErr);
    if (!boot.skin) fails.push('skinned player models did not load');
    if (!boot.autopilot) fails.push('autopilot is off');
    if (opt('inject')) await page.evaluate(opt('inject'));

    // ---- real-time play: rendering, fps, puck actually moves
    let path = 0, prev = boot.puck, minFps = 999;
    for (let i = 0; i < REAL; i++) {
      await page.waitForTimeout(1000);
      const s = await page.evaluate('__hk.snap()');
      path += Math.hypot(s.puck.x - prev.x, s.puck.z - prev.z); prev = s.puck;
      if (i >= 2) minFps = Math.min(minFps, s.fps);   // the first seconds include shader warm-up
    }
    const real = await page.evaluate('__hk.snap()');
    if (!(boot.clock - real.clock > REAL * 0.5)) fails.push(`clock barely moved in real time (${boot.clock} → ${real.clock}) — fps too low?`);
    if (path < 5) fails.push(`puck hardly moved (${path.toFixed(1)} m in ${REAL} s)`);
    await page.screenshot({ path: `shots/smoke-${name}.png` });

    // ---- deterministic stepping: freeze, advance STEP seconds at a fixed 60 Hz, unfreeze
    await page.evaluate('__hk.freeze()');
    const f0 = await page.evaluate('__hk.snap()');
    const frames = await page.evaluate(`__hk.step(${STEP * 1000})`);
    const f1 = await page.evaluate('__hk.snap()');
    await page.evaluate('__hk.unfreeze()');
    const dClock = f0.clock - f1.clock;
    if (frames !== Math.round(STEP * 60)) fails.push(`step ran ${frames} frames, expected ${Math.round(STEP * 60)}`);
    // the clock stops during goal celebrations and faceoffs start, so allow slack but not "nothing happened"
    if (!(dClock > STEP * 0.5 && dClock <= STEP + 0.05)) fails.push(`step(${STEP}s) moved the clock by ${dClock.toFixed(2)} s`);
    await page.waitForTimeout(500);
    const end = await page.evaluate('__hk.snap()');
    if (end.shots + end.passes === 0) fails.push('no shot or pass in the whole run — AI is stuck?');
    // match statistics are built only from bus events, so they must agree with the game state
    const st = end.stats || {};
    const sum = (k) => (st[k] ? st[k][0] + st[k][1] : 0);
    if (!st.events) fails.push('no game events on the bus');
    if (!(st.faceoffs >= 1)) fails.push('no faceoff event');
    if (st.goals && (st.goals[0] !== end.score[0] || st.goals[1] !== end.score[1])) fails.push(`goal events ${st.goals} ≠ score ${end.score}`);
    if (sum('passesDone') > sum('passes')) fails.push('more completed passes than passes');
    for (const t of [0, 1]) if (st.sog && (st.sog[t] > st.shots[t] || st.sog[t] < st.saves[1 - t]))
      fails.push(`team ${t}: shots ${st.shots[t]} / on goal ${st.sog[t]} / opponent saves ${st.saves[1 - t]} don't add up`);

    const errs = g.logs.filter(isError);
    for (const e of errs) fails.push(`[${e.type}] ${e.text}`);
    for (const e of await page.evaluate('__hk.errors()')) if (!errs.some((x) => x.text.includes(e))) fails.push(`[window] ${e}`);
    const warns = [...new Set(g.logs.filter((l) => l.type === 'warning').map((l) => l.text.slice(0, 140)))];

    console.log(`\n[${name}] ${((Date.now() - t0) / 1000).toFixed(1)} s · state ${end.state} · clock ${end.clock} · score ${end.score.join(':')}` +
      ` · q${end.q} · min fps ${minFps === 999 ? '?' : minFps} · puck path ${path.toFixed(0)} m · shots ${end.shots} · passes ${end.passes}` +
      ` · step ${frames} frames = ${dClock.toFixed(2)} s`);
    const row = (k) => `${k} ${st[k] ? st[k].join(':') : '-'}`;
    console.log('  stats: ' + ['shots', 'sog', 'goals', 'passes', 'passesDone', 'saves', 'hits', 'pokes', 'takeaways', 'penalties', 'posts'].map(row).join(' · ') +
      ` · faceoffs ${st.faceoffs} · events ${st.events}`);
    if (warns.length) console.log(`  warnings (${warns.length}):\n    ` + warns.join('\n    '));
  } catch (e) {
    fails.push('runner error: ' + e.message.split('\n')[0]);
  } finally {
    if (g) await g.browser.close();
  }
  if (fails.length) { failed = true; console.log(`  FAIL:\n    ` + fails.join('\n    ')); }
  else console.log('  ok');
}

srv.close();
console.log(failed ? '\nSMOKE FAIL' : '\nSMOKE OK');
process.exit(failed ? 1 : 0);
