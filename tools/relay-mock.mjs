// Local stand-in for server/worker.js (bvr-hockey-relay) for online tests: same protocol — first socket in a room is the
// host, second the guest, every message is relayed verbatim to the other one; {t:'hello'|'full'|'peer'} as in the Worker.
// usage: node tools/relay-mock.mjs [port=8787]   ·   import { startRelay } from './relay-mock.mjs'
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';

export function startRelay(port = 8787) {
  const rooms = new Map();   // code -> { host, guest }
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  const count = (r) => (r.host ? 1 : 0) + (r.guest ? 1 : 0);
  const peers = (r) => { const m = JSON.stringify({ t: 'peer', n: count(r) }); for (const s of [r.host, r.guest]) if (s) s.send(m); };
  wss.on('connection', (ws, req) => {
    const m = /^\/room\/([A-Za-z0-9_-]{2,16})$/.exec(req.url || '');
    if (!m) { ws.close(1008, 'bad path'); return; }
    const code = m[1].toUpperCase();
    const r = rooms.get(code) || { host: null, guest: null };
    rooms.set(code, r);
    let slot;
    if (!r.host) slot = 'host'; else if (!r.guest) slot = 'guest';
    else { ws.send(JSON.stringify({ t: 'full' })); ws.close(1000, 'room full'); return; }
    r[slot] = ws;
    ws.send(JSON.stringify({ t: 'hello', role: slot, n: count(r) }));
    peers(r);
    ws.on('message', (data, isBinary) => {
      const to = slot === 'host' ? r.guest : r.host;
      if (to && r[slot] === ws) to.send(data, { binary: isBinary });
    });
    ws.on('close', () => { if (r[slot] === ws) r[slot] = null; peers(r); });
  });
  return new Promise((resolve) => wss.on('listening', () => resolve(wss)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = +(process.argv[2] || 8787);
  await startRelay(port);
  console.log(`relay mock on ws://127.0.0.1:${port}/room/<CODE>`);
}
