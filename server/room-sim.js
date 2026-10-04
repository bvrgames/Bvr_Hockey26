/**
 * BVR Hockey — server-authoritative match for one room (phase 3.2).
 *
 * Shared by server/worker.js (Cloudflare Durable Object) and tools/relay-mock.mjs (local tests), no platform APIs:
 * the owner passes send(slot, text) and now() and calls tick() on a timer (~60 Hz) while the room is running.
 *
 * The simulation is shared/sim.js — the same code the browser runs in a solo match and as the old host.
 * Symmetric protocol: slot 0 (first in the room, "host") plays team 0, slot 1 ("guest") plays team 1; the terms only
 * say who came first. Nobody simulates locally: both clients send input and both receive snapshots, exactly like the
 * guest of the host-authoritative mode (same message formats, so the client's guest pipeline is reused as is).
 *
 *   client → server
 *     {t:'cfg', a, b, min, id, hz?}     start / restart the match (slot 0 only): team picks, minutes, match id,
 *                                       hz = snapshots a second the room sends (SNAP_HZ_OK, default 30; index.html NETCFG)
 *     {t:'i', m:[x,z], b, q, c, tc}     input: stick in WORLD coordinates (the client applies its own camera), buttons
 *                                       held b (A1 B2 X4 Y8 RT16 LB32), packet number q, press counters c[A,B,X,Y,LB],
 *                                       tactic tc
 *   server → both
 *     {t:'cfg', a, b, min, id, hz}      the match (re)starts; hz = snapshot rate of this match
 *     {t:'s', d, k, a, v, e?, w?}       snapshot, same layout as the host's (index.html netSnap); a = the last input
 *                                       packet of THIS recipient the simulation has used, k = server time (ms),
 *                                       w = who is away (bits: 1 slot 0, 2 slot 1; 4 / 8 — away for over 30 s)
 *
 * Lost players (phase 3.5): a player is "away" when the socket is gone or no input came for AWAY_MS. The AI plays
 * that team (the same AI as the autopilot of a solo match) and the match goes on; the first input after the return
 * gives the team back. Away for more than GONE_MS is recorded (bits 4 / 8), the match is still played out against
 * the AI — the player who stayed keeps the match and its result. With both players gone for GONE_MS the match stops.
 * A returning player gets the current cfg again (join) and then snapshots as usual.
 */
import BVRSim from '../shared/sim.mjs';

export const SIM_HZ = 60, SNAP_EVERY = 2;          // 60 Hz simulation, snapshot every 2nd step = 30 Hz
export const SNAP_HZ_OK = [15, 20, 30, 60];          // snapshot rates a match may ask for (cfg.hz): whole steps apart
export const AWAY_MS = 2000, GONE_MS = 30000;
const NETWORKED = { faceoff: 1, pass: 1, 'pass:recv': 1, shot: 1, save: 1, post: 1, goal: 1,
                    hit: 1, penalty: 1, stoppage: 1, poke: 1, pickup: 1, 'match:end': 1 };
const STC = { play: 0, face: 1, goal: 2, replay: 3, over: 4, menu: 5 };
const BTN = ['A', 'B', 'X', 'Y', 'LB'];
const CLUBS_N = 4;                                  // index.html CLUBS.length
const r2 = (v) => Math.round(v * 100) / 100, r1 = (v) => Math.round(v * 10) / 10;

function mkPort() {
  return { inp: { mx: 0, mz: 0, _A: false, _B: false, _X: false, _Y: false, RT: false, _LB: false },
           edge: { A: false, B: false, X: false, Y: false, LB: false },
           tapB: false, pend: null, lastCnt: [0, 0, 0, 0, 0], inQ: 0, npv: {},
           conn: false, lastIn: 0, away: false, awayAt: 0, left: false };
}

export class MatchRoom {
  constructor(send, now = Date.now) {
    this.send = send; this.now = now;
    this.seq = 0; this.evq = [];
    this.port = [mkPort(), mkPort()];
    this.running = false; this.acc = 0; this.last = 0; this.steps = 0; this.overT = 0;
    this.snapEvery = SNAP_EVERY;
    this.cfg = null;
    this.ended = false;
    this.onEnd = null;    // (result) once per match when the clock runs out: { id, len, score, left }; the stats API trusts it
    this.onStop = null;   // (id) the match stopped without a result: both players gone for GONE_MS
    this.stat = { steps: 0, snaps: 0, maxStepMs: 0 };
    this.sim = BVRSim.create({
      emit: (n, e) => {
        if (NETWORKED[n]) {
          if (e.seq === undefined) e.seq = ++this.seq;
          this.evq.push({ n, e, left: 3 });           // each event rides in 3 snapshots, clients drop repeats by seq
          if (this.evq.length > 60) this.evq.splice(0, this.evq.length - 60);
        }
        return e;
      },
    });
    const P = this.port;
    this.sim.setControl({ tick: [true, true], hum: [true, true], inp: [P[0].inp, P[1].inp],
                          edge: [P[0].edge, P[1].edge], rem: [P[0], P[1]], lv: ['normal', 'normal'], first: 0 });
    this.sim.reset(true);
  }

