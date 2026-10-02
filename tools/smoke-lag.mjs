// Online latency measurements: host + guest through tools/relay-mock.mjs with emulated network (RTT 0/80/150/250 ms,
// jitter, 1 % "loss" = TCP retransmission bursts). The guest plays by script; everything is measured in the pages on
// what is actually drawn (requestAnimationFrame), with the same measurements on the host as the no-network baseline.
//   · move    — guest stick → own player moves ≥ 3 cm on the guest screen (and in the host's authoritative snapshot)
//   · pass / shot — guest button → the puck leaves the player on the guest screen (> 0.5 m, no owner)
//   · shot at goal — 12 m out, only the goalie: how far the drawn puck goes past the goal line, frames it jumps back
//   · pickup  — guest's stick reaches a loose puck on the guest screen → the guest sees it owned (host decides)
//   · jerks   — per-frame jumps against constant-velocity motion (> 3 cm): own player / others / puck, per second
//   · snapshots — rate, interval jitter, size; inputs per second
//
// Default run — mobile comparison, host scheme vs server scheme (phase 3.4). Each player has their own link to the
// server: RTT and jitter (standard deviation of the RTT, like "jit" in the ?debug panel), 1 % loss bursts.
//   · host scheme: the match runs on the host's phone, the guest's path to it is guest → server → host, so the relay
//     gets the sum of both links (RTT_h + RTT_g, jitter of both); the host itself plays with zero delay;
//   · server scheme (the default; the host scheme is asked with &net=host): the match runs in relay-mock's MatchRoom (= the Durable Object's code), each player
//     over their own link. "(host)" values are the host's own — in this scheme they are networked too.
//   Scenarios A: host 140 ms / jit 55, guest 80 / jit 80 (the RZYT phone test); B: both 140 / jit 80.
//   ID (Indonesia, mobile internet, both players far from the room): host 200 ms / jit 100, guest 300 / jit 110, 2.5 %
//   loss bursts on each link — the default run is A,B,ID.
// --rtt 0,80,150,250 — the old host-scheme sweep (one relay hop, jitter 10 %).
// usage: node tools/smoke-lag.mjs [--scen A,B,ID] [--rtt …] [--json out.json] [--trials 5]
// Exit code 1 only on page errors / a broken run (the numbers themselves are a report, not pass/fail),
// or with --max-move / --max-lost thresholds when given.
import { writeFileSync } from 'node:fs';
import { startServer } from './serve.mjs';
import { startRelay } from './relay-mock.mjs';
import { openGame, isError } from './browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const TRIALS = +opt('trials', 5);
const port = +opt('port', 8502), rport = +opt('relay', 8795);
const NET_FOR = (rtt) => ({ lag: rtt / 2, jitter: rtt ? Math.max(5, rtt * 0.1) : 0, loss: rtt ? 1 : 0 });
// one-way ±J uniform on both halves of a round trip gives an RTT standard deviation of J·√(2/3)
const J_FOR_SD = (sd) => Math.round(sd * Math.sqrt(1.5));
const SCEN = { A: { host: [140, 55], guest: [80, 80] }, B: { host: [140, 80], guest: [140, 80] },
               ID: { host: [200, 100], guest: [300, 110], loss: 2.5 } };
const RUNS = [];
if (opt('rtt', null)) for (const rtt of opt('rtt').split(',').map(Number)) RUNS.push({ label: `RTT ${rtt}`, mode: 'host', net: NET_FOR(rtt), rtt });
else for (const k of opt('scen', 'A,B,ID').split(',')) {
  const s = SCEN[k]; if (!s) continue;
  const link = ([rtt, sd]) => ({ lag: rtt / 2, jitter: J_FOR_SD(sd), loss: s.loss || 1 });
  const h = link(s.host), g = link(s.guest);
  // host scheme: one relay hop carries both links — delays add up, jitters add in quadrature
  RUNS.push({ label: `${k} host`, mode: 'host', rtt: s.host[0] + s.guest[0],
              net: { lag: h.lag + g.lag, jitter: Math.round(Math.hypot(h.jitter, g.jitter)), loss: 2 * (s.loss || 1) }, scen: s });
  RUNS.push({ label: `${k} server`, mode: 'server', rtt: s.guest[0], net: { per: [h, g] }, scen: s });
}

