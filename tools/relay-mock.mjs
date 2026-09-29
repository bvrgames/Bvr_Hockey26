// Local stand-in for server/worker.js (bvr-hockey-relay) for online tests: same protocol — first socket in a room is the
// host, second the guest, every message is relayed verbatim to the other one; {t:'hello'|'full'|'peer'} as in the Worker.
// Server mode (?mode=srv from whoever opens the empty room, like the Worker): the match runs here through
// server/room-sim.js — the same code the Durable Object runs — and both players get snapshots.
// Network emulation (per direction): --lag <one-way ms> --jitter <±ms> --loss <%>. Relay mode: applied to relayed game
// messages (one hop player → player). Server mode: applied on each player's link both ways (player → server → player),
// so RTT to the server = 2 × lag; per-player links via startRelay(port, { per: [{lag,jitter,loss}, {…}] }).
// WebSocket runs over TCP, so a "lost" packet is not dropped: it arrives after a retransmission (+RTO) and everything
// sent after it waits behind it and then arrives in a burst — exactly how packet loss looks to a WebSocket game.
// usage: node tools/relay-mock.mjs [port=8787] [--lag 40 --jitter 15 --loss 1]
//        import { startRelay } from './relay-mock.mjs'; startRelay(port, { lag, jitter, loss, per }) → wss (+ wss.stats)
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { MatchRoom, SIM_HZ } from '../server/room-sim.js';

export function startRelay(port = 8787, net = {}) {
  const base = { lag: +net.lag || 0, jitter: +net.jitter || 0, loss: +net.loss || 0 };
  const linkOf = (slot) => (net.per && net.per[slot]) || base;
  const rooms = new Map();   // code -> { host, guest, srv, match, timer }
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  // traffic stats per message type (t) and direction
  const stats = { started: Date.now(), msgs: {}, bytes: {}, lost: 0, rooms };
  wss.stats = stats;
  const nextAt = new WeakMap();   // per socket and direction: earliest delivery time (TCP keeps order)
  // schedule fn after the emulated one-way delay of `link`, in order per key
  function later(key, link, fn) {
    const { lag, jitter, loss } = link;
    if (!lag && !jitter && !loss) { fn(); return; }
    const now = Date.now();
    let t = now + lag + (jitter ? (Math.random() * 2 - 1) * jitter : 0);
    if (loss && Math.random() * 100 < loss) { t += Math.max(200, 2 * lag + 60); stats.lost++; }   // retransmission
    t = Math.max(t, nextAt.get(key) || 0);
    nextAt.set(key, t);
    setTimeout(fn, Math.max(0, t - now));
  }
  function deliver(to, data, isBinary, link) {
    later(to, link || base, () => { if (to.readyState === 1) to.send(data, { binary: isBinary }); });
  }
  const count = (r) => (r.host ? 1 : 0) + (r.guest ? 1 : 0);
  const peers = (r) => { const m = JSON.stringify({ t: 'peer', n: count(r) }); for (const s of [r.host, r.guest]) if (s) s.send(m); };
  wss.on('connection', (ws, req) => {
    const m = /^\/room\/([A-Za-z0-9_-]{2,16})(?:\?(.*))?$/.exec(req.url || '');   // ?hint=… is for the real Worker
    if (!m) { ws.close(1008, 'bad path'); return; }
    const code = m[1].toUpperCase(), q = new URLSearchParams(m[2] || '');
    const r = rooms.get(code) || { host: null, guest: null, srv: false, match: null, timer: null };
    rooms.set(code, r);
    let slot;
    if (!r.host) slot = 'host'; else if (!r.guest) slot = 'guest';
    else { ws.send(JSON.stringify({ t: 'full' })); ws.close(1000, 'room full'); return; }
    const si = slot === 'host' ? 0 : 1, up = {};   // `up` — key for this player's uplink order
    if (!r.host && !r.guest) {
      r.srv = q.get('mode') === 'srv';
      if (r.timer) { clearInterval(r.timer); r.timer = null; }
      r.match = r.srv ? new MatchRoom((s, txt) => { const to = s === 0 ? r.host : r.guest; if (to) deliver(to, txt, false, linkOf(s)); }) : null;
    }
    r[slot] = ws;
    const diag = () => ({ doColo: 'LOCAL', doLoc: 'XX', hint: 'mock', created: r.created || (r.created = Date.now()), st: Date.now(),
      mode: r.srv ? 'server' : 'relay', conns: ['host', 'guest'].filter((k) => r[k]).map((k) => ({ slot: k, colo: 'LOCAL', country: 'XX' })) });
    ws.send(JSON.stringify({ t: 'hello', role: slot, n: count(r), diag: diag(), srv: r.srv ? 1 : 0 }));
    peers(r);
    ws.on('message', (data, isBinary) => {
      const txt = data.toString();
      // diagnostics are answered by the relay itself, like server/worker.js (with the emulated one-way lag both ways)
      if (txt.startsWith('{"t":"png"') || txt.startsWith('{"t":"dg"')) {
        const mm = JSON.parse(txt), reply = mm.t === 'png' ? { t: 'pog', n: mm.n, k: mm.k, st: Date.now() } : { t: 'dgr', ...diag() };
        const L = r.srv ? linkOf(si) : base;
        setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify(reply)); }, L.lag * (r.srv ? 2 : 1));
        return;
      }
      const tm = /^\{"t":"(\w+)"/.exec(txt.slice(0, 16));
      const key = `${slot}:${tm ? tm[1] : '?'}`;
      stats.msgs[key] = (stats.msgs[key] || 0) + 1;
      stats.bytes[key] = (stats.bytes[key] || 0) + data.length;
      if (r[slot] !== ws) return;
      if (r.srv && r.match && tm && (tm[1] === 'i' || tm[1] === 'cfg' || tm[1] === 's')) {
        later(up, linkOf(si), () => {
          let msg = null; try { msg = JSON.parse(txt); } catch {}
          if (r[slot] !== ws || !r.match) return;
          if (r.match.onMessage(si, msg) && msg.t === 'cfg' && !r.timer) {
            r.timer = setInterval(() => { if (!r.match || !r.match.tick() || (!r.host && !r.guest)) { clearInterval(r.timer); r.timer = null; } }, 1000 / SIM_HZ);
          }
        });
        return;
      }
      const to = slot === 'host' ? r.guest : r.host;
      if (!to) return;
      if (r.srv) later(up, linkOf(si), () => deliver(to, data, isBinary, linkOf(1 - si)));   // player → server → player
      else deliver(to, data, isBinary);
    });
    ws.on('close', () => { if (r[slot] === ws) { r[slot] = null; if (r.match) r.match.leave(si); } peers(r); });
  });
  const close = wss.close.bind(wss);
  wss.close = (cb) => { for (const r of rooms.values()) if (r.timer) clearInterval(r.timer); return close(cb); };
  return new Promise((resolve) => wss.on('listening', () => resolve(wss)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? +a[i + 1] : d; };
  const port = +(a[0] && !a[0].startsWith('--') ? a[0] : 8787);
  const net = { lag: opt('lag', 0), jitter: opt('jitter', 0), loss: opt('loss', 0) };
  await startRelay(port, net);
  console.log(`relay mock on ws://127.0.0.1:${port}/room/<CODE>  lag ${net.lag} ms one-way, jitter ±${net.jitter} ms, loss ${net.loss}%` +
    '  (server mode: ?mode=srv from the first player)');
}
