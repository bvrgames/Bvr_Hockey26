// shared/sim.js outside the browser: full seeded AI-vs-AI matches in Node.js. Checks that the module runs without DOM,
// that the same seed gives the same match (determinism — the server and a future Colyseus port rely on it), and prints
// the score and event counts. The browser balance (npm run balance) stays the reference for AI numbers.
// usage: node tools/sim-node.mjs [--seeds 3] [--len 180]
import BVRSim from '../shared/sim.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? +args[i + 1] : d; };
const N = opt('seeds', 3), LEN = opt('len', 180);
const mulberry = (s) => { let a = s >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let r = Math.imul(a ^ (a >>> 15), 1 | a);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; };

function match(seed) {
  const ev = {}, log = [];
  const S = BVRSim.create({ random: mulberry(seed), emit: (n, e) => { ev[n] = (ev[n] || 0) + 1; log.push(n); return e; } });
  S.setControl({ tick: [true, false], hum: [false, false], inp: [S.NOIN, S.NOIN], edge: [S.NOEDGE, S.NOEDGE] });
  S.reset(true); S.clock = LEN; S.state = 'face'; S.stateT = 1.4; S.placeFaceoff(0, 0);
  let n = 0; const t0 = performance.now();
  while (S.state !== 'over' && n < LEN * 70) { S.step(1 / 60); n++; }
  const P = S.players.map((p) => [p.x, p.z].map((v) => v.toFixed(4)).join(',')).join(';');
  return { score: S.score.slice(), ev, steps: n, ms: performance.now() - t0, sig: log.length + '|' + P, over: S.state === 'over' };
}

const fails = [];
for (let s = 1; s <= N; s++) {
  const a = match(s), b = match(s);
  if (!a.over) fails.push(`seed ${s}: match did not end`);
  if (a.sig !== b.sig) fails.push(`seed ${s}: not deterministic`);
  console.log(`seed ${s}: ${a.score.join(':')} · ${a.steps} steps in ${a.ms.toFixed(0)} ms (${(a.ms / a.steps * 1000).toFixed(1)} µs/step) · ` +
    ['shot', 'save', 'goal', 'pass', 'hit', 'poke', 'stoppage'].map((k) => `${k} ${a.ev[k] || 0}`).join(' · '));
}
if (fails.length) console.log('FAIL:\n  ' + fails.join('\n  '));
console.log(fails.length ? 'SIM NODE FAIL' : 'SIM NODE OK');
process.exit(fails.length ? 1 : 0);
