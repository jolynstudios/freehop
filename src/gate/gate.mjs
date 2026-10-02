// SPDX-License-Identifier: Apache-2.0
// Freehop gate: a blind rendezvous mailbox. It routes sealed envelopes between peers that
// announce the same opaque room tag. It never sees SDP, candidates, credentials or media:
// clients seal every envelope with a room key the gate does not have. Any number of
// interchangeable gates may serve the same room; clients announce on several at once.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { verifyGateToken } from '../shared/tokens.mjs';

export const GATE_PROTOCOL = 1;
export const GATE_LIMITS = Object.freeze({
  frame: 65536,            // bytes per WebSocket frame
  box: 49152,              // sealed envelope (base64url) characters
  roomsPerSocket: 4,
  peersPerRoom: 16,
  socketsPerAddress: 32,
  maxSockets: 1024,
  helloMs: 5000,
  idleMs: 90000,
  pingMs: 30000,
  // Token bucket over every byte a socket makes the gate forward (fan-out included).
  // Signalling for a full five-peer join is ~100 KB; media needs megabytes per minute.
  burstBytes: 524288,
  refillBytesPerSec: 2048,
  messagesPerSec: 40,
  messageBurst: 400,
  maxBufferedBytes: 1048576,
  maxPendingFrames: 64,
  maxPendingBytes: 262144
});

const TAG = /^[A-Za-z0-9_-]{22,43}$/;   // base64url of 16..32 bytes
const BOX = /^[A-Za-z0-9_-]+$/;

export { mintGateToken, verifyGateToken } from '../shared/tokens.mjs';

class Bucket {
  constructor(capacity, refillPerSec) { this.capacity = capacity; this.refill = refillPerSec; this.level = capacity; this.at = Date.now(); }
  take(amount) {
    const now = Date.now();
    this.level = Math.min(this.capacity, this.level + (now - this.at) / 1000 * this.refill); this.at = now;
    if (amount > this.level) return false;
    this.level -= amount; return true;
  }
}

/**
 * createGate({ server?, host, port, path, stun, stunUrls, tokenSecret, authorize, limits, log })
 * - server: an existing http(s).Server to attach to (otherwise one is created on host:port)
 * - stun: [{ host, port }] UDP STUN Binding responders started alongside (optional)
 * - stunUrls: STUN URLs advertised to clients (defaults derived from `stun` + publicHost)
 * - tokenSecret: when set, `hello.auth` must be a valid gate token (room-bound tokens restrict joins)
 * - authorize(hello, request): custom admission hook, overrides tokenSecret when given
 */
