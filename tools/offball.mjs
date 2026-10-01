// Off-puck support and the through pass (Y), measured on shared/sim.js in Node.js: the player's centre (team 0, under
// "human" control driven by a script) carries the puck from the neutral zone into the attacking zone against a set
// defence and gives a through pass with Y; after the reception the script takes the shot when the chance is good.
// N episodes with different seeds (the same seed — the same episode). Reports how many partners were open at the moment
// of the pass, how many through passes arrived, how many shots (on goal, goals) followed them, and offsides.
// "Open": no opponent within 2.5 m and no opponent within 1.2 m of the passing lane.
// Two scenarios: 'entry' — the rush from the neutral zone into the zone against a set defence, the pass in the zone
// (or at the blue line when pressed); 'zone' — the puck already in the zone, the carrier holds it 1–2 s, then Y.
// usage: node tools/offball.mjs [--seeds 30] [--seed0 1] [--mode entry|zone] [--json out.json] [--verbose]
import { writeFileSync } from 'node:fs';
import BVRSim from '../shared/sim.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const N = +opt('seeds', 30), SEED0 = +opt('seed0', 1), VERBOSE = args.includes('--verbose');
const mulberry = (s) => { let a = s >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let r = Math.imul(a ^ (a >>> 15), 1 | a);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; };
const DT = 1 / 60;

