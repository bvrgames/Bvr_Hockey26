// Local stand-in for server/worker.js (bvr-hockey-relay) for online tests: same protocol — first socket in a room is the
// host, second the guest, every message is relayed verbatim to the other one; {t:'hello'|'full'|'peer'} as in the Worker.
// Network emulation (per direction, relayed game messages only): --lag <one-way ms> --jitter <±ms> --loss <%>.
// WebSocket runs over TCP, so a "lost" packet is not dropped: it arrives after a retransmission (+RTO) and everything
// sent after it waits behind it and then arrives in a burst — exactly how packet loss looks to a WebSocket game.
// usage: node tools/relay-mock.mjs [port=8787] [--lag 40 --jitter 15 --loss 1]
//        import { startRelay } from './relay-mock.mjs'; startRelay(port, { lag, jitter, loss }) → wss (+ wss.stats)
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';

export function startRelay(port = 8787, net = {}) {
  const lag = +net.lag || 0, jitter = +net.jitter || 0, loss = +net.loss || 0;
  const rooms = new Map();   // code -> { host, guest }
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  // traffic stats per message type (t) and direction
  const stats = { started: Date.now(), msgs: {}, bytes: {}, lost: 0 };
  wss.stats = stats;
  const nextAt = new WeakMap();   // per receiving socket: earliest delivery time (TCP keeps order)
  function deliver(to, data, isBinary) {
    if (!lag && !jitter && !loss) { to.send(data, { binary: isBinary }); return; }
    const now = Date.now();
    let t = now + lag + (jitter ? (Math.random() * 2 - 1) * jitter : 0);
    if (loss && Math.random() * 100 < loss) { t += Math.max(200, 2 * lag + 60); stats.lost++; }   // retransmission
    t = Math.max(t, nextAt.get(to) || 0);
    nextAt.set(to, t);
    setTimeout(() => { if (to.readyState === 1) to.send(data, { binary: isBinary }); }, Math.max(0, t - now));
  }
  const count = (r) => (r.host ? 1 : 0) + (r.guest ? 1 : 0);
  const peers = (r) => { const m = JSON.stringify({ t: 'peer', n: count(r) }); for (const s of [r.host, r.guest]) if (s) s.send(m); };
  wss.on('connection', (ws, req) => {
    const m = /^\/room\/([A-Za-z0-9_-]{2,16})(?:\?.*)?$/.exec(req.url || '');   // ?hint=… is for the real Worker
    if (!m) { ws.close(1008, 'bad path'); return; }
    const code = m[1].toUpperCase();
    const r = rooms.get(code) || { host: null, guest: null };
    rooms.set(code, r);
    let slot;
    if (!r.host) slot = 'host'; else if (!r.guest) slot = 'guest';
    else { ws.send(JSON.stringify({ t: 'full' })); ws.close(1000, 'room full'); return; }
    r[slot] = ws;
    const diag = () => ({ doColo: 'LOCAL', doLoc: 'XX', hint: 'mock', created: r.created || (r.created = Date.now()), st: Date.now(),
      conns: ['host', 'guest'].filter((k) => r[k]).map((k) => ({ slot: k, colo: 'LOCAL', country: 'XX' })) });
    ws.send(JSON.stringify({ t: 'hello', role: slot, n: count(r), diag: diag() }));
    peers(r);
    ws.on('message', (data, isBinary) => {
      // diagnostics are answered by the relay itself, like server/worker.js (with the emulated one-way lag both ways)
      const txt = data.toString();
      if (txt.startsWith('{"t":"png"') || txt.startsWith('{"t":"dg"')) {
        const m = JSON.parse(txt), reply = m.t === 'png' ? { t: 'pog', n: m.n, k: m.k, st: Date.now() } : { t: 'dgr', ...diag() };
        setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify(reply)); }, lag);
        return;
      }
      const to = slot === 'host' ? r.guest : r.host;
      const m = /^\{"t":"(\w+)"/.exec(data.toString().slice(0, 16));
      const key = `${slot}:${m ? m[1] : '?'}`;
      stats.msgs[key] = (stats.msgs[key] || 0) + 1;
      stats.bytes[key] = (stats.bytes[key] || 0) + data.length;
      if (to && r[slot] === ws) deliver(to, data, isBinary);
    });
    ws.on('close', () => { if (r[slot] === ws) r[slot] = null; peers(r); });
  });
  return new Promise((resolve) => wss.on('listening', () => resolve(wss)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? +a[i + 1] : d; };
  const port = +(a[0] && !a[0].startsWith('--') ? a[0] : 8787);
  const net = { lag: opt('lag', 0), jitter: opt('jitter', 0), loss: opt('loss', 0) };
  await startRelay(port, net);
  console.log(`relay mock on ws://127.0.0.1:${port}/room/<CODE>  lag ${net.lag} ms one-way, jitter ±${net.jitter} ms, loss ${net.loss}%`);
}
