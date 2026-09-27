// AI balance report: N full matches on autopilot (team 0 = the player's team driven by the AI at "normal", team 1 = the
// CPU opponent at --ai level), each from a different seed, fully deterministic (?frozen + __hk.step). Prints the average
// match statistics from bus events plus a breakdown of where the shots came from.
// usage: node tools/balance.mjs [--seeds 5] [--seed0 1] [--len 180] [--ai easy|normal|hard] [--side 0|1] [--browser chromium|webkit] [--json out.json]
import { writeFileSync } from 'node:fs';
import { startServer } from './serve.mjs';
import { openGame, isError } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const N = +opt('seeds', 5), SEED0 = +opt('seed0', 1), LEN = +opt('len', 180), AI = opt('ai', 'normal'), SIDE = +opt('side', 0);
const port = +opt('port', 8495);
const CHUNK = 0.5;   // s of simulation between samples (possession / zone time)

// installed in the page before the first simulated frame: logs every bus event with the match clock
const LOGGER = `window.__log=[]; __hk.ev.on('*', function(e,n){ __log.push([n, __hk.clock(), JSON.parse(JSON.stringify(e))]); });`;
// possession sample: [owner team or -1, is the puck in that team's attacking zone]
const SAMPLE = `(function(){ var o=__hk.puck.owner, p=__hk.p; if(!o||__hk.st()!=='play') return [-1,0];
  var dir=o.dir, bx=o.team===0?1:-1; return [o.team, (__hk.puck.x*dir>8.8)?1:0]; })()`;

function analyse(log, samples) {
  const T = [0, 1].map(() => ({ slot: 0, lead: 0, rebound: 0, far: 0, dist: 0, n: 0, zone: 0, own: 0, leadPass: 0, leadDone: 0 }));
  let lastLead = {}, lastSave = [-99, -99], lastN = '';
  for (const [n, clock, e] of log) {
    if (n === 'pass' && e.lead) T[e.t].leadPass++;
    if (n === 'faceoff') T.fo = (T.fo || 0) + 1;
    if (n === 'pickup' && lastN === 'faceoff') T[e.t].foWon = (T[e.t].foWon || 0) + 1;
    lastN = n;
    if (n === 'pass:recv' && e.lead) { lastLead[e.p] = clock; T[e.t].leadDone++; }
    if (n === 'save' && e.shot) lastSave[e.t] = clock;
    if (n !== 'shot') continue;
    const t = T[e.t];
    t.n++; t.dist += e.dist;
    if (e.dist < 10 && Math.abs(e.z) < 4.5) t.slot++;
    if (e.dist >= 15) t.far++;
    if (lastLead[e.p] !== undefined && lastLead[e.p] - clock < 1.5) t.lead++;          // clock counts down
    if (lastSave[1 - e.t] - clock < 2.5 && lastSave[1 - e.t] >= clock) t.rebound++;
  }
  for (const [team, zone] of samples) if (team >= 0) { T[team].own += CHUNK; if (zone) T[team].zone += CHUNK; }
  return T;
}

