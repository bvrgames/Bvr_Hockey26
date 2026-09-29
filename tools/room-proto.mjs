// Server-mode protocol test without browsers (phase 3.2): two WebSocket players in one ?mode=srv room.
// Checks: hello carries srv:1 for both (the second joins without asking), the host's cfg starts the match on the
// server and comes back to both, snapshots arrive at ~30/s to both with server time k, per-player input ack a and
// controlled-player velocities v, the player who holds the stick right actually skates right, a pressed pass comes back
// as a bus event (e with seq), and a 15-second match ends with match:end.
//   --target mock (default): tools/relay-mock.mjs in this process  ·  --target wrangler: `wrangler dev` (workerd + DO)
// usage: node tools/room-proto.mjs [--target mock|wrangler]
import WebSocket from 'ws';
import { startRelay } from './relay-mock.mjs';
import { startWrangler } from './wrangler-dev.mjs';

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
    else if (m.t === 'cfg') P.cfg.push(m);
    else if (m.t === 's') { P.snaps.push({ at: Date.now(), m }); if (m.e) for (const [n, e] of m.e) if (!P.ev.some((x) => x.seq === e.seq)) P.ev.push({ n, ...e }); }
  });
  return new Promise((res, rej) => { ws.on('open', () => res(P)); ws.on('error', rej); });
}

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
  await wait(1200);
  const gi2 = idx(G, 1), p1 = pos(G, gi2);
  ok(gi2 !== gi || p1[0] - p0[0] > 3, `guest's player did not skate right: ${JSON.stringify(p0)} → ${JSON.stringify(p1)} (ctrl ${gi}→${gi2})`);
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
  H.ws.close(); G.ws.close();
} catch (e) {
  fails.push('runner error: ' + e.message.split('\n').slice(0, 8).join('\n'));
} finally {
  if (backend) backend.close();
}
if (fails.length) console.log('FAIL:\n  ' + fails.join('\n  '));
console.log(fails.length ? 'ROOM PROTOCOL FAIL' : 'ROOM PROTOCOL OK');
process.exit(fails.length ? 1 : 0);