// WebSocket wrapper, installed before the game loads: snapshot arrival times / sizes, inputs sent
const WS_HOOK = `(() => { const W = window.WebSocket; window.__net = { snaps: [], inputs: 0 };
  function H(u, p) { const ws = p ? new W(u, p) : new W(u);
    ws.addEventListener('message', (e) => { if (typeof e.data === 'string' && e.data.startsWith('{"t":"s"')) __net.snaps.push([performance.now(), e.data.length]); });
    const send = ws.send.bind(ws); ws.send = (d) => { if (typeof d === 'string' && d.startsWith('{"t":"i"')) __net.inputs++; return send(d); };
    return ws; }
  H.prototype = W.prototype; H.CONNECTING = 0; H.OPEN = 1; H.CLOSING = 2; H.CLOSED = 3; window.WebSocket = H; })();`;

// in-page helpers: frame sampler + latency probes (all timed on rAF = what the player sees)
const PAGE_HELPERS = `
window.__smp = { on: false, fr: [] };
(function loop(){ requestAnimationFrame(function(t){
  if (__smp.on) { var c = __hk.ctrl(), P = __hk.p, pk = __hk.puck, row = [t, c ? P.indexOf(c) : -1, pk.x, pk.z, pk.owner ? P.indexOf(pk.owner) : -1, __hk.st()];
    var au = window.__authPos && window.__follow() ? window.__authPos(window.__myIdx()) : null; __smp.au = __smp.au || []; __smp.au.push(au ? [au[0], au[1]] : null);
    __smp.src = __smp.src || []; var ni = __hk.netInfo ? __hk.netInfo() : null; __smp.src.push(ni ? (ni.pmode || ni.src) : null);
    for (var i = 0; i < P.length; i++) row.push(P[i].x, P[i].z, P[i].boxed || P[i].down > 0 ? 1 : 0);
    __smp.fr.push(row); }
  loop(); }); })();
window.__frames = function (test, timeout) { return new Promise(function (res) { var t0 = performance.now();
  (function poll(){ requestAnimationFrame(function (t) { var r = test(t); if (r !== undefined) return res(r); if (t - t0 > timeout) return res(-1); poll(); }); })(); }); };
// this page follows someone else's simulation (the guest of the host scheme, or either player in server mode)
window.__follow = function () { var n = __hk.net(); return !!(n.on && (n.role === 'guest' || n.srv)); };
window.__myIdx = function () { var b = __hk.net().b; return b ? (__hk.human() === 0 ? b[7] : b[8]) : -1; };
window.__authPos = function (i) { var b = __hk.net().b; return b && i >= 0 ? [b[20 + i * 6], b[21 + i * 6]] : null; };
window.__moveLat = function (dx, dz) {           // → [screen ms, authoritative ms or -1]
  // record 700 ms of drawn (and, on the guest, authoritative) positions, then measure along the final direction
  var c = __hk.ctrl(), t0 = performance.now(), guest = window.__follow();
  var mi = window.__myIdx(), S = [], A = [];
  __hk.move(dx, dz);
  return __frames(function (t) {
    var c2 = __hk.ctrl(); S.push([t - t0, c2.x, c2.z]);
    if (guest) { var au = window.__authPos(mi); if (au) A.push([t - t0, au[0], au[1]]); }
    if (t - t0 >= 700) return 1;
  }, 1500).then(function () {
    function lat(P) { if (P.length < 2) return -1; var ex = P[P.length - 1][1] - P[0][1], ez = P[P.length - 1][2] - P[0][2], L = Math.hypot(ex, ez);
      if (L < 0.05) return -1; ex /= L; ez /= L;
      for (var i = 0; i < P.length; i++) if ((P[i][1] - P[0][1]) * ex + (P[i][2] - P[0][2]) * ez >= 0.03) return Math.round(P[i][0]);
      return -1; }
    var sc = lat(S); return [sc, guest ? lat(A) : sc];
  });
};
window.__actLat = function (btn) {             // → [drawn puck leaves (ms), host released it (ms)]; -1 lost, -2 invalid
  var me = __hk.ctrl(); if (__hk.puck.owner !== me) return Promise.resolve([-2, -2]);
  var x0 = __hk.puck.x, z0 = __hk.puck.z, t0 = performance.now(), vis = -1;
  __hk.press(btn);
  return __frames(function (t) {
    var pk = __hk.puck;
    if (pk.owner && pk.owner !== me) return [-2, -2];
    if (vis < 0 && Math.hypot(pk.x - x0, pk.z - z0) > 0.5) vis = t - t0;
    if (vis >= 0 && !pk.owner) return [vis, t - t0];
  }, 2000).then(function (r) { return r === -1 ? [vis, -1] : r; });
};
window.__pickup = function () {                // guest skates into a loose puck → [touch, drawn on the stick, owned by host] (ms)
  var me = __hk.ctrl(), tTouch = -1, tVis = -1, t0 = performance.now();
  return __frames(function (t) {
    var pk = __hk.puck;
    if (pk.owner && pk.owner !== me) return [-2, -2, -2];
    var sx = me.x + Math.cos(me.yaw) * 0.95, sz = me.z + Math.sin(me.yaw) * 0.95, d = Math.hypot(sx - pk.x, sz - pk.z);
    if (tTouch < 0 && d < 0.85) tTouch = t - t0;
    if (tTouch >= 0 && tVis < 0 && d < 0.12) tVis = t - t0;
    if (pk.owner === me) return [tTouch, tVis < 0 ? t - t0 : tVis, t - t0];
  }, 3000).then(function (r) { return r === -1 ? [tTouch, tVis, -1] : r; });
};
window.__goalShot = function () {              // shot at the goal → [drawn puck past the goal line, m; frames it jumps back ≥ 25 cm]
  var me = __hk.ctrl(); if (__hk.puck.owner !== me) return Promise.resolve(null);
  var ad = __hk.ad(), gl = ad * BVRSim.GOAL_X, past = 0, back = 0, px = __hk.puck.x, t0 = performance.now();
  __hk.press('B');
  return __frames(function (t) {
    var pk = __hk.puck; if (__hk.st() !== 'play') return 1;
    past = Math.max(past, (pk.x - gl) * ad); if ((px - pk.x) * ad > 0.25) back++; px = pk.x;
    if (t - t0 > 1500) return 1;
  }, 2500).then(function () { return [+past.toFixed(2), back]; });
};`;