  // a message from slot 0|1 (already parsed JSON). Returns true if it was handled here (not to be relayed).
  onMessage(slot, m) {
    if (!m || typeof m.t !== 'string') return false;
    if (m.t === 'i') { this.input(slot, m); return true; }
    if (m.t === 'cfg') { if (slot === 0) this.start(m); return true; }
    if (m.t === 's') return true;                    // no client simulates in this mode
    return false;
  }

  // the AI takes the team of a lost player / gives it back
  setAway(t, on) {
    const P = this.port[t], C = this.sim.control;
    if (P.away === on) return;
    P.away = on;
    if (on) { P.awayAt = this.now(); this.clearInput(t); }
    C.hum[t] = !on; C.inp[t] = on ? this.sim.NOIN : P.inp; C.edge[t] = on ? this.sim.NOEDGE : P.edge; C.rem[t] = on ? null : P;
  }

  clearInput(t) {
    const P = this.port[t], I = P.inp, E = P.edge;
    I.mx = I.mz = 0; I._A = I._B = I._X = I._Y = I.RT = I._LB = false;
    E.A = E.B = E.X = E.Y = E.LB = false; P.tapB = false; P.pend = null; P.npv = {};
  }

  // a socket for this slot is open. fresh = a new page (its packet and press counters start from zero again)
  join(t, fresh) {
    const P = this.port[t];
    P.conn = true;
    if (fresh) { P.lastCnt = [0, 0, 0, 0, 0]; P.inQ = 0; }
    if (this.running && this.cfg) this.send(t, JSON.stringify(this.cfg));
  }

  input(t, m) {
    const P = this.port[t], I = P.inp, E = P.edge;
    P.conn = true; P.lastIn = this.now();
    if (P.away) this.setAway(t, false);
    const mx = Array.isArray(m.m) ? +m.m[0] : 0, mz = Array.isArray(m.m) ? +m.m[1] : 0;
    const L = Math.hypot(mx, mz) || 0;
    // a stick is at most 1 long; anything else (NaN, a crafted packet) is clamped
    I.mx = L > 1 ? mx / L : (Number.isFinite(mx) ? mx : 0); I.mz = L > 1 ? mz / L : (Number.isFinite(mz) ? mz : 0);
    const b = m.b | 0;
    I._A = !!(b & 1); I._B = !!(b & 2); I._X = !!(b & 4); I._Y = !!(b & 8); I.RT = !!(b & 16); I._LB = !!(b & 32);
    if (Array.isArray(m.c)) {
      // press counters: an edge = the counter grew; edges pile up (OR) until the next step uses them
      for (let i = 0; i < BTN.length; i++) {
        const c = m.c[i] | 0;
        if (c > P.lastCnt[i]) { E[BTN[i]] = true; P.lastCnt[i] = c; if (i === 1 && !I._B) P.tapB = true; }
      }
    } else {
      E.A = I._A && !P.npv.A; E.B = I._B && !P.npv.B; E.X = I._X && !P.npv.X; E.Y = I._Y && !P.npv.Y; E.LB = I._LB && !P.npv.LB;
    }
    P.npv = { A: I._A, B: I._B, X: I._X, Y: I._Y, LB: I._LB };
    if ((m.q | 0) > P.inQ) P.inQ = m.q | 0;
    if (m.tc === 0 || m.tc === 1 || m.tc === 2) this.sim.TACTIC[t] = m.tc;
  }

  start(m) {
    const S = this.sim;
    const a = Math.max(0, Math.min(CLUBS_N - 1, m.a | 0));
    let b = Math.max(0, Math.min(CLUBS_N - 1, m.b | 0)); if (b === a) b = (a + 1) % CLUBS_N;
    const min = Math.max(0.25, Math.min(10, +m.min || 3));
    const id = typeof m.id === 'string' && /^[0-9a-f]{8,32}$/.test(m.id) ? m.id : '';
    const hz = SNAP_HZ_OK.includes(m.hz | 0) ? m.hz | 0 : SIM_HZ / SNAP_EVERY;
    this.snapEvery = SIM_HZ / hz;
    this.cfg = { t: 'cfg', a, b, min, id, hz };
    S.score[0] = 0; S.score[1] = 0; S.period = 1; S.clock = min * 60; S.pen.length = 0;
    S.reset(true);
    S.TACTIC[0] = 0; S.TACTIC[1] = 0; S.gkRush[0] = false; S.gkRush[1] = false;
    S.state = 'face'; S.stateT = 0.9;
    for (let t = 0; t < 2; t++) { this.clearInput(t); this.setAway(t, false); this.port[t].left = false; this.port[t].lastIn = this.now(); }
    this.evq.length = 0;
    const txt = JSON.stringify(this.cfg);
    this.send(0, txt); this.send(1, txt);
    this.running = true; this.acc = 0; this.last = this.now(); this.steps = 0; this.overT = 0; this.ended = false;
  }