export function episode(seed, hook, mode = 'entry') {
  const ev = [];
  const S = BVRSim.create({ random: mulberry(seed), emit: (n, e) => { ev.push([n, S.SIMT, e]); return e; } });
  const IN = { mx: 0, mz: 0, _A: false, _B: false, _X: false, _Y: false, RT: false, _LB: false };
  const ED = { A: false, B: false, X: false, Y: false, LB: false };
  S.setControl({ tick: [true, false], hum: [true, false], inp: [IN, S.NOIN], edge: [ED, S.NOEDGE], lv: ['normal', 'normal'] });
  S.reset(true); S.clock = 180;
  // the scenario's own random numbers: the simulation's stream stays the simulation's
  const sc = mulberry(seed * 7919 + 13), rr = (a, b) => a + sc() * (b - a);
  // 'entry' — the rush from the neutral zone into the zone; 'zone' — the puck already in the zone, the carrier holds it
  S.placeFaceoff(mode === 'zone' ? rr(10, 12) : rr(4, 7), rr(-5, 5));
  S.state = 'play';
  const mine = S.teamOf(0), me = mine.find((p) => p.role === 1);
  for (const p of S.teamOf(1)) p.x += mode === 'zone' ? 5 : 9;   // a set defence: the opponents back in their zone
  if (mode === 'zone') {
    for (const p of S.teamOf(0)) if (p.role !== 1) p.x = Math.min(p.x, S.BLUE_X + 0.5);   // partners onside
    me.x = rr(10.5, 12.5); me.z = rr(-4, 4);           // the carrier inside the zone
  }
  S.puck.owner = me; S.lastTouch = me; S.HS[0].ctrl = me;
  for (const p of mine) p.vx = 5;                       // the rush: everybody already skating up ice
  const laneZ = rr(-5, 5), wait = mode === 'zone' ? rr(1.0, 2.0) : rr(0.15, 0.7);
  const P = S.players, idx = (p) => P.indexOf(p);
  const open = (from, m) => S.nearestFoe(m) >= 2.5 && S.laneBlock(0, from.x, from.z, m.x, m.z) >= 1.2;
  // open and not behind the puck (≤ 1 m back) — a partner a pass forward can find
  const ahead = (from, m) => m.x > from.x - 1 && open(from, m);
  // in a shooting position: the AI's own shot estimate ≥ 0.3 with 2.5 m of space
  const shootPos = (m) => S.shotQuality(0, m.x, m.z, S.AI_LV.normal) >= 0.3 && S.nearestFoe(m) >= 2.5;
  const snap = () => { const o = mine.filter((m) => m !== me); return [o.filter((m) => open(me, m)).length, o.filter((m) => ahead(me, m)).length, o.filter(shootPos).length]; };
  const r = { seed, outcome: 'timeout', open: null, ahead: null, shootPos: null, aheadCarry: 0, openCarry: 0, nCarry: 0, to: -1, aimed: 0, lead: 0, reached: 0,
              shot: 0, sog: 0, goal: 0, offside: 0, recvGoalDist: null, passDist: null };
  let phase = 'carry', t = 0, tPhase = 0, inZoneT = 0, lostT = 0, recv = null, holdB = 0, shotT = -1, k0 = 0;
  const steer = (x, z, p) => { const dx = x - p.x, dz = z - p.z, L = Math.hypot(dx, dz) || 1; IN.mx = dx / L; IN.mz = dz / L; };
  // the carrier sidesteps the nearest opponent ahead, the way a player would
  const dodge = (p) => {
    let f = null, fd = 3.5; for (const o of S.teamOf(1)) { const d = Math.hypot(o.x - p.x, o.z - p.z); if (d < fd && o.x > p.x - 0.5) { fd = d; f = o; } }
    if (!f) return; const side = p.z >= f.z ? 1 : -1; IN.mz += side * (3.5 - fd) / 3.5 * 1.4;
    const L = Math.hypot(IN.mx, IN.mz) || 1; IN.mx /= L; IN.mz /= L;
  };
  while (t < 14) {
    ED.Y = false; ED.A = false;
    const own = S.puck.owner;
    IN.RT = phase === 'carry' && mode !== 'zone';       // the rush: sprint with the puck; in the zone — hold it
    if (phase === 'carry') {
      if (own === me) {
        lostT = 0;
        if (me.x > S.BLUE_X + 1.2) {
          inZoneT += DT;
          if (mode === 'zone') steer(S.BLUE_X + 4, laneZ >= 0 ? 8 : -8, me);   // to the half-wall, the top of the zone
          else steer(S.GOAL_X - 9, laneZ * 0.6, me);
          if (Math.round(inZoneT / DT) % 15 === 0) { const q = snap(); r.openCarry += q[0]; r.aheadCarry += q[1]; r.nCarry++; }
          dodge(me);
          if (inZoneT >= wait || S.nearestFoe(me) < (mode === 'zone' ? 1.7 : 2.2)) {
            [r.open, r.ahead, r.shootPos] = snap();
            ED.Y = true; phase = 'pass'; tPhase = 0; k0 = ev.length; r.at = [+me.x.toFixed(1), +me.z.toFixed(1), +t.toFixed(2)];
            if (hook) hook('pass', S);
          }
        } else if (me.x > 0 && S.nearestFoe(me) < 2.2) {
          // pressed after the red line: the through pass goes from the neutral zone
          [r.open, r.ahead, r.shootPos] = snap(); r.early = 1;
          ED.Y = true; phase = 'pass'; tPhase = 0; k0 = ev.length; r.at = [+me.x.toFixed(1), +me.z.toFixed(1), +t.toFixed(2)];
          if (hook) hook('pass', S);
        } else { steer(S.BLUE_X + 4.5, laneZ, me); dodge(me); }
      } else if ((lostT += DT) > 0.6) { r.outcome = 'lost'; r.lostAt = [+me.x.toFixed(1), +me.z.toFixed(1), +t.toFixed(2)]; break; }
    } else if (phase === 'pass') {
      for (; k0 < ev.length; k0++) {
        const [n, , e] = ev[k0];
        if (n === 'pass' && e.t === 0) { r.to = e.to; r.lead = e.lead ? 1 : 0; }
        if (n === 'pass:recv' && e.t === 0) { r.reached = 1; r.aimed = e.aimed; recv = P[e.p]; }
        if (n === 'pickup' && e.t === 1) { r.outcome = 'intercepted'; }
        if (n === 'stoppage' && e.reason === 'offside') { r.offside = 1; r.outcome = 'offside'; }
      }
      if (r.outcome === 'intercepted' || r.outcome === 'offside') break;
      if (recv) {
        r.recvGoalDist = +Math.hypot(S.GOAL_X - recv.x, recv.z).toFixed(2);
        phase = 'after'; tPhase = 0; r.outcome = 'received';
        if (hook) hook('recv', S);
      } else if (tPhase > 2.5) { r.outcome = 'missed'; break; }
      IN.mx = 0; IN.mz = 0;
    } else if (phase === 'after') {
      const c = S.HS[0].ctrl;
      for (; k0 < ev.length; k0++) {
        const [n, , e] = ev[k0];
        if (n === 'shot' && e.t === 0 && shotT < 0) { r.shot = 1; shotT = t; }
        if (shotT >= 0 && (n === 'save' && e.t === 1 && e.shot)) r.sog = 1;
        if (n === 'goal' && e.t === 0) { r.goal = 1; r.sog = 1; }
        if (n === 'stoppage' && e.reason === 'offside') { r.offside = 1; }
      }
      if (r.goal || r.offside || (shotT >= 0 && t - shotT > 1.5) || tPhase > 3.5) break;
      if (shotT < 0 && c && own === c) {
        steer(S.GOAL_X - 3, 0, c);
        const q = S.shotQuality(0, c.x, c.z, S.AI_LV.normal);
        if (holdB > 0 || q >= 0.38 || S.nearestFoe(c) < 1.8 || tPhase > 1.6) holdB += DT;
      }
      IN._B = holdB > 0 && holdB < 0.3;
      if (holdB >= 0.3) holdB = -1;                     // released: the charged shot goes
    }
    S.step(DT); t += DT; tPhase += DT;
    if (S.state !== 'play' && phase !== 'after') { if (!r.offside && phase === 'carry') r.outcome = 'whistle'; if (phase === 'carry') break; }
  }
  if (phase === 'pass' && r.outcome === 'timeout') r.outcome = 'missed';
  return r;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = {};
  for (const mode of (opt('mode', '') ? [opt('mode', '')] : ['entry', 'zone'])) {
  const runs = all[mode] = [];
  for (let i = 0; i < N; i++) {
    const r = episode(SEED0 + i, null, mode);
    runs.push(r);
    if (VERBOSE) console.log(JSON.stringify(r));
  }
  const passed = runs.filter((r) => r.open !== null), n = passed.length || 1;
  const sum = (f) => passed.reduce((a, r) => a + f(r), 0);
  const nC = runs.reduce((a, r) => a + r.nCarry, 0) || 1;
  const carry = runs.reduce((a, r) => a + r.openCarry, 0) / nC, carryAhead = runs.reduce((a, r) => a + r.aheadCarry, 0) / nC;
  const rows = [
    ['эпизодов', runs.length],
    ['дошли до паса в разрез', passed.length],
    ['открытых партнёров в момент паса (из 4)', (sum((r) => r.open) / n).toFixed(2)],
    ['— хотя бы 2 открыты', `${sum((r) => (r.open >= 2 ? 1 : 0))}/${passed.length}`],
    ['— из них впереди шайбы', (sum((r) => r.ahead) / n).toFixed(2)],
    ['— в позиции для броска', (sum((r) => r.shootPos) / n).toFixed(2)],
    ['открытых, пока веду шайбу в зоне', carry.toFixed(2)],
    ['— впереди шайбы', carryAhead.toFixed(2)],
    ['пас дошёл до своего', `${sum((r) => r.reached)}/${passed.length}`],
    ['— тому, кому адресован', `${sum((r) => (r.reached && r.aimed ? 1 : 0))}/${passed.length}`],
    ['перехвачен соперником', sum((r) => (r.outcome === 'intercepted' ? 1 : 0))],
    ['мимо (никто не принял)', sum((r) => (r.outcome === 'missed' ? 1 : 0))],
    ['офсайд', sum((r) => r.offside)],
    ['бросок после паса', sum((r) => r.shot)],
    ['— в створ', sum((r) => r.sog)],
    ['— гол', sum((r) => r.goal)],
    ['до ворот при приёме, м (среднее)', (sum((r) => r.recvGoalDist || 0) / (sum((r) => (r.recvGoalDist !== null ? 1 : 0)) || 1)).toFixed(1)],
  ];
  console.log(`\n${mode === 'zone' ? 'владение в зоне, пас по Y через 1–2 с' : 'заход в зону, пас по Y'}: ${runs.length} эпизодов, seed ${SEED0}…${SEED0 + N - 1}`);
  for (const [k, v] of rows) console.log(k.padEnd(44) + String(v).padStart(8));
  console.log('исходы: ' + Object.entries(runs.reduce((a, r) => ((a[r.outcome] = (a[r.outcome] || 0) + 1), a), {})).map(([k, v]) => `${k} ${v}`).join(' · '));
  }
  if (opt('json')) writeFileSync(opt('json'), JSON.stringify(all, null, 1));
}
