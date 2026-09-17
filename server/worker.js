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
 *
 *   server -> client:
 *     {t:'hello', role:'host'|'guest', n:<peerCount 1|2>}   sent once, right after connect
 *     {t:'full'}                                            room already has host+guest
 *     {t:'peer', n:<peerCount 0|1|2>}                        peer count changed (join/leave)
 *     {t:'cfg', a, b, min}     relayed verbatim, host -> guest (team picks + match length)
 *     {t:'s', d:[...], k}      relayed verbatim, host -> guest (state snapshot, ~18Hz)
 *     {t:'i', m:[mx,mz], b, tc} relayed verbatim, guest -> host (input, ~30Hz)
 *
 *   client -> server: the same {t:'cfg'|'s'|'i', ...} payloads — the
 *   server does not inspect them, it only relays to "the other" socket
 *   in the room. Host-authoritative: only 'host' is expected to send
 *   's', only 'guest' is expected to send 'i', but the relay itself does
 *   not enforce that — index.html's own role checks already gate it.
 *
 * One Durable Object instance per room code (env.ROOMS.idFromName(code)),
 * so state (who is host/guest) lives with the room, not the Worker.
 */

const ROOM_CODE_RE = /^\/room\/([A-Za-z0-9_-]{2,16})$/;

export class Room {
  constructor(state, env) {
    this.state = state;
    this.host = null;   // { ws }
    this.guest = null;  // { ws }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.handleSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  handleSocket(ws) {
    let slot; // 'host' | 'guest'

    if (!this.host) {
      slot = 'host';
      this.host = { ws };
    } else if (!this.guest) {
      slot = 'guest';
      this.guest = { ws };
    } else {
      // room already full
      try { ws.send(JSON.stringify({ t: 'full' })); } catch (e) {}
      try { ws.close(1000, 'room full'); } catch (e) {}
      return;
    }

    try {
      ws.send(JSON.stringify({ t: 'hello', role: slot, n: this.peerCount() }));
    } catch (e) {}
    this.broadcastPeerCount();

    ws.addEventListener('message', (event) => {
      const from = slot === 'host' ? this.host : this.guest;
      if (!from || from.ws !== ws) return; // stale socket, ignore
      const to = slot === 'host' ? this.guest : this.host;
      if (to) {
        try { to.ws.send(event.data); } catch (e) {}
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
    const m = url.pathname.match(ROOM_CODE_RE);
    if (!m) {
      return new Response('BVR Hockey relay is up. Connect to /room/<CODE> over WebSocket.', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    const code = m[1].toUpperCase();
    const id = env.ROOMS.idFromName(code);
    const stub = env.ROOMS.get(id);
    return stub.fetch(request);
  },
};