const BOT = `window.__bot = setInterval(function(){ var a = Math.random() * 6.283; __hk.move(Math.cos(a) * 0.9, Math.sin(a) * 0.9); }, 650);`;

function jerks(frames, pick) {
  // jump = deviation of this frame's step from the previous step, scaled to the frame time (m)
  const out = []; let n = 0;
  for (let i = 2; i < frames.length; i++) {
    const a = pick(frames[i - 2]), b = pick(frames[i - 1]), c = pick(frames[i]);
    if (!a || !b || !c) continue;
    if (a[2] !== undefined && (a[2] !== b[2] || b[2] !== c[2])) continue;   // controlled player switched
    if (frames[i][5] !== 'play' || frames[i - 2][5] !== 'play') continue;
    const dt1 = frames[i - 1][0] - frames[i - 2][0], dt2 = frames[i][0] - frames[i - 1][0];
    if (dt1 <= 0 || dt2 <= 0) continue;
    const k = dt2 / dt1, jx = (c[0] - b[0]) - (b[0] - a[0]) * k, jz = (c[1] - b[1]) - (b[1] - a[1]) * k, j = Math.hypot(jx, jz);
    if (Math.hypot(c[0] - b[0], c[1] - b[1]) > 2) continue;          // teleport (faceoff, penalty)
    n++; out.push(j);
  }
  const secs = frames.length > 1 ? (frames[frames.length - 1][0] - frames[0][0]) / 1000 : 1;
  const big = out.filter((j) => j > 0.03);
  out.sort((x, y) => x - y);
  return { perSec: +(big.length / secs).toFixed(2), meanCm: big.length ? +(100 * big.reduce((s, v) => s + v, 0) / big.length).toFixed(1) : 0,
           p95Cm: out.length ? +(100 * out[Math.floor(out.length * 0.95)]).toFixed(2) : 0, n };
}
function frameJerks(frames) {
  const own = jerks(frames, (f) => (f[1] >= 0 && !f[6 + f[1] * 3 + 2] ? [f[6 + f[1] * 3], f[6 + f[1] * 3 + 1], f[1]] : null));
  // others: every non-own, non-boxed player, averaged per player
  const np = (frames[0].length - 6) / 3; let per = 0, mean = 0, p95 = 0, cnt = 0;
  for (let i = 0; i < np; i++) {
    const r = jerks(frames, (f) => (i !== f[1] && !f[6 + i * 3 + 2] ? [f[6 + i * 3], f[6 + i * 3 + 1]] : null));
    if (!r.n) continue; per += r.perSec; mean += r.meanCm; p95 += r.p95Cm; cnt++;
  }
  const puck = jerks(frames, (f) => [f[2], f[3]]);
  return { own, others: { perSec: +(per / cnt).toFixed(2), meanCm: +(mean / cnt).toFixed(1), p95Cm: +(p95 / cnt).toFixed(2) }, puck };
}
const med = (a) => { const v = a.filter((x) => x >= 0).sort((x, y) => x - y); return v.length ? Math.round(v[Math.floor(v.length / 2)]) : -1; };

