// SPDX-License-Identifier: Apache-2.0
// Freehop gate: a blind rendezvous mailbox. It routes sealed envelopes between peers that
// announce the same opaque room tag. It never sees SDP, candidates, credentials or media:
// clients seal every envelope with a room key the gate does not have. Any number of
// interchangeable gates may serve the same room; clients announce on several at once.
import http from 'node:http';
import { isIPv4, isIPv6 } from 'node:net';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { verifyGateToken } from '../shared/tokens.mjs';

export const GATE_PROTOCOL = 1;
// Worst-case memory at these defaults (measured on Node 24): (1024 admitted + 256 pending or closing
// sockets) x (64 KiB partial frame + ~28 KiB state) = 115 MiB, + 256 x 64 KiB queued behind admission
// = 16 MiB, + 32 MiB unflushed output, + ~60 MiB runtime: ~225 MiB. Forwarding bursts add short-lived
// garbage on top (up to ~250 MiB before GC), so deploy/freehop-gate.service sets MemoryMax=512M.
export const GATE_LIMITS = Object.freeze({
  frame: 65536,            // bytes per WebSocket frame
  box: 49152,              // sealed envelope (base64url) characters
  roomsPerSocket: 4,
  peersPerRoom: 16,
  socketsPerAddress: 32,   // every per-address limit counts an IPv4 address or an IPv6 /64
  maxSockets: 1024,        // admitted sockets
  maxPendingSockets: 256,  // sockets not admitted yet, plus sockets closing
  pendingPerAddress: 8,
  helloMs: 5000,
  closeMs: 1000,           // a close handshake gets this long, then the socket is destroyed
  idleMs: 90000,
  pingMs: 30000,
  // Token bucket over every byte a socket makes the gate forward (fan-out included).
  // Signalling for a full five-peer join is ~100 KB; media needs megabytes per minute.
  burstBytes: 524288,
  refillBytesPerSec: 2048,
  messagesPerSec: 40,      // pings and unsolicited pongs count too
  messageBurst: 400,
  maxBufferedBytes: 1048576,   // output handed to ws and not yet flushed, per socket
  maxBufferedTotal: 33554432,  // the same, for the whole gate
  maxPendingFrames: 64,        // frames queued behind an admission in progress
  maxPendingBytes: 65536
});

const TAG = /^[A-Za-z0-9_-]{22,43}$/;   // base64url of 16..32 bytes
const BOX = /^[A-Za-z0-9_-]+$/;
const first = set => set.values().next().value;   // sets below iterate oldest first

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

// Per-address budgets key on an IPv4 address or an IPv6 /64: one host can use a whole /64.
// Some proxies append a port ("ip:port", "[ip]:port"); it must not split one client into many.
function addressKey(address) {
  const ip = String(address).replace(/^\[([^\]]*)\](:\d+)?$/, '$1').replace(/^([\d.]+):\d+$/, '$1').replace(/%.*$/, '');
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return String(address).slice(0, 64);
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  const text = v4 ? `${ip.slice(0, v4.index)}${(v4[1] << 8 | v4[2]).toString(16)}:${(v4[3] << 8 | v4[4]).toString(16)}` : ip;
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const g = (tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]).map(x => parseInt(x, 16));
  // IPv4-mapped (::ffff:0:0/96) and well-known NAT64 (64:ff9b::/96) addresses stand for one IPv4 client.
  if (!(g[0] | g[1] | g[2] | g[3] | g[4]) && g[5] === 0xffff || g[0] === 0x64 && g[1] === 0xff9b && !(g[2] | g[3] | g[4] | g[5]))
    return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return `${g.slice(0, 4).map(x => x.toString(16)).join(':')}::/64`;
}

/**
 * createGate({ server?, host, port, path, stun, stunUrls, tokenSecret, tokenAudience, trustProxy, authorize, limits, log })
 * - server: an existing http(s).Server to attach to (otherwise one is created on host:port)
 * - stun: [{ host, port }] UDP STUN Binding responders started alongside (optional)
 * - stunUrls: STUN URLs advertised to clients (defaults derived from `stun` + publicHost)
 * - tokenSecret: when set, `hello.auth` must be a valid gate token (room-bound tokens restrict joins)
 * - authorize(hello, request): custom admission hook, overrides tokenSecret when given
 * Sockets that have not been admitted have their own budget (limits.maxPendingSockets), so
 * sockets that never send a valid hello cannot lock admitted clients out.
 */
