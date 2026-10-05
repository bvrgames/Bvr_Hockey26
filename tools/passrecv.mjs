// Pass reception, measured on shared/sim.js in Node.js (the same simulation as the browser and the server room).
// Three scenarios, N seeds each (the same seed — the same episode):
//   'pass'  — the player (team 0, "human" control driven by a script) holds the puck somewhere on the ice, aims at a
//             random partner and passes with A, then lets the stick go (as players do). Did the partner take it?
//   'face'  — a faceoff that the player wins by mashing A (the bot taps at its own rate). The puck goes to the chosen
//             partner (by default the nearest defenceman). Who takes it first: the addressee, another partner, the rival?
//   'match' — the AI against the AI for 3 minutes ('normal'): what share of the passes reaches a partner.
// usage: node tools/passrecv.mjs [--seeds 60] [--seed0 1] [--mode pass|face|match] [--lv easy|normal|hard] [--json out.json] [--verbose]
import { writeFileSync } from 'node:fs';
import BVRSim from '../shared/sim.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const N = +opt('seeds', 60), SEED0 = +opt('seed0', 1), LV = opt('lv', 'normal'), VERBOSE = args.includes('--verbose');
const mulberry = (s) => { let a = s >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let r = Math.imul(a ^ (a >>> 15), 1 | a);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; };
const DT = 1 / 60;

function make(seed, hum) {
  const ev = [];
  const S = BVRSim.create({ random: mulberry(seed), emit: (n, e) => { ev.push([n, S.SIMT, e]); return e; } });
  const IN = { mx: 0, mz: 0, _A: false, _B: false, _X: false, _Y: false, RT: false, _LB: false };
  const ED = { A: false, B: false, X: false, Y: false, LB: false };
  S.setControl({ tick: [hum, false], hum: [hum, false], inp: [hum ? IN : S.NOIN, S.NOIN], edge: [hum ? ED : S.NOEDGE, S.NOEDGE], lv: [LV, LV] });
  S.reset(true); S.clock = 180;
  return { S, IN, ED, ev, sc: mulberry(seed * 7919 + 13) };
}

// who picked the puck up first after event index k0 (team, player index), or null
function firstPick(ev, k0) {
  for (let k = k0; k < ev.length; k++) { const [n, , e] = ev[k]; if (n === 'pickup') return e; if (n === 'stoppage') return { stop: e.reason }; }
  return null;
}

export function passEp(seed) {
  const { S, IN, ED, ev, sc } = make(seed, true), rr = (a, b) => a + sc() * (b - a);
  S.state = 'play';
  S.placeFaceoff(rr(-14, 14), rr(-6, 6));
  const mine = S.teamOf(0).filter((p) => !p.goalie), me = mine[Math.floor(sc() * mine.length)];
  S.puck.owner = me; S.lastTouch = me; S.HS[0].ctrl = me;
  // a moment of play before the pass: everybody moves (the AI), the carrier glides
  const wait = rr(0.4, 1.4); let t = 0;
  while (t < wait) { IN.mx = 0; IN.mz = 0; S.step(DT); t += DT; if (S.puck.owner !== me) return { seed, outcome: 'lost-before' }; }
  const mates = mine.filter((p) => p !== me), to = mates[Math.floor(sc() * mates.length)];
  const dx = to.x - me.x, dz = to.z - me.z, L = Math.hypot(dx, dz) || 1;
  S.HS[0].aimX = dx / L; S.HS[0].aimZ = dz / L;
  const k0 = ev.length; ED.A = true; S.step(DT); ED.A = false;
  const pe = ev.slice(k0).find(([n]) => n === 'pass'); if (!pe) return { seed, outcome: 'no-pass' };
  const r = { seed, outcome: 'missed', dist: +L.toFixed(1), aimedTo: S.players.indexOf(to), to: pe[2].to };
  for (t = 0; t < 3; t += DT) {
    IN.mx = 0; IN.mz = 0;                           // the stick is let go after the pass
    S.step(DT);
    const f = firstPick(ev, k0 + 1);
    if (f) {
      if (f.stop) r.outcome = 'whistle';
      else if (f.t === 0) { r.outcome = f.p === r.to ? 'received' : 'mate'; r.at = +t.toFixed(2); }
      else r.outcome = 'intercepted';
      break;
    }
  }
  return r;
}