const srv = await startServer(port);
const results = [];
let broken = false;
for (const run of RUNS) {
  const { rtt, net, mode } = run;
  const relay = await startRelay(rport, net);
  const room = 'LAG' + Math.floor(Math.random() * 1e5);
  const url = `http://127.0.0.1:${port}/index.html?room=${room}&srv=http://127.0.0.1:${rport}&seed=3${mode === 'server' ? '' : '&net=host'}`;
  const sides = {};
  const R = { label: run.label, mode, rtt, net, scen: run.scen, errors: [] };
  // test set-ups change the authoritative match: the host's page in the host scheme, relay-mock's simulation (same
  // process) in server mode. fn(HS, puck, players) must be self-contained (it is also sent into the page as text).
  const setup = async (fn) => {
    if (mode !== 'server') return sides.host.page.evaluate(`(${fn})(__hk.hs(), __hk.puck, __hk.p)`);
    const S = relay.stats.rooms.get(room).match.sim; return fn(S.HS, S.puck, S.players);
  };
  try {
    for (const who of ['host', 'guest']) {
      const g = await openGame('chromium', { w: 1280, h: 720 });
      await g.page.addInitScript(WS_HOOK);
      await g.page.goto(url, { waitUntil: 'load', timeout: 120000 });
      await g.page.waitForFunction(`window.__hk && __hk.net().role==="${who}"`, null, { timeout: 30000 });
      await g.page.evaluate(PAGE_HELPERS);
      sides[who] = g;
    }
    const H = sides.host.page, G = sides.guest.page;
    await H.waitForFunction('__hk.net().peer', null, { timeout: 10000 });
    await H.evaluate('__hk.start()');
    await G.waitForFunction('__hk.st()==="play"', null, { timeout: 15000 });
    await H.waitForTimeout(1500);

    // --- jerks + snapshot stream: 10 s of scripted play on both sides
    await H.evaluate(BOT); await G.evaluate(BOT);
    await G.evaluate('__net.snaps.length=0; __net.inputs=0; __smp.fr.length=0; __smp.on=true; var L=__hk.netInfo().pl; L.fr=L.ex=L.hold=L.back=0');
    await H.evaluate('__smp.fr.length=0; __smp.on=true');
    await G.waitForTimeout(10000);
    await G.evaluate('__smp.on=false'); await H.evaluate('__smp.on=false');
    const gFrames = await G.evaluate('__smp.fr'), hFrames = await H.evaluate('__smp.fr'), gAuth = await G.evaluate('__smp.au||[]');
    const gSrc = await G.evaluate('__smp.src||[]');
    { // where do the guest's puck jerks happen: by drawing source (and source changes)
      const off = gSrc.length - gFrames.length, by = {};
      for (let i = 2; i < gFrames.length; i++) {
        const a = gFrames[i - 2], b = gFrames[i - 1], c = gFrames[i]; if (c[5] !== 'play' || a[5] !== 'play') continue;
        const k = (c[0] - b[0]) / (b[0] - a[0] || 1), j = Math.hypot((c[2] - b[2]) - (b[2] - a[2]) * k, (c[3] - b[3]) - (b[3] - a[3]) * k);
        if (j <= 0.03 || Math.hypot(c[2] - b[2], c[3] - b[3]) > 2) continue;
        const s0 = gSrc[i - 1 + off], s1 = gSrc[i + off], key = s0 === s1 ? String(s1) : `${s0}→${s1}`;
        by[key] = (by[key] || 0) + 1;
      }
      R.puckJerkBySrc = by;
    }
    const snaps = await G.evaluate('__net.snaps'), inputs = await G.evaluate('__net.inputs');
    // playout of the snapshot buffer on the guest: frames drawn past the newest snapshot (extrapolated), past the
    // extrapolation limit (others stand still, then jump), frames where the shown server time went backwards
    { const L = await G.evaluate('__hk.netInfo().pl'), pc = (v) => +(100 * v / Math.max(1, L.fr)).toFixed(1);
      R.playout = { ex: pc(L.ex), hold: pc(L.hold), backPerSec: +(L.back / 10).toFixed(1), D: (await G.evaluate('__hk.netInfo().D')) }; }
    await H.evaluate('clearInterval(__bot); __hk.move(0,0)'); await G.evaluate('clearInterval(__bot); __hk.move(0,0)');
    const iv = snaps.slice(1).map((s, i) => s[0] - snaps[i][0]);
    const ivMean = iv.reduce((a, b) => a + b, 0) / iv.length;
    const ivSd = Math.sqrt(iv.reduce((a, b) => a + (b - ivMean) ** 2, 0) / iv.length);
    const ivS = [...iv].sort((a, b) => a - b);
    R.snap = { perSec: +(snaps.length / 10).toFixed(1), meanMs: Math.round(ivMean), sdMs: Math.round(ivSd), p95Ms: Math.round(ivS[Math.floor(ivS.length * 0.95)]),
               maxMs: Math.round(ivS[ivS.length - 1]), bytes: Math.round(snaps.reduce((a, s) => a + s[1], 0) / snaps.length), inputsPerSec: +(inputs / 10).toFixed(1) };
    R.jerkGuest = frameJerks(gFrames); R.jerkHost = frameJerks(hFrames);
    // how far the guest's drawn own player is ahead of its position in the host's snapshot, along the motion.
    // Correct prediction: ≈ speed × (input delay + snapshot age) — grows with RTT. Near 0 = the own player lags.
    { const off = gAuth.length - gFrames.length; let sum = 0, n = 0, spd = 0;
      for (let i = 1; i < gFrames.length; i++) {
        const f = gFrames[i], fp = gFrames[i - 1], a = gAuth[i + off]; if (!a || f[1] < 0 || f[5] !== 'play') continue;
        const x = f[6 + f[1] * 3], z = f[7 + f[1] * 3], px = fp[6 + fp[1] * 3], pz = fp[7 + fp[1] * 3], dt = (f[0] - fp[0]) / 1000;
        const vx = (x - px) / dt, vz = (z - pz) / dt, v = Math.hypot(vx, vz); if (v < 2 || fp[1] !== f[1]) continue;
        sum += ((x - a[0]) * vx + (z - a[1]) * vz) / v; spd += v; n++; }
      R.lead = { cm: n ? Math.round(100 * sum / n) : 0, ms: n ? Math.round(1000 * sum / spd) : 0 }; }

    // --- move latency (stand still, then push the stick)
    const mv = { gScr: [], gAuth: [], hScr: [] };
    for (let i = 0; i < TRIALS; i++) {
      const d = i % 2 ? [-1, 0] : [1, 0];
      await G.evaluate('__hk.move(0,0)'); await H.evaluate('__hk.move(0,0)'); await G.waitForTimeout(3000);   // coasting dies out
      const gr = await G.evaluate(`__moveLat(${d[0]},${d[1]})`); mv.gScr.push(gr[0]); mv.gAuth.push(gr[1]);
      const hr = await H.evaluate(`__moveLat(${d[0]},${d[1]})`); mv.hScr.push(hr[0]);
    }
    await G.evaluate('__hk.move(0,0)'); await H.evaluate('__hk.move(0,0)');
    R.move = { guestScreen: med(mv.gScr), guestAuth: med(mv.gAuth), host: med(mv.hScr), raw: mv };

    // --- pass (A) and shot (B): give the puck, wait until both see it, press
    const act = { pass: { g: [], gc: [], h: [] }, shot: { g: [], gc: [], h: [] } };
    for (const [kind, btn] of [['pass', 'A'], ['shot', 'B']]) {
      for (let i = 0; i < TRIALS; i++) {
        await setup(function (hs, puck) { var g = hs[1].ctrl; puck.owner = g; g.vx = g.vz = 0; });
        await G.waitForTimeout(700);
        const ga = await G.evaluate(`__actLat("${btn}")`); act[kind].g.push(ga[0]); act[kind].gc.push(ga[1]);
        await H.waitForTimeout(400);
        await setup(function (hs, puck) { var h = hs[0].ctrl; puck.owner = h; h.vx = h.vz = 0; });
        await H.waitForTimeout(mode === 'server' ? 700 : 300);   // server mode: the host too waits for the snapshot
        act[kind].h.push((await H.evaluate(`__actLat("${btn}")`))[0]);
        await H.waitForTimeout(400);
      }
    }
    const lost = (a) => a.filter((x) => x === -1).length, valid = (a) => a.filter((x) => x !== -2).length;
    R.pass = { guest: med(act.pass.g), confirm: med(act.pass.gc), host: med(act.pass.h), guestLost: `${lost(act.pass.gc)}/${valid(act.pass.gc)}`, raw: act.pass };
    R.shot = { guest: med(act.shot.g), confirm: med(act.shot.gc), host: med(act.shot.h), guestLost: `${lost(act.shot.gc)}/${valid(act.shot.gc)}`, raw: act.shot };

    // --- pickup: guest skates, host drops a loose puck 3 m ahead of the guest's player (host's view of it)
    const pk = [], pkv = [];
    for (let i = 0; i < TRIALS; i++) {
      await G.evaluate(`__hk.move(${i % 2 ? -1 : 1},0)`); await G.waitForTimeout(700);
      // host: loose puck 6 m ahead of the guest's player (host's view); every other skater is moved 14 m away so
      // nobody else can reach it during the trial
      await setup(function (hs, p, pl) { var g = hs[1].ctrl, v = Math.hypot(g.vx, g.vz) || 1; p.owner = null; p.x = g.x + g.vx / v * 6; p.z = g.z + g.vz / v * 6; p.vx = p.vz = 0; p.vy = 0; p.y = 0.05; p.free = 0;
        pl.forEach(function (o) { if (o !== g && !o.goalie && !o.boxed && Math.hypot(o.x - p.x, o.z - p.z) < 14) { var d = Math.hypot(o.x - p.x, o.z - p.z) || 1; o.x = Math.max(-27, Math.min(27, p.x + (o.x - p.x) / d * 14)); o.z = Math.max(-12, Math.min(12, p.z + (o.z - p.z) / d * 14)); o.vx = o.vz = 0; } }); });
      // start timing only once the guest actually sees the loose puck (the snapshot with it has arrived)
      // …and until the drawn puck is really at its new spot (the drawn puck trails the snapshots by the interpolation delay)
      const seen = await G.waitForFunction('(function(){ var c=__hk.ctrl(), p=__hk.puck; return p.owner!==c && Math.hypot(c.x+Math.cos(c.yaw)*0.95-p.x, c.z+Math.sin(c.yaw)*0.95-p.z)>2; })()', null, { timeout: 3000 }).then(() => true, () => false);
      const r = seen ? await G.evaluate('__pickup()') : [-2, -2, -2];
      if (r[0] >= 0 && r[2] >= 0) { pk.push(r[2] - r[0]); pkv.push(r[1] - r[0]); } else if (r[0] >= 0 && r[2] === -1) { pk.push(-1); pkv.push(r[1] >= 0 ? r[1] - r[0] : -1); }
      await G.evaluate('__hk.move(0,0)'); await G.waitForTimeout(600);
    }
    R.pickup = { waitMs: med(pk), visMs: med(pkv), lost: pk.filter((x) => x === -1).length, trials: pk.length, raw: pk, rawVis: pkv };

    // --- shot at the goal: the guest stands 12 m out with the puck, only the goalie in the way. The guest's predicted
    // flight must not pass through the goalie / net and then jump back when the snapshots show the save
    const gs = [];
    for (let i = 0; i < TRIALS; i++) {
      await G.evaluate('__hk.move(0,0)');
      await setup(function (hs, puck, pl) { var g = hs[1].ctrl; g.x = -14; g.z = [-2, 2, 0][Math.floor(Math.random() * 3)]; g.vx = g.vz = 0; g.yaw = Math.PI; puck.owner = g;
        pl.forEach(function (o) { if (o !== g && !o.goalie && !o.boxed) { o.x = 20; o.vx = o.vz = 0; } }); });
      const seen = await G.waitForFunction('__hk.puck.owner===__hk.ctrl() && Math.abs(__hk.ctrl().x+14)<1', null, { timeout: 3000 }).then(() => true, () => false);
      await G.waitForTimeout(300);
      const r = seen ? await G.evaluate('__goalShot()') : null;
      if (r) gs.push(r);
      await G.waitForTimeout(1200);
    }
    R.goalShot = { pastM: med(gs.map((r) => r[0] * 100)) / 100, back: med(gs.map((r) => r[1])), trials: gs.length, raw: gs };
    R.relay = { msgs: relay.stats.msgs, bytes: relay.stats.bytes, lost: relay.stats.lost };
    for (const [who, g] of Object.entries(sides)) {
      for (const e of g.logs.filter(isError)) R.errors.push(`${who} [${e.type}] ${e.text}`);
      for (const e of await g.page.evaluate('__hk.errors()')) R.errors.push(`${who} [window] ${e}`);
    }
  } catch (e) {
    R.errors.push('runner error: ' + e.message.split('\n')[0]); broken = true;
  } finally {
    for (const g of Object.values(sides)) await g.browser.close();
    relay.close();
  }
  if (R.errors.length) broken = true;
  results.push(R);
  console.log(`${run.label} done${R.errors.length ? ' — ERRORS: ' + R.errors.join(' | ') : ''}`);
}
srv.close();