export async function createGate(options = {}) {
  const limits = { ...GATE_LIMITS, ...options.limits };
  const log = options.log ?? (() => {});
  const path = options.path ?? '/freehop';
  const stats = { sockets: 0, socketsTotal: 0, pending: 0, rooms: 0, joins: 0, framesIn: 0, bytesIn: 0, framesOut: 0, bytesOut: 0,
    buffered: 0, envelopes: 0, refused: 0, rateLimited: 0, closedForAbuse: 0, evicted: 0 };
  const rooms = new Map();          // roomTag -> Map(peerTag -> socketState)
  const perAddress = new Map();     // address key -> { all, waiting } socket counts
  const sockets = new Set();        // every open socket
  const waiting = new Set();        // not admitted yet
  const silent = new Set();         // waiting, and no frame received yet
  const closing = new Set();        // close handshake in progress
  const backlog = new Set();        // sockets with unflushed output, longest behind first
  let admitted = 0, buffered = 0;

  const ownServer = !options.server;
  const server = options.server ?? http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
    res.writeHead(404); res.end();
  });
  // autoPong is off so pong replies go through the output budget; closeTimeout bounds every close handshake.
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.frame, perMessageDeflate: false, clientTracking: false,
    autoPong: false, closeTimeout: limits.closeMs });
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
    const address = addressKey(forwarded || direct);
    const count = perAddress.get(address);
    // A full pending budget is refused only when no closing or silent socket can make room (see accept).
    if (count && (count.all >= limits.socketsPerAddress || count.waiting >= limits.pendingPerAddress)
      || waiting.size + closing.size >= limits.maxPendingSockets && !closing.size && !silent.size) { socket.destroy(); stats.refused++; return; }
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

  // Output accounting: bytes handed to ws and not yet flushed (its write callback has not run).
  function queue(state, size, write) {
    if (state.closed || state.ws.readyState !== 1) return false;
    // A receiver that stops reading must not make the gate buffer without bound.
    if (state.buffered + size > limits.maxBufferedBytes) { stats.closedForAbuse++; kill(state); return false; }
    // Over the gate-wide budget, the receiver that has been behind the longest goes first,
    // so stalled sockets cannot spend the budget of receivers that keep up.
    while (buffered + size > limits.maxBufferedTotal && backlog.size) {
      const slowest = first(backlog); stats.closedForAbuse++; kill(slowest);
      if (slowest === state) return false;
    }
    if (!state.buffered) backlog.add(state);
    state.buffered += size; buffered += size;
    write(() => {
      if (state.phase === 'gone') return;   // released in full on close
      state.buffered -= size; buffered -= size;
      if (!state.buffered) backlog.delete(state);
    });
    return true;
  }
  function send(state, message) {
    const text = JSON.stringify(message);
    if (!queue(state, Buffer.byteLength(text), done => state.ws.send(text, done))) return false;
    stats.framesOut++; stats.bytesOut += text.length;
    return true;
  }
  function emit(state, message) {
    if (state.closed) return false;
    // Expiry is checked on delivery too, so an expired socket stops receiving at once, not at the next heartbeat.
    if (Date.now() >= state.expiresAt) { refuse(state, 'auth-expired', true); return false; }
    return send(state, message);
  }
  function refuse(state, code, close = false) {
    stats.refused++; send(state, { t: 'error', code });
    if (close) { stats.closedForAbuse++; shut(state, 1008, code); }
  }

  // Socket phases: waiting (not admitted) -> admitted -> closing -> gone.
  function leavePhase(state) {
    if (state.phase === 'waiting') { waiting.delete(state); silent.delete(state); perAddress.get(state.address).waiting--; }
    else if (state.phase === 'admitted') admitted--;
    else if (state.phase === 'closing') closing.delete(state);
  }
  // Rooms are left in a microtask: an eviction inside a fan-out loop then cannot reorder its notifications.
  function leaveRooms(state) {
    if (state.leaving) return; state.leaving = true;
    queueMicrotask(() => { for (const room of [...state.rooms.keys()]) leaveRoom(state, room); });
  }
  // Close frame now, destroyed after closeMs at most (ws closeTimeout). Closing sockets share the
  // pending budget; over it, the oldest closing socket skips the rest of its grace period.
  function shut(state, code, reason) {
    if (state.closed) return;
    leavePhase(state); state.phase = 'closing'; state.closed = true; closing.add(state);
    if (waiting.size + closing.size > limits.maxPendingSockets) kill(first(closing));
    if (state.phase !== 'closing') return;
    state.ws.close(code, reason); leaveRooms(state);
  }
  function kill(state) { release(state); state.ws.terminate(); }
  function release(state) {
    if (state.phase === 'gone') return;
    leavePhase(state); state.phase = 'gone'; state.closed = true;
    clearTimeout(state.helloTimer); sockets.delete(state); backlog.delete(state);
    buffered -= state.buffered; state.buffered = 0;
    const count = perAddress.get(state.address); if (--count.all === 0) perAddress.delete(state.address);
    leaveRooms(state);
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
    const a = server.address();
    const audience = options.tokenAudience ?? `${server.setSecureContext ? 'wss' : 'ws'}://${a.address.includes(':') ? `[${a.address}]` : a.address}:${a.port}${path}`;
    const claims = verifyGateToken(options.tokenSecret, hello.auth, { audience });
    if (!claims) return false;
    state.boundRoom = claims.room ?? null;
    state.expiresAt = claims.exp * 1000;
    return true;
  }

  function accept(ws, request, address) {
    // A full pending budget sheds a closing socket, else the oldest silent one. A real client
    // sends hello within a round trip of the upgrade, so silent sockets cannot keep it out.
    while (waiting.size + closing.size >= limits.maxPendingSockets) {
      const victim = first(closing) ?? first(silent); if (!victim) break;
      stats.evicted++; kill(victim);
    }
    const state = { ws, address, phase: 'waiting', rooms: new Map(), boundRoom: null, expiresAt: Infinity, closed: false,
      bytes: new Bucket(limits.burstBytes, limits.refillBytesPerSec), messages: new Bucket(limits.messageBurst, limits.messagesPerSec),
      lastSeen: Date.now(), nonce: null, buffered: 0, helloTimer: null, leaving: false };
    const count = perAddress.get(address) ?? perAddress.set(address, { all: 0, waiting: 0 }).get(address);
    count.all++; count.waiting++;
    sockets.add(state); waiting.add(state); silent.add(state); stats.socketsTotal++;
    state.helloTimer = setTimeout(() => { if (state.phase === 'waiting') shut(state, 1008, 'hello-timeout'); }, limits.helloMs);
    ws.on('close', () => release(state));
    ws.on('error', () => {});
    ws.on('ping', data => {
      if (state.closed) return;
      if (!state.messages.take(1)) { stats.rateLimited++; return refuse(state, 'rate', true); }
      queue(state, data.length + 2, done => ws.pong(data, false, done));
    });
    ws.on('pong', data => {
      if (state.closed) return;
      // Only an echo of the latest heartbeat nonce shows that the socket reads what it is sent.
      if (state.nonce?.equals(data)) { state.nonce = null; state.lastSeen = Date.now(); }
      else if (!state.messages.take(1)) { stats.rateLimited++; refuse(state, 'rate', true); }
    });
    let chain = Promise.resolve(), pendingFrames = 0, pendingBytes = 0;
    ws.on('message', (data, isBinary) => {
      if (state.closed) return;
      silent.delete(state);
      // Frames queued behind an admission in progress are bounded here. Admitted sockets answer to
      // the message and byte budgets only, so a burst of frames in one TCP read is not a flood.
      const queued = state.phase === 'waiting';
      if (queued && ((pendingBytes += data.length) > limits.maxPendingBytes || ++pendingFrames > limits.maxPendingFrames) || !state.messages.take(1)) {
        stats.rateLimited++; return refuse(state, 'rate', true);
      }
      chain = chain.then(() => handle(state, data, isBinary, request)).catch(error => {
        log('gate-error', { message: error?.message }); refuse(state, 'internal', true);
      }).finally(() => { if (queued) { pendingFrames--; pendingBytes -= data.length; } });
    });
  }

  async function handle(state, data, isBinary, request) {
    if (state.closed) return;
    if (Date.now() >= state.expiresAt) return refuse(state, 'auth-expired', true);
    stats.framesIn++; stats.bytesIn += data.length; state.lastSeen = Date.now();
    if (isBinary) return refuse(state, 'binary', true);
    let m; try { m = JSON.parse(data.toString('utf8')); } catch { return refuse(state, 'json', true); }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return refuse(state, 'schema', true);
    if (state.phase === 'waiting') {
      if (m.t !== 'hello' || m.v !== GATE_PROTOCOL) return refuse(state, 'hello', true);
      if (!(await admit(state, m, request))) return refuse(state, 'auth', true);
      if (state.closed) return;
      if (admitted >= limits.maxSockets) { refuse(state, 'busy'); return shut(state, 1013, 'busy'); }
      clearTimeout(state.helloTimer); leavePhase(state); state.phase = 'admitted'; admitted++;
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
        if (!emit(state, { t: 'peers', room: m.room, peers })) return;
        for (const other of members.values()) if (other !== state && !state.closed) emit(other, { t: 'peer', room: m.room, peer: m.peer, on: true });
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
      if (state.closed) continue;   // closing sockets are destroyed within closeMs
      if (now >= state.expiresAt) { refuse(state, 'auth-expired', true); continue; }
      // An unanswered nonce means the socket did not read its last ping: unsolicited pongs do not count.
      if (state.nonce || now - state.lastSeen > limits.idleMs) { kill(state); continue; }
      const nonce = state.nonce = randomBytes(8);
      queue(state, nonce.length + 2, done => state.ws.ping(nonce, false, done));
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
    stats() { return { ...stats, sockets: sockets.size, pending: waiting.size, buffered, stun: stunResponders.map(r => r.stats()) }; },
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
