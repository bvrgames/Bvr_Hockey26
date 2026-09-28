/**
 * BVR Hockey — online relay (Cloudflare Worker + Durable Objects)
 *
 * Reconstructed from the client protocol in index.html (see netConnect,
 * netSend, netSnap, netSendInput, netRecvSnap, netRecvInput — no server
 * source for this ever existed in the repo or on the Cloudflare account
 * it was deployed under; this restores it from the client's expectations).
 *
 * Protocol (all messages are JSON):
 *   client connects to  wss://<worker>/room/<CODE>   (CODE: 2-16 chars, [A-Za-z0-9_-])
 *                        optional ?hint=apac|apac-se|none|… — Durable Object location hint, only used when the room's
 *                        object is created for the first time (default: apac)
 *
 *   server -> client:
 *     {t:'hello', role:'host'|'guest', n:<peerCount 1|2>, diag}   sent once, right after connect
 *     {t:'full'}                                            room already has host+guest
 *     {t:'peer', n:<peerCount 0|1|2>}                        peer count changed (join/leave)
 *     {t:'cfg', a, b, min}     relayed verbatim, host -> guest (team picks + match length)
 *     {t:'s', d:[...], k}      relayed verbatim, host -> guest (state snapshot)
 *     {t:'i', m:[mx,mz], b, tc} relayed verbatim, guest -> host (input)
 *
 *   answered by the Durable Object itself (never relayed; phase 3.0 diagnostics):
 *     {t:'png', n, k}  ->  {t:'pog', n, k, st}      ping to the Durable Object, st = server time (ms)
 *     {t:'dg'}         ->  {t:'dgr', ...diag}       where the room lives and where each player connects from
 *   diag = { doColo, doLoc, hint, created, st, conns: [{ slot, colo, country }] }
 *
 *   HTTP: GET /diag             → the edge colo this request hit (no Durable Object involved)
 *         GET /room/<CODE>/diag → the room's diag (creates the object if it does not exist yet)
 *
 *   Everything else from one socket is relayed verbatim to "the other" socket in the room. Host-authoritative:
 *   only 'host' is expected to send 's', only 'guest' is expected to send 'i', but the relay itself does not enforce
 *   that — index.html's own role checks already gate it.
 *
 * One Durable Object instance per room code (env.ROOMS.idFromName(code)),
 * so state (who is host/guest) lives with the room, not the Worker.
 */

const ROOM_CODE_RE = /^\/room\/([A-Za-z0-9_-]{2,16})(\/diag)?$/;
const HINTS = new Set(['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me']);
const DEFAULT_HINT = 'apac';

export class Room {
  constructor(state, env) {
    this.state = state;
    this.host = null;   // { ws, colo, country }
    this.guest = null;  // { ws, colo, country }
    this.created = Date.now();   // this instance's start (the object may be evicted and restarted between matches)
    this.hint = null;
    this.doColo = null; this.doLoc = null; this._colo = null;
  }

  // where this Durable Object runs: an outbound request from inside it reports the data centre it leaves from
  colo() {
    if (!this._colo) {
      this._colo = fetch('https://www.cloudflare.com/cdn-cgi/trace')
        .then((r) => r.text())
        .then((t) => { const g = (k) => (new RegExp('^' + k + '=(.*)$', 'm').exec(t) || [])[1] || '?'; this.doColo = g('colo'); this.doLoc = g('loc'); })
        .catch(() => { this.doColo = 'unknown'; });
    }
    return this._colo;
  }

  diag() {
    const c = (slot, s) => (s ? { slot, colo: s.colo, country: s.country } : null);
    return { doColo: this.doColo, doLoc: this.doLoc, hint: this.hint, created: this.created, st: Date.now(),
             conns: [c('host', this.host), c('guest', this.guest)].filter(Boolean) };
  }

