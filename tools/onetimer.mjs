// Shot of the player (SHOT_CFG in shared/sim.js), measured on the simulation in Node.js, N seeds each:
//   'ot'     — attack with the puck in the offensive half: a through pass (Y), B tapped 0.1 s later while the puck
//              flies (stick to the far corner). Was there a one-timer on reception, its share of goals; and the same
//              without B (the receiver keeps the puck — the old way) for comparison.
//   'aim'    — the player with the puck 8–14 m from the goal, stick up / down / to the goal, B held 0.85 s (full power):
//              where the shot crosses the goal line with the goalie off the ice (corner ±0.70 when the stick is
//              sideways), and goals / saves with the goalie.
//   'rush'   — 2 on 1 like training lesson 13: the player carries the puck up the ice (stick forward, sprint) with a
//              teammate, one defender and the goalie; at a random moment passes A or Y to the teammate and keeps the
//              stick forward. Did the teammate take it, how often he stopped (slower than 1.5 m/s) with the puck free
//              ahead of him, and who controlled him while the pass travelled.
// usage: node tools/onetimer.mjs [--seeds 60] [--seed0 1] [--mode ot|aim|rush] [--verbose]
import BVRSim from '../shared/sim.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const N = +opt('seeds', 60), SEED0 = +opt('seed0', 1), MODE = opt('mode', ''), VERBOSE = args.includes('--verbose');
const mulberry = (s) => { let a = s >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let r = Math.imul(a ^ (a >>> 15), 1 | a);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; };
const DT = 1 / 60;

function make(seed) {
  const ev = [];
  const S = BVRSim.create({ random: mulberry(seed), emit: (n, e) => { ev.push([n, S.SIMT, e]); return e; } });
  const IN = { mx: 0, mz: 0, _A: false, _B: false, _X: false, _Y: false, RT: false, _LB: false };
  const ED = { A: false, B: false, X: false, Y: false, LB: false };
  S.setControl({ tick: [true, false], hum: [true, false], inp: [IN, S.NOIN], edge: [ED, S.NOEDGE], lv: ['normal', 'normal'] });
  S.reset(true); S.clock = 180;
  return { S, IN, ED, ev, sc: mulberry(seed * 7919 + 13) };
}
const press = (S, IN, ED, k, on) => { if (on && !IN['_' + k]) ED[k] = true; IN['_' + k] = on; };

// through pass + (optionally) B in flight; outcome of the next 2.5 s
function otEp(seed, withB) {
  const { S, IN, ED, ev, sc } = make(seed), rr = (a, b) => a + sc() * (b - a);
  S.state = 'play';
  S.placeFaceoff(rr(4, 12), rr(-5, 5));
  const mine = S.teamOf(0).filter((p) => !p.goalie), me = mine[Math.floor(sc() * mine.length)];
  S.puck.owner = me; S.lastTouch = me; S.HS[0].ctrl = me;
  let t = 0;
  while (t < 0.6) { IN.mx = 1; IN.mz = 0; S.step(DT); t += DT; if (S.puck.owner !== me) return { seed, out: 'lost-before' }; }
  const k0 = ev.length; ED.Y = true; IN.mx = 0.6; S.step(DT); ED.Y = false;
  const pe = ev.slice(k0).find(([n]) => n === 'pass'); if (!pe) return { seed, out: 'no-pass' };
  const r = { seed, out: 'none', to: pe[2].to };
  for (t = 0; t < 2.5; t += DT) {
    const far = (S.players[pe[2].to] || me).z > 0 ? -1 : 1;    // stick to the far corner from the receiver's side
    IN.mx = 0.4; IN.mz = far;
    press(S, IN, ED, 'B', withB && t >= 0.1 && t < 0.17);
    S.step(DT); ED.B = false;
    for (let k = k0 + 1; k < ev.length && r.out === 'none'; k++) {
      const [n, , e] = ev[k];
      if (n === 'shot' && e.t === 0) { r.shot = 1; r.ot = e.ot | 0; r.at = +t.toFixed(2); }
      if (n === 'goal') { r.out = e.t === 0 ? 'goal' : 'against'; }
      if (n === 'save') { r.out = 'save'; }
      if (n === 'stoppage') { r.out = 'whistle'; }
      if (n === 'pickup' && e.t === 1 && !e.intercept && r.shot) { r.out = 'lost'; }
      if (n === 'pickup' && e.t === 1 && e.intercept) { r.out = 'intercepted'; }
    }
    if (r.out !== 'none') break;
  }
  if (VERBOSE) r.ev = ev.slice(k0).map(([n, t, e]) => n + '@' + t.toFixed(2) + (e.p !== undefined ? ':' + e.p : '')).join(' ');
  return r;
}

