// Server-mode protocol test without browsers (phase 3.2): two WebSocket players in one ?mode=srv room.
// Checks: hello carries srv:1 for both (the second joins without asking), the host's cfg starts the match on the
// server and comes back to both, snapshots arrive at ~30/s to both with server time k, per-player input ack a and
// controlled-player velocities v, the player who holds the stick right actually skates right (by its velocity), a pressed pass comes back
// as a bus event (e with seq), and a 15-second match ends with match:end.
//   --target mock (default): tools/relay-mock.mjs in this process  ·  --target wrangler: `wrangler dev` (workerd + DO)
// usage: node tools/room-proto.mjs [--target mock|wrangler]
import WebSocket from 'ws';
import { startRelay } from './relay-mock.mjs';
import { startWrangler } from './wrangler-dev.mjs';
import { autoHint } from '../server/region.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const TARGET = opt('target', 'mock'), port = +opt('port', 8798);
const fails = [], ok = (c, m) => { if (!c) fails.push(m); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const room = 'PRT' + Math.floor(Math.random() * 1e5);

function player(q) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/room/${room}${q}`);
  const P = { ws, hello: null, cfg: [], snaps: [], ev: [], send: (o) => ws.send(JSON.stringify(o)) };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === 'hello') P.hello = m;
    else if (m.t === 'full') P.full = true;
    else if (m.t === 'cfg') P.cfg.push(m);
    else if (m.t === 's') { P.snaps.push({ at: Date.now(), m }); if (m.e) for (const [n, e] of m.e) if (!P.ev.some((x) => x.seq === e.seq)) P.ev.push({ n, ...e }); }
  });
  return new Promise((res, rej) => { ws.on('open', () => res(P)); ws.on('error', rej); });
}

// hint=auto: the room's region by the creator's country (server/region.js)
for (const [cf, want] of [[{ country: 'RU' }, 'eeur'], [{ country: 'KZ' }, 'eeur'], [{ country: 'ID' }, 'apac-se'],
  [{ country: 'JP' }, 'apac-ne'], [{ country: 'DE', continent: 'EU' }, 'weur'], [{ country: 'US', longitude: '-122.4' }, 'wnam'],
  [{ country: 'US', longitude: '-74' }, 'enam'], [{ country: 'BR', continent: 'SA' }, null], [{}, null]])
  ok(autoHint(cf) === want, `autoHint(${JSON.stringify(cf)}) = ${autoHint(cf)}, want ${want}`);

let backend = null;
const t0 = Date.now();
try {
  backend = TARGET === 'wrangler' ? await startWrangler(port) : await startRelay(port);
  const H = await player('?mode=srv'); await wait(300);
  const G = await player(''); await wait(400);
  ok(H.hello && H.hello.role === 'host' && H.hello.srv === 1, `host hello ${JSON.stringify(H.hello)}`);
  ok(G.hello && G.hello.role === 'guest' && G.hello.srv === 1, `guest hello ${JSON.stringify(G.hello)} (the room's mode must come from the room)`);

  H.send({ t: 'cfg', a: 0, b: 3, min: 3, id: '0123456789abcdef01234567' });
  await wait(1500);
  for (const [who, P] of [['host', H], ['guest', G]]) {
    ok(P.cfg.length === 1 && P.cfg[0].id === '0123456789abcdef01234567' && P.cfg[0].b === 3, `${who} cfg ${JSON.stringify(P.cfg)}`);
    const n = P.snaps.length, span = n > 1 ? (P.snaps[n - 1].at - P.snaps[0].at) / 1000 : 0;
    ok(n > 20 && n / span > 24 && n / span < 36, `${who}: ${n} snapshots in ${span.toFixed(2)} s`);
    const last = P.snaps[n - 1].m;
    ok(Array.isArray(last.d) && last.d.length === 20 + 12 * 6 && typeof last.k === 'number' && Array.isArray(last.v) && last.a === 0, `${who} snapshot shape ${JSON.stringify(last).slice(0, 200)}`);
  }
  // wait for play, then the guest holds the stick toward +x (world), the host stands still
  const idx = (P, t) => P.snaps[P.snaps.length - 1].m.d[7 + t];
  const pos = (P, i) => { const d = P.snaps[P.snaps.length - 1].m.d; return [d[20 + i * 6], d[21 + i * 6]]; };
  const tPlay = Date.now(); while (G.snaps[G.snaps.length - 1].m.d[6] !== 0 && Date.now() - tPlay < 3000) await wait(50);
  const gi = idx(G, 1), p0 = pos(G, gi);
  let q = 0;
  const iv = setInterval(() => { q++; G.send({ t: 'i', m: [1, 0], b: 0, q, c: [0, 0, 0, 0, 0], tc: 0 }); H.send({ t: 'i', m: [0, 0], b: 0, q, c: [0, 0, 0, 0, 0], tc: 0 }); }, 33);
  // The stick toward +x must make the guest's controlled player skate toward +x. Judged by its velocity (snapshot v[2] —
  // the controlled player of team 1, whoever it is now), not by the distance covered in a fixed time: at the drop of
  // the puck that player usually still skates the other way (~−2…−3 m/s) and has to turn, and the faceoff crowd may
  // block it, so 1.2 s gave 2.4…3.9 m against a 3 m threshold — a random fail. Here: within 2.5 s after input is
  // acknowledged it reaches over 3 m/s toward +x (it reaches ~5.7 in 0.3…0.9 s).
  const tIn = Date.now(); let vmax = -99, tFast = null;
  while (Date.now() - tIn < 2500) {
    await wait(30);
    const s = G.snaps[G.snaps.length - 1].m;
    if (s.a > 0) { vmax = Math.max(vmax, s.v[2]); if (tFast === null && s.v[2] > 3) tFast = Date.now() - tIn; }
    if (tFast !== null && Date.now() - tIn >= 1200) break;      // and keep input going ≥ 1.2 s for the ack check below
  }
  const gi2 = idx(G, 1), p1 = pos(G, gi2);
  ok(tFast !== null, `guest's player did not skate right: top speed toward +x ${vmax} m/s in 2.5 s, ${JSON.stringify(p0)} → ${JSON.stringify(p1)} (ctrl ${gi}→${gi2})`);
  const aG = G.snaps[G.snaps.length - 1].m.a, aH = H.snaps[H.snaps.length - 1].m.a;
  ok(aG > 20 && aG <= q && aH > 20, `input acks: guest a=${aG} host a=${aH} of q=${q}`);
  // give the guest's player the puck is impossible from outside — press pass/check counters and look for any event
  const evBefore = G.ev.length;
  G.send({ t: 'i', m: [1, 0], b: 1, q: ++q, c: [1, 0, 1, 0, 0], tc: 0 }); await wait(100);
  G.send({ t: 'i', m: [1, 0], b: 0, q: ++q, c: [1, 0, 1, 0, 0], tc: 0 });
  await wait(4000);
  clearInterval(iv);
  ok(G.ev.length > evBefore || G.ev.some((e) => e.n === 'faceoff'), `no bus events reached the guest (${G.ev.map((e) => e.n).join(',')})`);
  ok(H.ev.length === G.ev.length || Math.abs(H.ev.length - G.ev.length) <= 1, `events host ${H.ev.length} guest ${G.ev.length}`);
  ok(G.ev.every((e, i) => i === 0 || e.seq > G.ev[i - 1].seq), 'event seq not increasing');

  // a 15-second match must end with match:end for both
  H.send({ t: 'cfg', a: 1, b: 2, min: 0.25, id: 'fedcba9876543210fedcba98' });
  const tEnd = Date.now();
  while (!(H.ev.some((e) => e.n === 'match:end') && G.ev.some((e) => e.n === 'match:end')) && Date.now() - tEnd < 25000) await wait(200);
  ok(H.ev.some((e) => e.n === 'match:end') && G.ev.some((e) => e.n === 'match:end'), 'no match:end after the 15 s match');
  const lastD = G.snaps[G.snaps.length - 1].m.d;
  ok(lastD[6] === 4 && lastD[5] === 0, `final snapshot state ${lastD[6]} clock ${lastD[5]}`);
  console.log(`[${TARGET}] snapshots host ${H.snaps.length} guest ${G.snaps.length} · events ${G.ev.length} (${[...new Set(G.ev.map((e) => e.n))].join(', ')}) · final ${lastD[3]}:${lastD[4]} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // ---- lost players (phase 3.5) ----
  const wOf = (P) => P.snaps[P.snaps.length - 1].m.w | 0;
  H.send({ t: 'cfg', a: 0, b: 1, min: 2, id: 'aaaabbbbccccddddeeeeffff' });
  let q2 = q + 10;
  const feed = (P) => setInterval(() => P.send({ t: 'i', m: [0, 0], b: 0, q: ++q2, c: [1, 0, 1, 0, 0], tc: 0 }), 33);
  let ivH = feed(H), ivG = feed(G);
  await wait(1500);
  ok(wOf(H) === 0, `both play, w=${wOf(H)}`);
  // silent guest (socket open, no input): away after 2 s, back with the first input
  clearInterval(ivG); await wait(2600);
  ok(wOf(H) === 2 && wOf(G) === 2, `silent guest: w host ${wOf(H)} guest ${wOf(G)} (want 2)`);
  ivG = feed(G); await wait(400);
  ok(wOf(H) === 0, `guest sends input again: w=${wOf(H)}`);
  // a stranger with a wrong key cannot push a connected player out of the slot
  const X = await player('?re=host&tok=wrong'); await wait(300);
  ok(X.full && !X.hello, `wrong key in a full room must get "full": ${JSON.stringify(X.hello)}`);
  // closed socket: away at once; the right key returns into the same slot
  clearInterval(ivG); G.ws.close(); await wait(500);
  ok(wOf(H) === 2, `guest socket closed: w=${wOf(H)}`);
  // the dropped guest's slot is reserved while the match runs: a stranger with the room code gets "full"
  const Y = await player('?mode=srv'); await wait(300);
  ok(Y.full && !Y.hello, `a stranger must not take the dropped guest's slot: ${JSON.stringify(Y.hello && Y.hello.role)}`);
  const G2 = await player(`?mode=srv&re=guest&tok=${G.hello.tok}`); await wait(500);
  ok(G2.hello && G2.hello.role === 'guest' && G2.hello.run === 1 && G2.hello.tok === G.hello.tok, `returning guest hello ${JSON.stringify(G2.hello)}`);
  ok(G2.cfg.length === 1 && G2.cfg[0].id === 'aaaabbbbccccddddeeeeffff', `returning guest must get the running cfg: ${JSON.stringify(G2.cfg)}`);
  ok(G2.snaps.length > 5 && wOf(G2) === 2, `returning guest gets snapshots, still away until it sends input: ${G2.snaps.length}, w=${G2.snaps.length && wOf(G2)}`);
  ivG = feed(G2); await wait(400);
  ok(wOf(H) === 0, `guest returned: w=${wOf(H)}`);
  // both sockets gone: the match keeps running for a while, the host returns into it
  clearInterval(ivH); clearInterval(ivG);
  const clkA = H.snaps[H.snaps.length - 1].m.d[5];
  H.ws.close(); G2.ws.close(); await wait(3000);
  const Z = await player('?mode=srv'); await wait(300);
  ok(Z.full && !Z.hello, `a stranger must not take over an empty room with a running match: ${JSON.stringify(Z.hello && Z.hello.role)}`);
  const H2 = await player(`?mode=srv&re=host&tok=${H.hello.tok}`); await wait(600);
  ok(H2.hello && H2.hello.role === 'host' && H2.hello.run === 1, `host returns to the empty room: ${JSON.stringify(H2.hello)}`);
  ok(H2.cfg.length === 1 && H2.cfg[0].id === 'aaaabbbbccccddddeeeeffff' && H2.snaps.length > 5, `host returns: cfg ${H2.cfg.length}, snapshots ${H2.snaps.length}`);
  if (H2.snaps.length) ok(wOf(H2) === 3 && H2.snaps[H2.snaps.length - 1].m.d[5] < clkA, `empty room: w=${wOf(H2)}, clock ${clkA} → ${H2.snaps[H2.snaps.length - 1].m.d[5]}`);
  console.log(`[${TARGET}] lost players: wrong key / silent / closed / stranger / return / empty room checked`);
  H2.ws.close();
} catch (e) {
  fails.push('runner error: ' + e.message.split('\n').slice(0, 8).join('\n'));
} finally {
  if (backend) backend.close();
}
if (fails.length) console.log('FAIL:\n  ' + fails.join('\n  '));
console.log(fails.length ? 'ROOM PROTOCOL FAIL' : 'ROOM PROTOCOL OK');
process.exit(fails.length ? 1 : 0);
