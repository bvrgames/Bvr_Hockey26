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
 *                        object is created for the first time (default: apac-se; the game sends apac-se itself)
 *
 *   server -> client:
 *     {t:'hello', role:'host'|'guest', n:<peerCount 1|2>, diag, srv, tok, run}   sent once, right after connect
 *                        tok — this player's secret key to the slot; reconnecting with ?re=<role>&tok=<tok> gives the
 *                        same slot back (and replaces a socket the server still thinks is alive); &fresh=1 — a new page
 *                        (key from sessionStorage), its input counters start again; run — a server match is on.
 *                        While a server match runs, the slot of a player who dropped is reserved: without the key
 *                        the answer is {t:'full'}
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
 *         /v1/match, /v1/profile → coins and player stats (server/api.js, D1 binding DB, secret BOT_TOKEN)
 *
 *   Everything else from one socket is relayed verbatim to "the other" socket in the room. Host-authoritative:
 *   only 'host' is expected to send 's', only 'guest' is expected to send 'i', but the relay itself does not enforce
 *   that — index.html's own role checks already gate it.
 *
 *   Server mode (phase 3.2, ?mode=srv from the player who opens an empty room; hello then carries srv:1 and the
 *   second player follows it): the Durable Object itself runs the match — shared/sim.js through server/room-sim.js,
 *   60 Hz steps, 30 Hz snapshots to both. 'cfg' (from the host) and 'i' (from both) are consumed here; the rest
 *   (opponent ping pp/pq) is still relayed. See room-sim.js for the message formats. A player who drops is played
 *   by the AI until they come back (same slot through ?re=&tok=); the match keeps running with nobody connected
 *   for up to 30 s, so both can return.
 *
 * One Durable Object instance per room code (env.ROOMS.idFromName(code)),
 * so state (who is host/guest) lives with the room, not the Worker.
 */

import { MatchRoom, SIM_HZ } from './room-sim.js';
import { handleApi } from './api.js';

const ROOM_CODE_RE = /^\/room\/([A-Za-z0-9_-]{2,16})(\/diag)?$/;
const HINTS = new Set(['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me']);
// phase 3.0 measurement from Indonesia (10 new rooms per hint): apac-se → SIN 8/10, apac → SIN/HKG/NRT, none → sometimes MXP
const DEFAULT_HINT = 'apac-se';

export class Room {
  constructor(state, env) {
    this.state = state;
    this.host = null;   // { ws, colo, country }
    this.guest = null;  // { ws, colo, country }
    this.created = Date.now();   // this instance's start (the object may be evicted and restarted between matches)
    this.hint = null;
    this.doColo = null; this.doLoc = null; this._colo = null;
    this.srv = false;     // server mode: set by whoever opens the empty room
    this.match = null;    // MatchRoom while in server mode
    this.timer = null;
    this.tok = { host: null, guest: null };   // secret slot keys (hello.tok) for reconnecting
  }

  // Which slot this request may take back. Today: the secret slot key from hello (?re=<role>&tok=<key>).
  // Later (no key: the app was closed and sessionStorage is gone): the Telegram user id from verified initData —
  // same HMAC check as the stats API; remember the id per slot next to the key and match it here.
  claim(q) {
    const re = q.get('re');
    if ((re === 'host' || re === 'guest') && this.tok[re] && q.get('tok') === this.tok[re]) return re;
    return null;
  }

  // a running server match keeps the slot of a player who dropped: only its owner may return
  reserved(slot) {
    return !!(this.srv && this.match && this.match.running && this.tok[slot]);
  }

  sendSlot(slot, txt) {
    const s = slot === 0 ? this.host : this.guest;
    if (s) { try { s.ws.send(txt); } catch (e) {} }
  }

  // 60 Hz while a match runs; setInterval keeps the object awake (no hibernation) only for the match itself
  startTicking() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.match || !this.match.tick()) { clearInterval(this.timer); this.timer = null; }
    }, 1000 / SIM_HZ);
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
    const m = this.match;
    return { doColo: this.doColo, doLoc: this.doLoc, hint: this.hint, created: this.created, st: Date.now(),
             mode: this.srv ? 'server' : 'relay',
             sim: m ? { steps: m.stat.steps, snaps: m.stat.snaps, maxStepMs: m.stat.maxStepMs, running: m.running } : null,
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
    // the room's mode is chosen by whoever opens it empty (the second player follows the room)
    const q = new URL(request.url).searchParams;
    const back = this.claim(q);
    // (a running match is kept even if the room is empty at the moment: its players may return)
    if (!this.host && !this.guest && !(this.match && this.match.running)) {
      this.srv = q.get('mode') === 'srv';
      this.tok = { host: null, guest: null };
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      this.match = this.srv ? new MatchRoom((slot, txt) => this.sendSlot(slot, txt)) : null;
    }
    this.handleSocket(server, { colo: request.headers.get('X-Edge-Colo') || '?', country: request.headers.get('X-Edge-Country') || '?' }, this.claim(q), q.get('fresh') === '1');

    return new Response(null, { status: 101, webSocket: client });
  }

  handleSocket(ws, where, back, fresh) {
    let slot; // 'host' | 'guest'

    if (back) {
      // the same player again: the old socket (if the server has not noticed it died) is replaced
      slot = back;
      const old = this[slot];
      this[slot] = { ws, ...where };
      if (old) { try { old.ws.close(1000, 'replaced'); } catch (e) {} }
    } else if (!this.host && !this.reserved('host')) {
      slot = 'host';
      this.host = { ws, ...where };
    } else if (!this.guest && !this.reserved('guest')) {
      slot = 'guest';
      this.guest = { ws, ...where };
    } else {
      // room already full (or the free slot is kept for the player who dropped)
      try { ws.send(JSON.stringify({ t: 'full' })); } catch (e) {}
      try { ws.close(1000, 'room full'); } catch (e) {}
      return;
    }

    if (!back) this.tok[slot] = crypto.randomUUID().replace(/-/g, '');
    try {
      ws.send(JSON.stringify({ t: 'hello', role: slot, n: this.peerCount(), diag: this.diag(), srv: this.srv ? 1 : 0,
                               tok: this.tok[slot], run: this.match && this.match.running ? 1 : 0 }));
    } catch (e) {}
    this.broadcastPeerCount();
    if (this.match) { this.match.join(slot === 'host' ? 0 : 1, !back || fresh); if (this.match.running) this.startTicking(); }

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
      // server mode: input and match start are for the simulation here, not for the other player
      if (this.srv && this.match && typeof data === 'string' && (data.startsWith('{"t":"i"') || data.startsWith('{"t":"cfg"') || data.startsWith('{"t":"s"'))) {
        let m = null; try { m = JSON.parse(data); } catch (e) {}
        if (m && this.match.onMessage(slot === 'host' ? 0 : 1, m) && m.t === 'cfg') this.startTicking();
        return;
      }
      const to = slot === 'host' ? this.guest : this.host;
      if (to) {
        try { to.ws.send(data); } catch (e) {}
      }
    });

    const onLeave = () => {
      try { ws.close(1000, 'bye'); } catch (e) {}       // finish the closing handshake: the client's onclose fires at once
      if (!this[slot] || this[slot].ws !== ws) return;   // already replaced by the same player's new socket
      this[slot] = null;
      if (this.match) this.match.leave(slot === 'host' ? 0 : 1);
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
    const api = await handleApi(request, env);
    if (api) return api;
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