// stick aim: side -1 / +1 / 0 (to the goal)
function aimEp(seed, side, gk) {
  const { S, IN, ED, ev, sc } = make(seed), rr = (a, b) => a + sc() * (b - a);
  S.state = 'play';
  const gx = BVRSim.GOAL_X, x = gx - rr(8, 14), z = rr(-4, 4);
  S.placeFaceoff(0, 0);
  for (const p of S.players) if (p.team === 1 && (!p.goalie || !gk)) { p.boxed = 1; p.x = 0; p.z = -90; }
  const me = S.teamOf(0).filter((p) => !p.goalie)[0];
  me.x = x; me.z = z; me.vx = me.vz = 0; me.yaw = 0;
  S.puck.owner = me; S.lastTouch = me; S.HS[0].ctrl = me;
  const k0 = ev.length; let t = 0;
  const r = { seed, side, z0: +z.toFixed(1), out: 'none' };
  for (; t < 2.5; t += DT) {
    IN.mx = side ? 0.3 : 1; IN.mz = side;
    press(S, IN, ED, 'B', t < 0.85);
    const px = S.puck.x, pz = S.puck.z;
    S.step(DT); ED.B = false;
    if (r.cz === undefined && S.puck.x >= gx - 0.05 && px < gx - 0.05 && !S.puck.owner) {
      const k = (gx - 0.05 - px) / ((S.puck.x - px) || 1); r.cz = +(pz + (S.puck.z - pz) * k).toFixed(2);
    }
    for (let k = k0; k < ev.length && r.out === 'none'; k++) {
      const [n, , e] = ev[k];
      if (n === 'goal') { r.out = 'goal'; r.cz = e.z; }
      if (n === 'save') r.out = 'save';
      if (n === 'post') r.out = 'post';
    }
    if (r.out !== 'none') break;
  }
  return r;
}

// 2 on 1: only me, a teammate, one defender and the goalie on the ice
function rushEp(seed, btn) {
  const { S, IN, ED, ev, sc } = make(seed), rr = (a, b) => a + sc() * (b - a);
  S.state = 'play';
  S.placeFaceoff(0, 0);
  const mine = S.teamOf(0).filter((p) => !p.goalie), theirs = S.teamOf(1).filter((p) => !p.goalie);
  const me = mine[1], mate = mine[0], def = theirs[3];
  for (const p of S.players) if (p.team === 0 ? (!p.goalie && p !== me && p !== mate) || p.goalie : (!p.goalie && p !== def)) { p.boxed = 1; p.x = 0; p.z = -90; }
  const z0 = rr(-4, -2);
  me.x = -2; me.z = z0; mate.x = -3; mate.z = rr(3, 5); def.x = 13; def.z = 0;
  for (const p of [me, mate, def]) { p.vx = p.vz = 0; p.yaw = p.team ? Math.PI : 0; }
  S.puck.owner = me; S.lastTouch = me; S.HS[0].ctrl = me;
  const passAt = rr(0.6, +opt('late', 2.2)); let t = 0, k0 = -1, r = { seed, btn, out: 'none' }, slow = 0, ctlMate = 0;
  for (; t < passAt + 3; t += 1 / 60) {
    IN.mx = 1; IN.mz = -z0 * 0.05; IN.RT = true;
    if (k0 >= 0 && args.includes('--release')) { IN.mx = 0; IN.mz = 0; IN.RT = false; }
    if (k0 < 0 && t >= passAt - 0.15 && t < passAt) { IN.mx = +opt('ax', 0.6); IN.mz = +opt('az', 0.8); }
    if (k0 < 0 && t >= passAt) { if (S.puck.owner !== me) { r.out = 'lost-before'; break; } k0 = ev.length; ED[btn] = true; IN['_' + btn] = true; }
    else if (k0 >= 0) { IN['_' + btn] = false; }
    S.step(1 / 60); ED[btn] = false;
    if (k0 >= 0 && r.out === 'none') {
      if (!S.puck.owner && S.HS[0].ctrl === mate) ctlMate++;
      if (process.env.TRACE && ((t * 60) | 0) % 9 === 0) console.log(`t+${(t - passAt).toFixed(2)} puck ${S.puck.x.toFixed(1)},${S.puck.z.toFixed(1)} v${Math.hypot(S.puck.vx, S.puck.vz).toFixed(1)} | mate ${mate.x.toFixed(1)},${mate.z.toFixed(1)} v${Math.hypot(mate.vx, mate.vz).toFixed(1)} ${S.HS[0].ctrl === mate ? 'CTRL' : ''} | me ${me.x.toFixed(1)},${me.z.toFixed(1)} | def ${def.x.toFixed(1)},${def.z.toFixed(1)}`);
      if (!S.puck.owner && Math.hypot(mate.vx, mate.vz) < 1.5 && Math.hypot(S.puck.x - mate.x, S.puck.z - mate.z) > 2) slow++;
      for (let k = k0; k < ev.length; k++) {
        const [n, , e] = ev[k];
        if (n === 'pickup' && r.out === 'none') { r.out = e.t === 0 ? (S.players[e.p] === mate ? 'mate' : 'me') : (S.players[e.p].goalie ? 'goalie' : 'defender'); r.at = +(t - passAt).toFixed(2); }
        if (n === 'stoppage' && r.out === 'none') r.out = 'whistle:' + e.reason;
      }
    }
    if (r.out !== 'none') break;
  }
  r.slow = +(slow / 60).toFixed(2); r.ctlMate = +(ctlMate / 60).toFixed(2);
  if (VERBOSE) r.ev = ev.slice(Math.max(0, k0)).map(([n, t, e]) => n + '@' + t.toFixed(2)).join(' ');
  return r;
}