export function faceEp(seed) {
  const { S, IN, ED, ev, sc } = make(seed, true), rr = (a, b) => a + sc() * (b - a);
  const spots = [[0, 0], [20, 7], [20, -7], [-20, 7], [-20, -7], [6.5, 7], [-6.5, -7]], sp = spots[Math.floor(sc() * spots.length)];
  S.state = 'face'; S.stateT = 0.5; S.placeFaceoff(sp[0], sp[1]);
  const r = { seed, spot: sp, outcome: 'none', win: -1 };
  let t = 0, k0 = -1, tap = 0;
  while (t < 12) {
    // the player mashes A ~7 times a second after the drop
    ED.A = false;
    if (S.state === 'face' && S.FO.ph === 3) { tap += DT; if (tap >= 1 / 7) { tap = 0; ED.A = true; } }
    IN.mx = 0; IN.mz = 0;
    S.step(DT); t += DT;
    if (k0 < 0) { const fe = ev.findIndex(([n]) => n === 'faceoff'); if (fe >= 0) { k0 = fe; r.win = ev[fe][2].w; r.to = ev[fe][2].to; r.taps = ev[fe][2].taps; } continue; }
    if (t > 0 && ev.length > k0) {
      const f = firstPick(ev, k0 + 1);
      if (f) {
        if (f.stop) r.outcome = 'whistle';
        else if (f.t === r.win) r.outcome = f.p === r.to ? 'addressee' : 'mate';
        else r.outcome = 'rival';
        r.at = +(S.SIMT - ev[k0][1]).toFixed(2);
        break;
      }
    }
  }
  return r;
}

export function matchEp(seed) {
  const { S, ev } = make(seed, false);
  S.state = 'face'; S.stateT = 1;
  const r = { seed, pass: [0, 0], recv: [0, 0], faceW: [0, 0], faceTo: [0, 0] };
  for (let t = 0; t < 180 && S.state !== 'over'; t += DT) S.step(DT);
  let lastFace = null;
  for (const [n, , e] of ev) {
    if (n === 'pass') r.pass[e.t]++;
    if (n === 'pass:recv') r.recv[e.t]++;
    if (n === 'faceoff') { r.faceW[e.w]++; lastFace = e; }
    else if (lastFace && n === 'pickup') { if (e.p === lastFace.to) r.faceTo[lastFace.w]++; lastFace = null; }
    else if (lastFace && n === 'stoppage') lastFace = null;
  }
  return r;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = {};
  const pct = (a, b) => (b ? (100 * a / b).toFixed(0) + ' %' : '—');
  for (const mode of (opt('mode', '') ? [opt('mode', '')] : ['pass', 'face', 'match'])) {
    const runs = [];
    for (let i = 0; i < (mode === 'match' ? Math.max(4, Math.round(N / 10)) : N); i++) {
      const r = (mode === 'pass' ? passEp : mode === 'face' ? faceEp : matchEp)(SEED0 + i);
      runs.push(r); if (VERBOSE) console.log(mode, JSON.stringify(r));
    }
    const cnt = (k) => runs.filter((r) => r.outcome === k).length;
    if (mode === 'pass') {
      const n = runs.filter((r) => r.outcome !== 'lost-before' && r.outcome !== 'no-pass').length;
      out.pass = { n, received: cnt('received'), mate: cnt('mate'), intercepted: cnt('intercepted'), missed: cnt('missed'), whistle: cnt('whistle') };
      console.log(`A pass, stick let go (${LV}): ${n} passes — taken by the addressee ${pct(cnt('received'), n)}, by another partner ${pct(cnt('mate'), n)}, ` +
        `intercepted ${pct(cnt('intercepted'), n)}, nobody took it in 3 s ${pct(cnt('missed'), n)}, whistle ${pct(cnt('whistle'), n)}`);
    } else if (mode === 'face') {
      const won = runs.filter((r) => r.win === 0), n = won.length, c = (k) => won.filter((r) => r.outcome === k).length;
      const taps = won.concat(runs.filter((r) => r.win === 1)).map((r) => r.taps).filter(Boolean);
      const bot = taps.length ? (taps.reduce((a, t) => a + t[1], 0) / taps.length).toFixed(1) : '—';
      out.face = { n: runs.length, won: n, addressee: c('addressee'), mate: c('mate'), rival: c('rival'), none: c('none'), whistle: c('whistle'), botTaps: +bot };
      console.log(`faceoff (${LV}): the player won ${n}/${runs.length} (bot taps per window ${bot}, the player ~10); after a won one the puck goes to ` +
        `the addressee ${pct(c('addressee'), n)}, another partner ${pct(c('mate'), n)}, the rival ${pct(c('rival'), n)}, nobody ${pct(c('none'), n)}`);
    } else {
      const s = (f) => runs.reduce((a, r) => a + f(r), 0);
      const P = s((r) => r.pass[0] + r.pass[1]), R = s((r) => r.recv[0] + r.recv[1]), F = s((r) => r.faceW[0] + r.faceW[1]), FT = s((r) => r.faceTo[0] + r.faceTo[1]);
      out.match = { matches: runs.length, passes: P, received: R, faceoffs: F, faceToAddressee: FT };
      console.log(`AI vs AI (${LV}, ${runs.length} × 3 min): ${P} passes, reached a partner ${pct(R, P)}; ${F} faceoffs, the addressee took the puck ${pct(FT, F)}`);
    }
  }
  if (opt('json', '')) writeFileSync(opt('json', ''), JSON.stringify(out, null, 1));
}