const srv = await startServer(port);
const g = await openGame(opt('browser', 'chromium'));
const runs = [];
try {
  for (let i = 0; i < N; i++) {
    const seed = SEED0 + i;
    const page = await g.context.newPage();
    await page.route(/telegram\.org\/js\/telegram-web-app\.js/, (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await page.goto(`http://127.0.0.1:${port}/index.html?autostart=${LEN}&autopilot&seed=${seed}&frozen&ai=${AI}&side=${SIDE}${opt('extra','')}#q0`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction('window.__hk && __hk.match().id', null, { timeout: 60000 });
    await page.evaluate(LOGGER);
    const samples = [];
    const steps = Math.ceil((LEN + 40) / CHUNK);
    for (let k = 0; k < steps; k++) {
      await page.evaluate(`__hk.step(${CHUNK * 1000})`);
      samples.push(await page.evaluate(SAMPLE));
      if (k % 20 === 0 && (await page.evaluate('__hk.st()')) === 'over') break;
    }
    const sum = await page.evaluate('__hk.match().summary');
    const log = await page.evaluate('__log');
    errs.push(...(await page.evaluate('__hk.errors()')));
    await page.close();
    if (!sum) { console.log(`seed ${seed}: match did not finish`); continue; }
    const shots = analyse(log, samples);
    runs.push({ seed, sum, shots, errs, stops: log.filter((l) => l[0] === 'stoppage').map((l) => [l[2].reason, l[2].t]), raw: log.filter((l) => ['shot', 'pickup', 'pass', 'pass:recv', 'poke', 'hit', 'faceoff'].includes(l[0])) });
    const tm = sum.teams;
    console.log(`seed ${seed}: ${sum.score.join(':')} · shots ${tm[0].shots}:${tm[1].shots} · sog ${tm[0].sog}:${tm[1].sog} · passes ${tm[0].passesDone}/${tm[0].passes} ${tm[1].passesDone}/${tm[1].passes}` +
      (errs.length ? ` · ERRORS ${errs.length}: ${errs[0]}` : ''));
  }
} finally {
  await g.browser.close();
  srv.close();
}

if (!runs.length) process.exit(1);
const avg = (f) => [0, 1].map((t) => runs.reduce((a, r) => a + f(r, t), 0) / runs.length);
const pct = (a, b) => [0, 1].map((t) => (b[t] ? (100 * a[t]) / b[t] : 0));
const S = (k) => avg((r, t) => r.sum.teams[t][k]);
const X = (k) => avg((r, t) => r.shots[t][k] || 0);
const shots = S('shots'), sog = S('sog'), goals = S('goals'), passes = S('passes'), done = S('passesDone');
const zone = X('zone'), own = X('own');
const rows = [
  ['броски', shots, (v) => v.toFixed(1), '6–10'],
  ['в створ', sog, (v) => v.toFixed(1), ''],
  ['в створ, %', pct(sog, shots), (v) => v.toFixed(0) + '%', '> 50%'],
  ['голы', goals, (v) => v.toFixed(2), ''],
  ['сейвы вратаря', S('saves'), (v) => v.toFixed(1), ''],
  ['пасы', passes, (v) => v.toFixed(1), ''],
  ['точность пасов', pct(done, passes), (v) => v.toFixed(0) + '%', '60–75%'],
  ['пасы в разрез', X('leadPass'), (v) => v.toFixed(1), ''],
  ['— из них дошли', X('leadDone'), (v) => v.toFixed(1), ''],
  ['выиграно вбрасываний', X('foWon'), (v) => v.toFixed(1), ''],
  ['силовые', S('hits'), (v) => v.toFixed(1), ''],
  ['отборы', S('takeaways'), (v) => v.toFixed(1), ''],
  ['— из слота', X('slot'), (v) => v.toFixed(1), ''],
  ['— после паса в разрез', X('lead'), (v) => v.toFixed(1), ''],
  ['— добивание', X('rebound'), (v) => v.toFixed(1), ''],
  ['— издалека (≥ 15 м)', X('far'), (v) => v.toFixed(1), ''],
  ['средняя дистанция броска, м', avg((r, t) => (r.shots[t].n ? r.shots[t].dist / r.shots[t].n : 0)), (v) => v.toFixed(1), ''],
  ['владение, с', own, (v) => v.toFixed(0), ''],
  ['в зоне атаки с шайбой, с', zone, (v) => v.toFixed(0), ''],
  ['с в зоне атаки на бросок', [0, 1].map((t) => (shots[t] ? zone[t] / shots[t] : zone[t])), (v) => v.toFixed(1), 'меньше'],
];
console.log(`\nсредние за ${runs.length} матч(ей) по ${LEN} с · команда ${SIDE} = автопилот (normal), команда ${1 - SIDE} = ИИ соперника (${AI})`);
console.log('показатель'.padEnd(32) + 'кома. 0'.padStart(9) + 'кома. 1'.padStart(9) + '   цель');
for (const [name, v, f, goal] of rows) console.log(name.padEnd(32) + f(v[0]).padStart(9) + f(v[1]).padStart(9) + '   ' + goal);
const nErr = runs.reduce((a, r) => a + r.errs.length, 0);
if (nErr) console.log(`\nERRORS: ${nErr}`);
if (opt('json')) writeFileSync(opt('json'), JSON.stringify(runs, null, 1));
process.exit(nErr ? 1 : 0);