const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '-';
if (!MODE || MODE === 'ot') {
  for (const withB of [true, false]) {
    const res = []; for (let s = SEED0; s < SEED0 + N; s++) res.push(otEp(s, withB));
    const ok = res.filter((r) => r.out !== 'lost-before' && r.out !== 'no-pass');
    const c = (f) => ok.filter(f).length;
    console.log(`${withB ? 'Y + B in flight' : 'Y only        '}: ${ok.length} passes · shot ${pct(c((r) => r.shot), ok.length)}, one-timer ${pct(c((r) => r.ot), ok.length)} (at ${(ok.filter((r) => r.ot).reduce((a, r) => a + r.at, 0) / (c((r) => r.ot) || 1)).toFixed(2)} s) · goal ${pct(c((r) => r.out === 'goal'), ok.length)}, save ${pct(c((r) => r.out === 'save'), ok.length)}, intercepted ${pct(c((r) => r.out === 'intercepted'), ok.length)}`);
    if (VERBOSE) res.forEach((r) => console.log(JSON.stringify(r)));
  }
}
if (!MODE || MODE === 'rush') {
  for (const btn of ['A', 'Y']) {
    const res = []; for (let s = SEED0; s < SEED0 + N; s++) res.push(rushEp(s, btn));
    const ok = res.filter((r) => r.out !== 'lost-before'), c = (f) => ok.filter(f).length;
    console.log(`rush ${btn}: ${ok.length} passes · mate took it ${pct(c((r) => r.out === 'mate'), ok.length)}, defender ${pct(c((r) => r.out === 'defender'), ok.length)}, goalie ${pct(c((r) => r.out === 'goalie'), ok.length)}, me ${pct(c((r) => r.out === 'me'), ok.length)}, nobody 3 s ${pct(c((r) => r.out === 'none'), ok.length)}, whistle ${pct(c((r) => /whistle/.test(r.out)), ok.length)} · mate stood ≥0.3 s, puck free ${pct(c((r) => r.slow >= 0.3), ok.length)} · mate under my control in flight ${pct(c((r) => r.ctlMate > 0), ok.length)}`);
    if (VERBOSE) res.forEach((r) => console.log(JSON.stringify(r)));
  }
}
if (!MODE || MODE === 'aim') {
  for (const side of [1, -1, 0]) {
    const res = []; for (let s = SEED0; s < SEED0 + N; s++) res.push(aimEp(s, side, false));
    const wg = []; for (let s = SEED0; s < SEED0 + N; s++) wg.push(aimEp(s, side, true));
    const cz = res.filter((r) => r.cz !== undefined).map((r) => r.cz);
    const corner = cz.filter((z) => side ? Math.abs(z - side * 0.7) < 0.22 : false).length;
    console.log(`stick ${side > 0 ? 'up  ' : side < 0 ? 'down' : 'goal'}: ${res.length} shots · crossing z ${cz.length ? Math.min(...cz).toFixed(2) + '…' + Math.max(...cz).toFixed(2) : '-'}${side ? ` · in the corner ${pct(corner, cz.length)}` : ''} · no goalie: goal ${pct(res.filter((r) => r.out === 'goal').length, res.length)}, post ${pct(res.filter((r) => r.out === 'post').length, res.length)} · goalie: goal ${pct(wg.filter((r) => r.out === 'goal').length, wg.length)}, save ${pct(wg.filter((r) => r.out === 'save').length, wg.length)}`);
    if (VERBOSE) res.forEach((r) => console.log(JSON.stringify(r)));
  }
}