// ---------- report
const cols = results.map((r) => r.label);
const row = (name, f) => console.log(name.padEnd(46) + results.map((r) => String(f(r) ?? '—').padStart(12)).join(''));
console.log('\n' + ''.padEnd(46) + cols.map((c) => c.padStart(12)).join(''));
if (results.some((r) => r.scen)) {
  console.log('(RTT/jit to server: host, guest)'.padEnd(46) + results.map((r) => (r.scen ? `${r.scen.host.join('/')} ${r.scen.guest.join('/')}` : '').padStart(12)).join(''));
  console.log('(emulated one-way lag ±jitter, loss)'.padEnd(46) + results.map((r) => (r.net.per ? `${r.net.per[0].lag}±${r.net.per[0].jitter} ${r.net.per[1].lag}±${r.net.per[1].jitter}` : `${r.net.lag}±${r.net.jitter} ${r.net.loss}%`).padStart(12)).join(''));
} else console.log('(one-way lag / jitter / loss)'.padEnd(46) + results.map((r) => `${r.net.lag}/${Math.round(r.net.jitter)}/${r.net.loss}%`.padStart(12)).join(''));
row('move: guest screen, ms (host)', (r) => r.move && `${r.move.guestScreen} (${r.move.host})`);
row('move: guest in authoritative snapshot, ms', (r) => r.move && r.move.guestAuth);
row('pass: guest press → drawn puck leaves (host)', (r) => r.pass && `${r.pass.guest} (${r.pass.host})`);
row('  … host releases it (guest sees), ms', (r) => r.pass && r.pass.confirm);
row('shot: guest press → drawn puck leaves (host)', (r) => r.shot && `${r.shot.guest} (${r.shot.host})`);
row('  … host releases it (guest sees), ms', (r) => r.shot && r.shot.confirm);
row('pass / shot presses lost (of valid)', (r) => r.pass && `${r.pass.guestLost} ${r.shot.guestLost}`);
row('pickup: touch → puck drawn on stick, ms', (r) => r.pickup && r.pickup.visMs);
row('pickup: touch → host owns it, ms (never/n)', (r) => r.pickup && `${r.pickup.waitMs} (${r.pickup.lost}/${r.pickup.trials})`);
row('shot at goal: drawn puck past goal line m / back', (r) => r.goalShot && `${r.goalShot.pastM} / ${r.goalShot.back}`);
row('own player ahead of its snapshot: cm / ms', (r) => r.lead && `${r.lead.cm} / ${r.lead.ms}`);
row('own player jerks >3 cm /s (mean cm)', (r) => r.jerkGuest && `${r.jerkGuest.own.perSec} (${r.jerkGuest.own.meanCm})`);
row('  host own player jerks /s', (r) => r.jerkHost && r.jerkHost.own.perSec);
row('other players jerks /s (mean cm)', (r) => r.jerkGuest && `${r.jerkGuest.others.perSec} (${r.jerkGuest.others.meanCm})`);
row('  host other players jerks /s', (r) => r.jerkHost && r.jerkHost.others.perSec);
row('others p95 frame jump, cm (host)', (r) => r.jerkGuest && `${r.jerkGuest.others.p95Cm} (${r.jerkHost.others.p95Cm})`);
row('puck jerks /s (mean cm) (host /s)', (r) => r.jerkGuest && `${r.jerkGuest.puck.perSec} (${r.jerkGuest.puck.meanCm}) (${r.jerkHost.puck.perSec})`);
row('  puck jerks by drawing source (count)', (r) => r.puckJerkBySrc && Object.entries(r.puckJerkBySrc).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([k, v]) => `${k}:${v}`).join(' '));
row('guest playout: extrapolated % / held % (D ms)', (r) => r.playout && `${r.playout.ex} / ${r.playout.hold} (${r.playout.D})`);
row('  shown server time goes back /s', (r) => r.playout && r.playout.backPerSec);
row('snapshots /s, interval mean±sd ms', (r) => r.snap && `${r.snap.perSec} ${r.snap.meanMs}±${r.snap.sdMs}`);
row('snapshot interval p95 / max ms', (r) => r.snap && `${r.snap.p95Ms}/${r.snap.maxMs}`);
row('snapshot bytes, guest inputs /s', (r) => r.snap && `${r.snap.bytes} B, ${r.snap.inputsPerSec}`);
if (opt('json')) writeFileSync(opt('json'), JSON.stringify(results, null, 1));
const maxMove = opt('max-move', null);
let fail = broken;
if (maxMove) for (const r of results) if (r.move && r.move.guestScreen > +maxMove) { console.log(`FAIL: RTT ${r.rtt}: guest move ${r.move.guestScreen} ms > ${maxMove}`); fail = true; }
console.log(fail ? '\nLAG RUN FAIL' : '\nLAG RUN OK');
process.exit(fail ? 1 : 0);