  // call ~60 times a second; runs as many fixed steps as real time asks for (at most 6: a stalled timer does not
  // fast-forward the match), sends a snapshot every SNAP_EVERY steps. Returns false when the room can stop ticking.
  tick() {
    if (!this.running) return false;
    const now = this.now(), S = this.sim;
    this.acc += Math.max(0, now - this.last) / 1000; this.last = now;
    let n = Math.floor(this.acc * SIM_HZ);
    if (n > 6) { n = 6; this.acc = 0; } else this.acc -= n / SIM_HZ;
    if (S.state !== 'over') {                        // after the end nobody sends input
      for (let t = 0; t < 2; t++) {
        const P = this.port[t];
        if (!P.away && (!P.conn || now - P.lastIn > AWAY_MS)) this.setAway(t, true);
        if (P.away && !P.left && now - P.awayAt > GONE_MS) P.left = true;
      }
      if (this.port[0].left && this.port[1].left) {                 // nobody left to play for: no result (onStop)
        this.running = false;
        if (this.onStop) this.onStop(this.cfg && this.cfg.id);
        return false;
      }
    }
    for (let i = 0; i < n; i++) {
      const t0 = Date.now();
      S.control.first = this.steps & 1;              // who acts first in a contested step alternates: no side wins ties
      if (S.state === 'over') this.overT += 1 / SIM_HZ;
      else {
        S.step(1 / SIM_HZ);
        if (S.state === 'over' && !this.ended) {
          this.ended = true;
          if (this.onEnd) this.onEnd({ id: this.cfg.id, len: Math.round(this.cfg.min * 60), score: [S.score[0], S.score[1]],
                                       left: [this.port[0].left, this.port[1].left] });
        }
      }
      this.steps++; this.stat.steps++;
      const dt = Date.now() - t0; if (dt > this.stat.maxStepMs) this.stat.maxStepMs = dt;
      // after the end: 6 snapshots a second for 5 s, so both see the final state and match:end, then stop
      const every = S.state === 'over' ? 10 : this.snapEvery;
      // stamped with the moment of this step, not the send time: the timer fires unevenly (0…6 steps a tick), and a
      // send-time stamp shifts states in time and hides server stalls from the client's jitter estimate
      if (this.steps % every === 0) this.snapshot(Math.round(now - (this.acc + (n - 1 - i) / SIM_HZ) * 1000));
      if (S.state === 'over' && this.overT > 5) { this.running = false; return false; }
    }
    return true;
  }

  snapshot(k = this.now()) {
    const S = this.sim, P = S.players, HS = S.HS, pk = S.puck;
    const d = [r2(pk.x), r2(pk.y), r2(pk.z), S.score[0], S.score[1], Math.round(S.clock * 10) / 10, STC[S.state] || 0,
               P.indexOf(HS[0].ctrl), P.indexOf(HS[1].ctrl), S.gkRush[0] ? 1 : 0, S.gkRush[1] ? 1 : 0,
               S.offWarn, S.penaltyLeft(0) | 0, S.penaltyLeft(1) | 0,
               r2(HS[0].aimX || 0), r2(HS[0].aimZ || 0), r2(HS[1].aimX || 0), r2(HS[1].aimZ || 0),
               P.indexOf(pk.owner),
               (HS[0].press.on ? 1 : 0) | (HS[1].press.on ? 2 : 0) | (HS[0].goalieCtl ? 4 : 0) | (HS[1].goalieCtl ? 8 : 0)];
    for (const p of P) d.push(r2(p.x), r2(p.z), r2(p.yaw), (p.down > 0 ? 1 : 0) + (p.boxed ? 2 : 0), r1(p.stride), r1(p.spd || 0));
    const c0 = HS[0].ctrl, c1 = HS[1].ctrl;
    const v = [r2(c0 ? c0.vx : 0), r2(c0 ? c0.vz : 0), r2(c1 ? c1.vx : 0), r2(c1 ? c1.vz : 0)];
    let ev = '';
    if (this.evq.length) {
      ev = ',"e":' + JSON.stringify(this.evq.map((q) => [q.n, q.e]));
      for (const q of this.evq) q.left--;
      this.evq = this.evq.filter((q) => q.left > 0);
    }
    const Q = this.port, w = (Q[0].away ? 1 : 0) | (Q[1].away ? 2 : 0) | (Q[0].left ? 4 : 0) | (Q[1].left ? 8 : 0);
    const head = '{"t":"s","d":' + JSON.stringify(d) + ',"k":' + k + ',"v":' + JSON.stringify(v) + ev + (w ? ',"w":' + w : '') + ',"a":';
    this.send(0, head + this.port[0].inQ + '}');
    this.send(1, head + this.port[1].inQ + '}');
    this.stat.snaps++;
  }

  // the socket of this slot closed: the AI plays for the player from the next step, the match goes on
  leave(slot) {
    this.port[slot].conn = false;
    this.clearInput(slot);
    if (this.running && this.sim.state !== 'over') this.setAway(slot, true);
  }
}