  async fetch(request) {
    const hint = request.headers.get('X-Loc-Hint');
    if (this.hint === null) this.hint = hint || 'none';
    await this.colo();
    if (new URL(request.url).pathname.endsWith('/diag')) {
      return new Response(JSON.stringify(this.diag()), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.handleSocket(server, { colo: request.headers.get('X-Edge-Colo') || '?', country: request.headers.get('X-Edge-Country') || '?' });

    return new Response(null, { status: 101, webSocket: client });
  }

  handleSocket(ws, where) {
    let slot; // 'host' | 'guest'

    if (!this.host) {
      slot = 'host';
      this.host = { ws, ...where };
    } else if (!this.guest) {
      slot = 'guest';
      this.guest = { ws, ...where };
    } else {
      // room already full
      try { ws.send(JSON.stringify({ t: 'full' })); } catch (e) {}
      try { ws.close(1000, 'room full'); } catch (e) {}
      return;
    }

    try {
      ws.send(JSON.stringify({ t: 'hello', role: slot, n: this.peerCount(), diag: this.diag() }));
    } catch (e) {}
    this.broadcastPeerCount();

    ws.addEventListener('message', (event) => {
      const from = slot === 'host' ? this.host : this.guest;
      if (!from || from.ws !== ws) return; // stale socket, ignore
      const data = event.data;
      // diagnostics are answered here and never relayed (cheap prefix test: game traffic is not parsed)
      if (typeof data === 'string' && data.length < 200 && (data.startsWith('{"t":"png"') || data.startsWith('{"t":"dg"'))) {
        let m = null; try { m = JSON.parse(data); } catch (e) {}
        if (m && m.t === 'png') { try { ws.send(JSON.stringify({ t: 'pog', n: m.n, k: m.k, st: Date.now() })); } catch (e) {} return; }
        if (m && m.t === 'dg') { try { ws.send(JSON.stringify({ t: 'dgr', ...this.diag() })); } catch (e) {} return; }
      }
      const to = slot === 'host' ? this.guest : this.host;
      if (to) {
        try { to.ws.send(data); } catch (e) {}
      }
    });

    const onLeave = () => {
      if (slot === 'host' && this.host && this.host.ws === ws) this.host = null;
      if (slot === 'guest' && this.guest && this.guest.ws === ws) this.guest = null;
      this.broadcastPeerCount();
    };
    ws.addEventListener('close', onLeave);
    ws.addEventListener('error', onLeave);
  }

  peerCount() {
    return (this.host ? 1 : 0) + (this.guest ? 1 : 0);
  }

  broadcastPeerCount() {
    const n = this.peerCount();
    const msg = JSON.stringify({ t: 'peer', n });
    if (this.host) { try { this.host.ws.send(msg); } catch (e) {} }
    if (this.guest) { try { this.guest.ws.send(msg); } catch (e) {} }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cf = request.cf || {};
    if (url.pathname === '/diag') {
      return new Response(JSON.stringify({ edgeColo: cf.colo || '?', country: cf.country || '?', st: Date.now() }),
        { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
    }
    const m = url.pathname.match(ROOM_CODE_RE);
    if (!m) {
      return new Response('BVR Hockey relay is up. Connect to /room/<CODE> over WebSocket.', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    const code = m[1].toUpperCase();
    const q = (url.searchParams.get('hint') || DEFAULT_HINT).toLowerCase();
    const hint = HINTS.has(q) ? q : null;          // 'none' (or anything unknown) → no hint
    const id = env.ROOMS.idFromName(code);
    // the hint is respected only by the first get() that creates this room's object
    const stub = hint ? env.ROOMS.get(id, { locationHint: hint }) : env.ROOMS.get(id);
    const fwd = new Request(request);
    fwd.headers.set('X-Loc-Hint', hint || 'none');
    fwd.headers.set('X-Edge-Colo', cf.colo || '?');
    fwd.headers.set('X-Edge-Country', cf.country || '?');
    return stub.fetch(fwd);
  },
};