export async function createGate(options = {}) {
  const limits = { ...GATE_LIMITS, ...options.limits };
  const log = options.log ?? (() => {});
  const path = options.path ?? '/freehop';
  const stats = { sockets: 0, socketsTotal: 0, rooms: 0, joins: 0, framesIn: 0, bytesIn: 0, framesOut: 0, bytesOut: 0,
    envelopes: 0, refused: 0, rateLimited: 0, closedForAbuse: 0 };
  const rooms = new Map();          // roomTag -> Map(peerTag -> socketState)
  const perAddress = new Map();     // remote address -> socket count
  const sockets = new Set();

  const ownServer = !options.server;
  const server = options.server ?? http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.frame, perMessageDeflate: false, clientTracking: false });
  const onUpgrade = (request, socket, head) => {
    let url;
    try { url = new URL(request.url ?? '/', 'http://gate'); }
    catch { socket.destroy(); stats.refused++; return; }
    if (url.pathname !== path) { socket.destroy(); return; }
    // Behind a local reverse proxy every socket comes from loopback: with trustProxy, the
    // client address is the hop the proxy appended to X-Forwarded-For.
    const direct = request.socket.remoteAddress ?? '?';
    const forwarded = options.trustProxy && /^(127\.|::1$|::ffff:127\.)/.test(direct)
      ? String(request.headers['x-forwarded-for'] ?? '').split(',').map(v => v.trim()).filter(Boolean).pop() : null;
    const address = forwarded || direct;
    if (sockets.size >= limits.maxSockets || (perAddress.get(address) ?? 0) >= limits.socketsPerAddress) { socket.destroy(); stats.refused++; return; }
    wss.handleUpgrade(request, socket, head, ws => accept(ws, request, address));
  };
  server.on('upgrade', onUpgrade);

  const stunResponders = [];
  if (options.stun?.length) {
    const { createStunResponder } = await import('./stun-responder.mjs');
    for (const spec of options.stun) stunResponders.push(await createStunResponder({ ...spec, log }));
  }
  // A wildcard bind cannot be advertised: clients need the public host name or address.
  const stunUrls = options.stunUrls ?? stunResponders.map(r => {
    const a = r.address();
    const host = options.publicHost ?? (a.address === '0.0.0.0' || a.address === '::' ? null : a.address);
    if (!host) { log('stun-not-advertised', { reason: 'wildcard bind without publicHost' }); return null; }
    return `stun:${host.includes(':') ? `[${host}]` : host}:${a.port}`;
  }).filter(Boolean);

  function emit(state, message) {
    if (state.ws.readyState !== 1) return false;
    // A receiver that stops reading must not make the gate buffer without bound.
    if (state.ws.bufferedAmount > limits.maxBufferedBytes) { stats.closedForAbuse++; state.ws.terminate(); return false; }
    const text = JSON.stringify(message);
    state.ws.send(text); stats.framesOut++; stats.bytesOut += text.length;
    return true;
  }
  function refuse(state, code, close = false) {
    stats.refused++; emit(state, { t: 'error', code });
    if (close) { state.closed = true; stats.closedForAbuse++; state.ws.close(1008, code); }
  }
  function leaveRoom(state, room) {
    const members = rooms.get(room); const peer = state.rooms.get(room);
    state.rooms.delete(room);
    if (!members || members.get(peer) !== state) return;
    members.delete(peer);
    for (const other of members.values()) emit(other, { t: 'peer', room, peer, on: false });
    if (members.size === 0) { rooms.delete(room); stats.rooms = rooms.size; }
  }

  async function admit(state, hello, request) {
    if (options.authorize) return !!(await options.authorize(hello, request));
    if (!options.tokenSecret) return true;
    const claims = verifyGateToken(options.tokenSecret, hello.auth);
    const a = server.address();
    const audience = options.tokenAudience ?? `${server.setSecureContext ? 'wss' : 'ws'}://${a.address.includes(':') ? `[${a.address}]` : a.address}:${a.port}${path}`;
    if (!claims || claims.aud !== audience) return false;
    state.boundRoom = claims.room ?? null;
    state.expiresAt = claims.exp * 1000;
    return true;
  }

  function accept(ws, request, address) {
    const state = { ws, address, admitted: false, rooms: new Map(), boundRoom: null, expiresAt: Infinity, closed: false,
      bytes: new Bucket(limits.burstBytes, limits.refillBytesPerSec), messages: new Bucket(limits.messageBurst, limits.messagesPerSec),
      lastSeen: Date.now(), alive: true };
    sockets.add(state); perAddress.set(address, (perAddress.get(address) ?? 0) + 1);
    stats.sockets = sockets.size; stats.socketsTotal++;
    const helloTimer = setTimeout(() => { if (!state.admitted) ws.close(1008, 'hello-timeout'); }, limits.helloMs);
    ws.on('pong', () => { state.alive = true; state.lastSeen = Date.now(); });
    ws.on('close', () => {
      state.closed = true;
      clearTimeout(helloTimer);
      for (const room of [...state.rooms.keys()]) leaveRoom(state, room);
      sockets.delete(state);
      const n = (perAddress.get(address) ?? 1) - 1; if (n > 0) perAddress.set(address, n); else perAddress.delete(address);
      stats.sockets = sockets.size;
    });
    ws.on('error', () => {});
    let chain = Promise.resolve(), pendingFrames = 0, pendingBytes = 0;
    ws.on('message', (data, isBinary) => {
      if (state.closed) return;
      pendingBytes += data.length;
      if (pendingBytes > limits.maxPendingBytes || ++pendingFrames > limits.maxPendingFrames || !state.messages.take(1)) { stats.rateLimited++; return refuse(state, 'rate', true); }
      chain = chain.then(() => handle(state, data, isBinary, request, helloTimer)).catch(error => {
        log('gate-error', { message: error?.message }); refuse(state, 'internal', true);
      }).finally(() => { pendingFrames--; pendingBytes -= data.length; });
    });
  }

  async function handle(state, data, isBinary, request, helloTimer) {
    if (state.closed) return;
    if (Date.now() >= state.expiresAt) return refuse(state, 'auth-expired', true);
    stats.framesIn++; stats.bytesIn += data.length; state.lastSeen = Date.now();
    if (isBinary) return refuse(state, 'binary', true);
    let m; try { m = JSON.parse(data.toString('utf8')); } catch { return refuse(state, 'json', true); }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return refuse(state, 'schema', true);
    if (!state.admitted) {
      if (m.t !== 'hello' || m.v !== GATE_PROTOCOL) return refuse(state, 'hello', true);
      if (!(await admit(state, m, request))) return refuse(state, 'auth', true);
      if (state.closed || state.ws.readyState !== 1) return;
      state.admitted = true; clearTimeout(helloTimer);
      return emit(state, { t: 'welcome', v: GATE_PROTOCOL, stun: stunUrls, limits: { box: limits.box, peersPerRoom: limits.peersPerRoom } });
    }
    switch (m.t) {
      case 'join': {
        if (Object.keys(m).length !== 3 || typeof m.room !== 'string' || typeof m.peer !== 'string' || !TAG.test(m.room) || !TAG.test(m.peer)) return refuse(state, 'schema', true);
        if (state.boundRoom && state.boundRoom !== m.room) return refuse(state, 'room-not-allowed');
        if (state.rooms.has(m.room)) return refuse(state, 'already-joined');
        if (state.rooms.size >= limits.roomsPerSocket) return refuse(state, 'too-many-rooms');
        let members = rooms.get(m.room);
        if (members?.has(m.peer)) return refuse(state, 'peer-taken');
        if ((members?.size ?? 0) >= limits.peersPerRoom) return refuse(state, 'room-full');
        if (!members) { members = new Map(); rooms.set(m.room, members); stats.rooms = rooms.size; }
        const peers = [...members.keys()];
        members.set(m.peer, state); state.rooms.set(m.room, m.peer); stats.joins++;
        emit(state, { t: 'peers', room: m.room, peers });
        for (const other of members.values()) if (other !== state) emit(other, { t: 'peer', room: m.room, peer: m.peer, on: true });
        return;
      }
      case 'leave':
        if (Object.keys(m).length !== 2 || !state.rooms.has(m.room)) return refuse(state, 'schema');
        return leaveRoom(state, m.room);
      case 'send': {
        if (Object.keys(m).length !== 4 || typeof m.box !== 'string' || m.box.length > limits.box || !BOX.test(m.box)) return refuse(state, 'schema', true);
        const from = state.rooms.get(m.room);
        if (!from) return refuse(state, 'not-joined');
        const members = rooms.get(m.room);
        const targets = m.to === '*' ? [...members.entries()].filter(([peer]) => peer !== from).map(([, s]) => s)
          : TAG.test(m.to ?? '') && members.has(m.to) && m.to !== from ? [members.get(m.to)] : null;
        if (!targets) return refuse(state, 'no-such-peer');
        // Charge the sender for the full fan-out: the gate's cost is what it forwards.
        if (!state.bytes.take(m.box.length * Math.max(1, targets.length))) { stats.rateLimited++; return refuse(state, 'rate', true); }
        for (const target of targets) emit(target, { t: 'recv', room: m.room, from, box: m.box });
        stats.envelopes += targets.length;
        return;
      }
      case 'ping': return emit(state, { t: 'pong' });
      default: return refuse(state, 'type', true);
    }
  }

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const state of sockets) {
      if (now >= state.expiresAt) { refuse(state, 'auth-expired', true); continue; }
      if (!state.alive || now - state.lastSeen > limits.idleMs) { state.ws.terminate(); continue; }
      state.alive = false; try { state.ws.ping(); } catch {}
    }
  }, limits.pingMs);
  heartbeat.unref?.();

  if (ownServer) await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });

  return {
    server, path, stunUrls,
    url(host) { const a = server.address(); return `ws://${host ?? (a.address.includes(':') ? `[${a.address}]` : a.address)}:${a.port}${path}`; },
    stats() { return { ...stats, stun: stunResponders.map(r => r.stats()) }; },
    rooms() { return rooms.size; },
    async close() {
      clearInterval(heartbeat);
      server.off('upgrade', onUpgrade);
      for (const state of sockets) state.ws.terminate();
      wss.close();
      await Promise.all(stunResponders.map(r => r.close()));
      if (ownServer) await new Promise(resolve => server.close(() => resolve()));
    }
  };
}

export const randomTag = (bytes = 16) => randomBytes(bytes).toString('base64url');
