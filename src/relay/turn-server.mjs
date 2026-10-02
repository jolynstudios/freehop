// SPDX-License-Identifier: Apache-2.0
// Minimal hardened TURN server (RFC 8656 over RFC 8489) for volunteer relays: UDP/TCP/TLS client
// transports, UDP relaying, long-term credentials with stateless signed nonces, quotas and
// token-bucket rate limits. Media stays DTLS-SRTP encrypted end to end; the relay sees ciphertext.
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ATTR, CLASS, METHOD, decode, encode, getAttr, encodeXorAddress, decodeXorAddress, errorCodeValue, longTermKey,
  verifyIntegrity, verifyFingerprint, encodeChannelData, decodeChannelData, frameStreamMessages, ipToBytes, bytesToIp } from '../shared/stun.mjs';

export const DEFAULT_LIMITS = Object.freeze({ maxAllocations: 64, maxAllocationsPerUsername: 4, allocationBitrate: 4_000_000,
  totalBitrate: 40_000_000, defaultLifetime: 600, maxLifetime: 3600, permissionLifetime: 300, channelLifetime: 600, maxPermissions: 32,
  maxChannels: 32, nonceLifetime: 600, maxTcpConnections: 256, tcpIdleMs: 120000, hookTimeoutMs: 5000,
  maxTcpPerAddress: 16, tcpPreAuthMs: 10000, errorRate: 30, errorBurst: 60, udpResponseRate: 200, udpResponseBurst: 400 });

const RESPONSE_CACHE_MS = 40_000, RESPONSE_CACHE_MAX = 2048, MAX_INFLIGHT = 256, SWEEP_MS = 1000, ADDRESS_REFRESH_MS = 10_000;
const TCP_DATA_HIGH_WATER = 256 * 1024, TCP_PAUSE_WATER = 1024 * 1024, TLS_HANDSHAKE_MS = 10_000, MAX_UNKNOWN_REPORTED = 16;
const TURN_METHODS = new Set([METHOD.ALLOCATE, METHOD.REFRESH, METHOD.CREATE_PERMISSION, METHOD.CHANNEL_BIND]);
const KNOWN_REQUIRED = new Set(Object.values(ATTR).filter(t => t < 0x8000));
const ALLOW = Object.freeze({ ownOnly: false }), OWN_ONLY = Object.freeze({ ownOnly: true });

const prefix = (address, bits) => ({ bytes: ipToBytes(address), bits });
const DENY = [prefix('0.0.0.0', 8), prefix('127.0.0.0', 8), prefix('169.254.0.0', 16), prefix('224.0.0.0', 4), prefix('240.0.0.0', 4),
  prefix('::', 96), prefix('fe80::', 10), prefix('ff00::', 8)];
const PRIVATE = [prefix('10.0.0.0', 8), prefix('172.16.0.0', 12), prefix('192.168.0.0', 16), prefix('100.64.0.0', 10), prefix('fc00::', 7)];
const MAPPED = prefix('::ffff:0:0', 96), NAT64 = prefix('64:ff9b::', 96);

function inPrefix(ip, { bytes, bits }) {
  if (ip.length !== bytes.length) return false;
  for (let i = 0; i < bits; i += 8) {
    const mask = bits - i >= 8 ? 0xff : (0xff << (8 - (bits - i))) & 0xff;
    if ((ip[i >> 3] & mask) !== (bytes[i >> 3] & mask)) return false;
  }
  return true;
}

// 'deny' (unspecified, loopback, link-local, multicast, broadcast/reserved, 0/8, IPv4-compatible,
// and IPv4-mapped/NAT64 forms of those), 'private' (RFC 1918, 100.64/10, fc00::/7) or 'public'.
export function classifyPeerAddress(address) {
  let ip = typeof address === 'string' ? ipToBytes(address) : address;
  if (!ip) return 'deny';
  if (ip.length === 16 && (inPrefix(ip, MAPPED) || inPrefix(ip, NAT64))) ip = ip.subarray(12);
  if (DENY.some(p => inPrefix(ip, p))) return 'deny';
  return PRIVATE.some(p => inPrefix(ip, p)) ? 'private' : 'public';
}

const isWildcard = a => a === '0.0.0.0' || a === '::';
const isThenable = v => v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
function normalizeAddress(address) {
  if (typeof address !== 'string') return null;
  if (net.isIPv4(address)) return { family: 4, address };
  const b = ipToBytes(address);
  if (!b) return null;
  if (b.length === 16 && inPrefix(b, MAPPED)) return { family: 4, address: bytesToIp(b.subarray(12)) };
  return { family: b.length === 4 ? 4 : 6, address: bytesToIp(b) };
}
function interfaces() { try { return Object.values(os.networkInterfaces()).flat().filter(Boolean); } catch { return []; } }
function interfaceAddress(family) {
  let fallback = null;
  for (const i of interfaces()) {
    const n = normalizeAddress(i.address);
    if (!n || n.family !== family || (family === 6 && /^fe[89ab]/i.test(n.address))) continue;
    if (!i.internal && (family === 4 || !/^f[cd]/i.test(n.address))) return n.address;
    if (!fallback || (fallback.internal && !i.internal)) fallback = { address: n.address, internal: i.internal };
  }
  return fallback?.address ?? null;
}
// Local source address the kernel would use towards `address` (no packet is sent).
function routeSource(family, address, port) {
  return new Promise(resolve => {
    let s;
    try { s = dgram.createSocket(family === 6 ? 'udp6' : 'udp4'); } catch { resolve(null); return; }
    const done = v => { try { s.close(); } catch {} resolve(v); };
    s.on('error', () => done(null));
    try {
      s.connect(port || 9, address, err => {
        if (err) return done(null);
        try { const a = normalizeAddress(s.address().address); done(a && !isWildcard(a.address) ? a.address : null); } catch { done(null); }
      });
    } catch { done(null); }
  });
}
function bindDgram(socket, port, address) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { socket.off('listening', ok); socket.off('error', fail); socket.off('close', early); };
    const ok = () => { cleanup(); resolve(); }, fail = e => { cleanup(); reject(e); }, early = () => fail(new Error('socket closed while binding'));
    socket.once('listening', ok); socket.once('error', fail); socket.once('close', early);
    try { socket.bind({ port, address, exclusive: true }); } catch (e) { fail(e); }
  });
}
function closeDgram(socket) { return new Promise(resolve => { try { socket.close(() => resolve()); } catch { resolve(); } }); }
function setBuffers(socket, size) { try { socket.setRecvBufferSize(size); socket.setSendBufferSize(size); } catch {} }

// Token bucket in bytes with a one-second burst; null = unlimited.
function bucket(bitsPerSecond) {
  if (!(bitsPerSecond > 0) || !Number.isFinite(bitsPerSecond)) return null;
  const cap = bitsPerSecond / 8;
  return { rate: cap / 1000, cap, tokens: cap, last: Date.now() };
}
function take(a, b, n) {
  const now = Date.now();
  for (const k of [a, b]) if (k) { k.tokens = Math.min(k.cap, k.tokens + (now - k.last) * k.rate); k.last = now; }
  if ((a && a.tokens < n) || (b && b.tokens < n)) return false;
  if (a) a.tokens -= n;
  if (b) b.tokens -= n;
  return true;
}
const u32Value = v => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
// Bounds user hooks (authenticate, mapRelayPort) so a hung promise cannot pin an in-flight request or a paused stream.
function withTimeout(value, ms) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); timer.unref(); });
  return Promise.race([Promise.resolve(value), expired]).finally(() => clearTimeout(timer));
}
const failure = (code, reason, extra = []) => ({ error: true, attributes: [{ type: ATTR.ERROR_CODE, value: errorCodeValue(code, reason) }, ...extra] });
const success = (attributes = []) => ({ error: false, attributes });

export async function createTurnServer(options = {}) {
  if (typeof options.authenticate !== 'function') throw new TypeError('createTurnServer: authenticate(username, realm) => password|null is required');
  const realm = String(options.realm ?? 'peerlane'), realmBuf = Buffer.from(realm, 'utf8');
  if (!realmBuf.length || realmBuf.length > 763) throw new RangeError('realm must be 1..763 bytes');
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const software = options.software === undefined ? 'peerlane-turn' : options.software ? String(options.software).slice(0, 127) : null;
  const softwareAttr = software && { type: ATTR.SOFTWARE, value: software };
  const relayHosts = { 4: null, 6: null }, external = { 4: null, 6: null };
  for (const h of [options.relayHost ?? '0.0.0.0'].flat()) {
    const n = normalizeAddress(h);
    if (!n) throw new TypeError(`relayHost must be an IP literal: ${h}`);
    if (n.address === '::') { relayHosts[6] ??= '::'; relayHosts[4] ??= '0.0.0.0'; } else relayHosts[n.family] ??= n.address;
  }
  for (const a of [options.externalAddress ?? []].flat()) {
    const n = normalizeAddress(a);
    if (!n || isWildcard(n.address)) throw new TypeError(`externalAddress must be a specific IP literal: ${a}`);
    external[n.family] ??= n.address;
  }
  const range = options.relayPortRange;
  if (range !== undefined && !(Array.isArray(range) && range.length === 2 && range.every(p => Number.isInteger(p) && p > 0 && p <= 0xffff) && range[0] <= range[1]))
    throw new RangeError('relayPortRange must be [min, max] with 1 <= min <= max <= 65535');
  const listenSpecs = options.listen ?? [{ transport: 'udp', host: '0.0.0.0', port: 3478 }, { transport: 'tcp', host: '0.0.0.0', port: 3478 }];
  const logFn = typeof options.log === 'function' ? options.log : null;
  const log = (event, details = {}) => { if (logFn) try { logFn(event, details); } catch {} };

  const counters = { allocationsCreated: 0, allocationsDeleted: 0, bytesFromClients: 0, bytesToClients: 0, bytesFromPeers: 0, bytesToPeers: 0,
    droppedRateLimited: 0, droppedNoPermission: 0, droppedNoAllocation: 0, droppedNoChannel: 0, droppedPolicy: 0, droppedBackpressure: 0,
    droppedBusy: 0, relayedInternally: 0, peersDenied: 0, malformed: 0, authFailures: 0, staleNonces: 0, retransmissions: 0, bindings: 0,
    sendErrors: 0, tcpRejected: 0, tcpIdleClosed: 0, tlsErrors: 0, errors: 0, droppedErrorRate: 0 };
  const listeners = [], allocations = new Map(), byUser = new Map(), relayIndex = new Map(), wildcardPorts = new Map();
  const conns = new Set(), rawSockets = new Set(), relaySockets = new Set(), pendingCloses = new Set();
  const responseCache = new Map(), inflight = new Set(), nonceSecret = randomBytes(32);
  const globalUp = bucket(limits.totalBitrate), globalDown = bucket(limits.totalBitrate);
  let closed = false, closing = null, connSeq = 0, ownAddresses = new Set(), selfEndpoints = new Set(), addressesAt = 0;
  let tidPool = Buffer.alloc(0), tidOffset = 0;

  const fault = (e, where) => { counters.errors++; log('error', { where, message: e?.message ?? String(e) }); };
  const onSendDone = err => { if (err) counters.sendErrors++; };
  function nextTid() {
    if (tidOffset + 12 > tidPool.length) { tidPool = randomBytes(12 * 256); tidOffset = 0; }
    return tidPool.subarray(tidOffset, tidOffset += 12);
  }

  // Own addresses: every local interface, configured external addresses and listener hosts. Under the
  // default policy a peer on one of them may only be reached through internal relay↔relay delivery,
  // and datagrams to our own UDP listener endpoints are always dropped (relay loops).
  function refreshOwnAddresses() {
    const own = new Set(['127.0.0.1', '::1']);
    for (const i of interfaces()) { const n = normalizeAddress(i.address); if (n) own.add(n.address); }
    for (const f of [4, 6]) if (external[f]) own.add(external[f]);
    for (const l of listeners) if (!l.wildcard) own.add(l.localAddress);
    const self = new Set();
    for (const l of listeners) if (l.transport === 'udp') {
      const hosts = l.wildcard ? [...own].filter(a => l.host === '::' || net.isIPv4(a)) : [l.localAddress, external[4], external[6]].filter(Boolean);
      for (const a of hosts) self.add(`${a}|${l.port}`);
    }
    ownAddresses = own; selfEndpoints = self; addressesAt = Date.now();
  }

  const nonceMac = (expiry, ctx) => createHmac('sha256', nonceSecret).update(`${expiry}|${ctx.transport}|${ctx.address}|${ctx.port}`).digest('hex').slice(0, 24);
  function makeNonce(ctx) { const e = (Math.ceil(Date.now() / 1000) + limits.nonceLifetime).toString(16).padStart(8, '0'); return e + nonceMac(e, ctx); }
  function validNonce(buf, ctx) {
    if (buf.length !== 32) return false;
    const s = buf.toString('latin1'), e = s.slice(0, 8);
    if (!/^[0-9a-f]{8}$/.test(e) || parseInt(e, 16) * 1000 <= Date.now()) return false;
    return timingSafeEqual(Buffer.from(s.slice(8), 'latin1'), Buffer.from(nonceMac(e, ctx), 'latin1'));
  }

  function sendToClient(ctx, buf, isData = false) {
    if (closed) return;
    const conn = ctx.conn;
    if (conn) {
      const { socket } = conn;
      if (conn.closed || socket.destroyed) return;
      if (isData && socket.writableLength > TCP_DATA_HIGH_WATER) { counters.droppedBackpressure++; return; }
      counters.bytesToClients += buf.length;
      socket.write(buf);
      if (socket.writableLength > TCP_PAUSE_WATER && !conn.writeBlocked) { conn.writeBlocked = true; updateFlow(conn); }
    } else {
      counters.bytesToClients += buf.length;
      ctx.listener.socket.send(buf, ctx.port, ctx.sendAddress, onSendDone);
    }
  }
  const respond = (ctx, msg, cls, attributes, integrityKey) =>
    sendToClient(ctx, encode({ method: msg.method, cls, transactionId: msg.transactionId, attributes }, { integrityKey, fingerprint: true }));
  // Error answers (401 challenges above all) go to unauthenticated UDP sources, which may be
  // spoofed: a per-source token bucket keeps the server from being a reflector.
  const errorBudget = new Map();
  const responseBudget = { level: limits.udpResponseBurst, at: Date.now() };
  const errorAllowed = ctx => {
    if (ctx.transport !== 'udp') return true;
    const now = Date.now();
    responseBudget.level = Math.min(limits.udpResponseBurst, responseBudget.level + (now - responseBudget.at) / 1000 * limits.udpResponseRate);
    responseBudget.at = now;
    if (responseBudget.level < 1) { counters.droppedErrorRate++; return false; }
    let b = errorBudget.get(ctx.address);
    if (!b) { if (errorBudget.size > 10000) errorBudget.clear(); b = { level: limits.errorBurst, at: now }; errorBudget.set(ctx.address, b); }
    b.level = Math.min(limits.errorBurst, b.level + (now - b.at) / 1000 * limits.errorRate); b.at = now;
    if (b.level < 1) { counters.droppedErrorRate++; return false; }
    b.level -= 1; responseBudget.level -= 1; return true;
  };
  const sendError = (ctx, msg, code, reason, extra = []) => errorAllowed(ctx) && respond(ctx, msg, CLASS.ERROR, failure(code, reason, extra).attributes);
  const challenge = (ctx, msg, code, reason) => sendError(ctx, msg, code, reason, [{ type: ATTR.REALM, value: realmBuf }, { type: ATTR.NONCE, value: makeNonce(ctx) }]);

  function unknownRequired(msg) {
    const out = [];
    for (const a of msg.attributes) if (a.type < 0x8000 && !KNOWN_REQUIRED.has(a.type) && !out.includes(a.type) && out.length < MAX_UNKNOWN_REPORTED) out.push(a.type);
    return out;
  }
  const unknownAttr = list => { const b = Buffer.alloc(list.length * 2); list.forEach((t, i) => b.writeUInt16BE(t, i * 2)); return { type: ATTR.UNKNOWN_ATTRIBUTES, value: b }; };

  // ---- client side ----
  function onClientMessage(ctx, buf) {
    const b0 = buf[0];
    if (b0 >= 0x40) { if (b0 < 0x80) onChannelData(ctx, buf); else counters.malformed++; return; }
    const msg = decode(buf);
    if (!msg) { counters.malformed++; return; }
    const fp = verifyFingerprint(msg);
    if (fp.present && !fp.valid) { counters.malformed++; return; }
    if (msg.cls === CLASS.INDICATION) { if (msg.method === METHOD.SEND) onSendIndication(ctx, msg); return; }
    if (msg.cls !== CLASS.REQUEST) return;
    return handleRequest(ctx, msg, fp.present).catch(e => fault(e, 'request'));
  }

  function onBinding(ctx, msg) {
    if (!errorAllowed(ctx)) return;
    const unknown = unknownRequired(msg);
    if (unknown.length) return sendError(ctx, msg, 420, 'Unknown Attribute', [unknownAttr(unknown)]);
    counters.bindings++;
    respond(ctx, msg, CLASS.SUCCESS, [{ type: ATTR.XOR_MAPPED_ADDRESS, value: encodeXorAddress(ctx, msg.transactionId) }]);
  }

  async function handleRequest(ctx, msg, hadFingerprint) {
    if (msg.method === METHOD.BINDING) return onBinding(ctx, msg);
    if (!TURN_METHODS.has(msg.method)) return sendError(ctx, msg, 400, 'Unsupported method');
    const cacheKey = `${ctx.tupleKey}|${msg.transactionId.toString('hex')}`, cached = responseCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) { counters.retransmissions++; return sendToClient(ctx, cached.buf); }
    if (inflight.has(cacheKey)) return; // retransmission of a request still being processed
    if (inflight.size >= MAX_INFLIGHT) { counters.droppedBusy++; return; }
    inflight.add(cacheKey);
    try {
      const auth = await authenticateRequest(ctx, msg);
      if (!auth || closed) return;
      const unknown = unknownRequired(msg);
      let result = unknown.length ? failure(420, 'Unknown Attribute', [unknownAttr(unknown)]) : HANDLERS[msg.method](ctx, msg, auth, hadFingerprint);
      if (isThenable(result)) result = await result;
      if (!result || closed) return;
      const buf = encode({ method: msg.method, cls: result.error ? CLASS.ERROR : CLASS.SUCCESS, transactionId: msg.transactionId,
        attributes: softwareAttr ? [...result.attributes, softwareAttr] : result.attributes }, { integrityKey: auth.key, fingerprint: true });
      responseCache.delete(cacheKey);
      responseCache.set(cacheKey, { buf, tuple: ctx.tupleKey, expires: Date.now() + RESPONSE_CACHE_MS });
      if (responseCache.size > RESPONSE_CACHE_MAX) responseCache.delete(responseCache.keys().next().value);
      sendToClient(ctx, buf);
    } finally { inflight.delete(cacheKey); }
  }

  // Long-term credentials (RFC 8489 9.2.4); every success returns the key used to sign the response.
  async function authenticateRequest(ctx, msg) {
    if (!getAttr(msg, ATTR.MESSAGE_INTEGRITY)) { challenge(ctx, msg, 401, 'Unauthorized'); return null; }
    const username = getAttr(msg, ATTR.USERNAME), requestRealm = getAttr(msg, ATTR.REALM), nonce = getAttr(msg, ATTR.NONCE);
    if (!username?.length || username.length > 512 || !requestRealm || !nonce) { sendError(ctx, msg, 400, 'Bad Request'); return null; }
    if (!validNonce(nonce, ctx)) { counters.staleNonces++; challenge(ctx, msg, 438, 'Stale Nonce'); return null; }
    const fail = reason => {
      counters.authFailures++;
      log('auth-failure', { reason, transport: ctx.transport, address: ctx.address, port: ctx.port });
      challenge(ctx, msg, 401, 'Unauthorized');
      return null;
    };
    if (!requestRealm.equals(realmBuf)) return fail('realm');
    const name = username.toString('utf8');
    let password;
    try { password = options.authenticate(name, realm); if (isThenable(password)) password = await withTimeout(password, limits.hookTimeoutMs); }
    catch (e) { fault(e, 'authenticate'); if (!closed) sendError(ctx, msg, 500, 'Server Error'); return null; }
    if (closed) return null;
    if (password === null || password === undefined || password === false) return fail('unknown-user');
    let key;
    try { key = longTermKey(username, realmBuf, password); } catch { return fail('bad-password'); }
    return verifyIntegrity(msg, key) ? { username: name, key } : fail('integrity');
  }

  function lifetimeFrom(attr) { // seconds; 0 only when explicitly requested (Refresh deletes)
    if (!attr || attr.length !== 4) return limits.defaultLifetime;
    const v = attr.readUInt32BE(0);
    return v === 0 ? 0 : Math.max(limits.defaultLifetime, Math.min(v, limits.maxLifetime));
  }

  function peerDecision(peer, username) {
    if (options.allowPeer) {
      let ok = false;
      try {
        ok = options.allowPeer({ family: peer.family, address: peer.address, port: peer.port }, { username });
        if (isThenable(ok)) { fault(new TypeError('allowPeer must return a boolean synchronously'), 'allowPeer'); ok = false; }
      } catch (e) { fault(e, 'allowPeer'); }
      return ok === true ? ALLOW : null;
    }
    const c = classifyPeerAddress(peer.address);
    if (c === 'deny') return null;
    if (ownAddresses.has(peer.address)) return OWN_ONLY; // e.g. our LAN/public relayed address: relay↔relay only
    return c === 'public' || (c === 'private' && options.allowPrivatePeers) ? ALLOW : null;
  }
  function prune(alloc, now) {
    for (const [ip, p] of alloc.permissions) if (p.expires <= now) alloc.permissions.delete(ip);
    for (const [n, c] of alloc.channels) if (c.expires <= now) { alloc.channels.delete(n); if (alloc.peerChannels.get(c.key) === n) alloc.peerChannels.delete(c.key); }
  }
  function setPermission(alloc, ip, decision, now) {
    const fresh = !alloc.permissions.has(ip);
    alloc.permissions.set(ip, { expires: now + limits.permissionLifetime * 1000, ownOnly: decision.ownOnly });
    if (fresh) log('permission', { username: alloc.username, peer: ip, ownOnly: decision.ownOnly });
  }

  async function bindRelaySocket(family, even) {
    const host = relayHosts[family], candidates = [];
    if (range) {
      const span = range[1] - range[0] + 1, start = Math.floor(Math.random() * span);
      for (let i = 0; i < span && candidates.length < 32; i++) { const p = range[0] + ((start + i) % span); if (!even || p % 2 === 0) candidates.push(p); }
    } else candidates.push(...Array(even ? 16 : 1).fill(0));
    for (const port of candidates) {
      if (closed) return null;
      const socket = dgram.createSocket({ type: family === 6 ? 'udp6' : 'udp4', ipv6Only: family === 6 });
      let bound = false;
      socket.on('error', e => { if (bound) fault(e, 'relay-socket'); });
      relaySockets.add(socket); socket.once('close', () => relaySockets.delete(socket));
      try { await bindDgram(socket, port, host); } catch { closeRelaySocket(socket); continue; }
      if (even && socket.address().port % 2) { closeRelaySocket(socket); continue; }
      bound = true; setBuffers(socket, 1 << 20);
      return socket;
    }
    return null;
  }
  function closeRelaySocket(socket) {
    if (!relaySockets.delete(socket)) return;
    const p = closeDgram(socket); pendingCloses.add(p); p.then(() => pendingCloses.delete(p));
  }
  async function defaultLocalAddress(family, ctx) {
    if (ctx.localAddress && net.isIPv6(ctx.localAddress) === (family === 6)) return ctx.localAddress;
    if (ctx.family === family) { const viaRoute = await routeSource(family, ctx.address, ctx.port); if (viaRoute) return viaRoute; }
    return interfaceAddress(family);
  }

  async function onAllocate(ctx, msg, auth, hadFingerprint) {
    if (allocations.has(ctx.tupleKey)) return failure(437, 'Allocation Mismatch');
    const transport = getAttr(msg, ATTR.REQUESTED_TRANSPORT);
    if (!transport || transport.length !== 4) return failure(400, 'Missing REQUESTED-TRANSPORT');
    if (transport[0] !== 17) return failure(442, 'Unsupported Transport Protocol');
    const even = getAttr(msg, ATTR.EVEN_PORT), token = getAttr(msg, ATTR.RESERVATION_TOKEN);
    const requested = getAttr(msg, ATTR.REQUESTED_ADDRESS_FAMILY), additional = getAttr(msg, ATTR.ADDITIONAL_ADDRESS_FAMILY);
    if ((token && (even || requested)) || (requested && additional) || (even && even.length !== 1) || (requested && requested.length !== 4) || (token && token.length !== 8))
      return failure(400, 'Bad Request');
    if (token) return failure(508, 'Reservation tokens not supported');
    if (even && even[0] & 0x80) return failure(508, 'Port reservation not supported');
    const family = requested ? (requested[0] === 1 ? 4 : requested[0] === 2 ? 6 : 0) : 4;
    if (!family || !relayHosts[family]) return failure(440, 'Address Family not Supported');
    if (allocations.size >= limits.maxAllocations) return failure(508, 'Insufficient Capacity');
    if ((byUser.get(auth.username)?.size ?? 0) >= limits.maxAllocationsPerUsername) return failure(486, 'Allocation Quota Reached');
    const lifetime = lifetimeFrom(getAttr(msg, ATTR.LIFETIME)) || limits.defaultLifetime;
    const alloc = { key: ctx.tupleKey, ctx, username: auth.username, family, ready: false, closed: false, stream: !!ctx.conn,
      fingerprint: hadFingerprint, permissions: new Map(), channels: new Map(), peerChannels: new Map(), indexKeys: [],
      up: bucket(limits.allocationBitrate), down: bucket(limits.allocationBitrate), expires: Infinity };
    allocations.set(alloc.key, alloc);
    if (!byUser.has(alloc.username)) byUser.set(alloc.username, new Set());
    byUser.get(alloc.username).add(alloc);
    const socket = await bindRelaySocket(family, !!even);
    const aborted = () => alloc.closed || closed || ctx.conn?.closed;
    if (!socket) { if (!aborted()) { deleteAllocation(alloc, 'bind-failed'); return failure(508, 'Insufficient Capacity'); } deleteAllocation(alloc, 'aborted'); return null; }
    if (alloc.closed) { closeRelaySocket(socket); return null; }
    alloc.socket = socket;
    const localPort = socket.address().port, bound = normalizeAddress(socket.address().address)?.address;
    let externalPort = localPort;
    if (options.mapRelayPort) {
      try { const p = await withTimeout(options.mapRelayPort(localPort, family), limits.hookTimeoutMs); if (Number.isInteger(p) && p > 0 && p <= 0xffff) externalPort = p; }
      catch (e) { log('map-port-error', { localPort, family, message: e?.message }); }
    }
    const localAddress = (bound && !isWildcard(bound) ? bound : await defaultLocalAddress(family, ctx)) ?? bound;
    if (aborted()) { deleteAllocation(alloc, 'aborted'); return null; }
    const advertised = external[family] ?? (isWildcard(localAddress) ? null : localAddress);
    if (!advertised) { deleteAllocation(alloc, 'no-address'); return failure(440, 'Address Family not Supported'); }
    alloc.internal = { address: localAddress, port: localPort };
    alloc.relayed = { family, address: advertised, port: externalPort };
    alloc.wildcardBound = !bound || isWildcard(bound);
    const keys = [...new Set([`${advertised}|${externalPort}`, `${localAddress}|${localPort}`])];
    if (keys.some(k => relayIndex.has(k))) { log('error', { where: 'relay-address-conflict', keys }); deleteAllocation(alloc, 'address-conflict'); return failure(508, 'Insufficient Capacity'); }
    alloc.indexKeys = keys; for (const k of keys) relayIndex.set(k, alloc);
    if (alloc.wildcardBound) wildcardPorts.set(`${family}|${localPort}`, alloc);
    socket.on('message', (m, r) => { try { onPeerMessage(alloc, m, r); } catch (e) { fault(e, 'relay'); } });
    alloc.ready = true; alloc.expires = Date.now() + lifetime * 1000;
    counters.allocationsCreated++;
    if (ctx.conn) { ctx.conn.alloc = alloc; ctx.conn.socket.setTimeout(0); }
    log('allocation', { username: alloc.username, transport: ctx.transport, client: `${ctx.address}:${ctx.port}`,
      relayed: `${advertised}:${externalPort}`, internal: `${localAddress}:${localPort}`, lifetime });
    return success([
      { type: ATTR.XOR_RELAYED_ADDRESS, value: encodeXorAddress(alloc.relayed, msg.transactionId) },
      { type: ATTR.LIFETIME, value: u32Value(lifetime) },
      { type: ATTR.XOR_MAPPED_ADDRESS, value: encodeXorAddress(ctx, msg.transactionId) },
    ]);
  }

  function onRefresh(ctx, msg, auth, alloc) {
    const requested = getAttr(msg, ATTR.REQUESTED_ADDRESS_FAMILY);
    if (requested && (requested.length !== 4 || (requested[0] === 2 ? 6 : 4) !== alloc.family)) return failure(443, 'Peer Address Family Mismatch');
    const lifetime = lifetimeFrom(getAttr(msg, ATTR.LIFETIME));
    if (lifetime === 0) deleteAllocation(alloc, 'refresh');
    else alloc.expires = Date.now() + lifetime * 1000;
    return success([{ type: ATTR.LIFETIME, value: u32Value(lifetime) }]);
  }

  function onCreatePermission(ctx, msg, auth, alloc) {
    const peers = [];
    for (const a of msg.attributes) if (a.type === ATTR.XOR_PEER_ADDRESS) {
      const p = decodeXorAddress(a.value, msg.transactionId);
      if (!p) return failure(400, 'Bad XOR-PEER-ADDRESS');
      peers.push(p);
    }
    if (!peers.length) return failure(400, 'Missing XOR-PEER-ADDRESS');
    if (peers.some(p => p.family !== alloc.family)) return failure(443, 'Peer Address Family Mismatch');
    const decisions = peers.map(p => peerDecision(p, alloc.username));
    const denied = peers.filter((p, i) => !decisions[i]);
    if (denied.length) { counters.peersDenied++; log('peer-denied', { username: alloc.username, peers: denied.map(p => p.address) }); return failure(403, 'Forbidden'); }
    const now = Date.now();
    prune(alloc, now);
    const fresh = new Set(peers.map(p => p.address).filter(ip => !alloc.permissions.has(ip)));
    if (alloc.permissions.size + fresh.size > limits.maxPermissions) return failure(508, 'Insufficient Capacity');
    peers.forEach((p, i) => setPermission(alloc, p.address, decisions[i], now));
    return success();
  }

  // RFC 8656 12.2: a channel and a peer transport address bind 1:1; rebinding the same pair refreshes it.
  function onChannelBind(ctx, msg, auth, alloc) {
    const number = getAttr(msg, ATTR.CHANNEL_NUMBER), value = getAttr(msg, ATTR.XOR_PEER_ADDRESS);
    const channel = number?.length === 4 ? number.readUInt16BE(0) : -1;
    if (channel < 0x4000 || channel > 0x4fff) return failure(400, 'Bad CHANNEL-NUMBER');
    const peer = value && decodeXorAddress(value, msg.transactionId);
    if (!peer) return failure(400, 'Bad XOR-PEER-ADDRESS');
    if (peer.family !== alloc.family) return failure(443, 'Peer Address Family Mismatch');
    const decision = peerDecision(peer, alloc.username);
    if (!decision) { counters.peersDenied++; log('peer-denied', { username: alloc.username, peers: [peer.address] }); return failure(403, 'Forbidden'); }
    const now = Date.now();
    prune(alloc, now);
    const key = `${peer.address}|${peer.port}`, bound = alloc.channels.get(channel), other = alloc.peerChannels.get(key);
    if (bound && bound.key !== key) return failure(400, 'Channel already bound to another peer');
    if (other !== undefined && other !== channel) return failure(400, 'Peer already bound to another channel');
    if (!bound && alloc.channels.size >= limits.maxChannels) return failure(508, 'Insufficient Capacity');
    if (!alloc.permissions.has(peer.address) && alloc.permissions.size >= limits.maxPermissions) return failure(508, 'Insufficient Capacity');
    alloc.channels.set(channel, { key, address: peer.address, port: peer.port, ownOnly: decision.ownOnly, expires: now + limits.channelLifetime * 1000 });
    alloc.peerChannels.set(key, channel);
    setPermission(alloc, peer.address, decision, now);
    if (!bound) log('channel-bind', { username: alloc.username, channel, peer: `${peer.address}:${peer.port}` });
    return success();
  }

  const withAllocation = fn => (ctx, msg, auth) => {
    const alloc = allocations.get(ctx.tupleKey);
    if (!alloc?.ready || alloc.closed) return failure(437, 'Allocation Mismatch');
    if (alloc.username !== auth.username) return failure(441, 'Wrong Credentials');
    return fn(ctx, msg, auth, alloc);
  };
  const HANDLERS = { [METHOD.ALLOCATE]: onAllocate, [METHOD.REFRESH]: withAllocation(onRefresh),
    [METHOD.CREATE_PERMISSION]: withAllocation(onCreatePermission), [METHOD.CHANNEL_BIND]: withAllocation(onChannelBind) };

  // ---- data paths ----
  function activeAllocation(ctx) {
    const alloc = allocations.get(ctx.tupleKey);
    if (alloc?.ready && !alloc.closed) return alloc;
    counters.droppedNoAllocation++;
    return null;
  }
  function onSendIndication(ctx, msg) {
    const alloc = activeAllocation(ctx);
    if (!alloc) return;
    const value = getAttr(msg, ATTR.XOR_PEER_ADDRESS), data = getAttr(msg, ATTR.DATA);
    const peer = value && data && !unknownRequired(msg).length ? decodeXorAddress(value, msg.transactionId) : null;
    if (!peer || peer.family !== alloc.family) { counters.malformed++; return; }
    const perm = alloc.permissions.get(peer.address);
    if (!perm || perm.expires <= Date.now()) { counters.droppedNoPermission++; return; }
    toPeer(alloc, peer.address, peer.port, data, perm.ownOnly);
  }
  function onChannelData(ctx, buf) {
    const alloc = activeAllocation(ctx);
    if (!alloc) return;
    const cd = decodeChannelData(buf);
    if (!cd) { counters.malformed++; return; }
    const ch = alloc.channels.get(cd.channel);
    if (!ch || ch.expires <= Date.now()) { counters.droppedNoChannel++; return; }
    toPeer(alloc, ch.address, ch.port, cd.data, ch.ownOnly);
  }
  // Any of our own relayed transport addresses (advertised or locally bound) short-circuits inside
  // the process, so relay↔relay works without NAT hairpinning.
  function relayTarget(ip, port, family) {
    const hit = relayIndex.get(`${ip}|${port}`);
    if (hit) return hit;
    const wild = wildcardPorts.get(`${family}|${port}`);
    return wild && ownAddresses.has(ip) ? wild : null;
  }
  function toPeer(alloc, ip, port, data, ownOnly) {
    if (selfEndpoints.has(`${ip}|${port}`)) { counters.droppedPolicy++; return; }
    const target = relayTarget(ip, port, alloc.family);
    if (!target && ownOnly) { counters.droppedPolicy++; return; }
    if (!take(alloc.up, globalUp, data.length)) { counters.droppedRateLimited++; return; }
    counters.bytesToPeers += data.length;
    if (!target) { alloc.socket.send(data, port, ip, onSendDone); return; }
    if (!target.ready || target.closed) return;
    counters.relayedInternally++; counters.bytesFromPeers += data.length;
    const from = alloc.relayed, perm = target.permissions.get(from.address);
    if (!perm || perm.expires <= Date.now()) { counters.droppedNoPermission++; return; }
    toClient(target, from.address, from.port, data);
  }
  function onPeerMessage(alloc, data, rinfo) {
    if (!alloc.ready || alloc.closed) return;
    counters.bytesFromPeers += data.length;
    const ip = alloc.family === 4 ? rinfo.address : normalizeAddress(rinfo.address)?.address;
    const perm = ip && alloc.permissions.get(ip);
    if (!perm || perm.expires <= Date.now()) { counters.droppedNoPermission++; return; }
    toClient(alloc, ip, rinfo.port, data);
  }
  function toClient(alloc, ip, port, data) {
    if (!take(alloc.down, globalDown, data.length)) { counters.droppedRateLimited++; return; }
    const n = alloc.peerChannels.get(`${ip}|${port}`), ch = n === undefined ? null : alloc.channels.get(n);
    let buf;
    if (ch && ch.expires > Date.now()) buf = encodeChannelData(n, data, { pad: alloc.stream });
    else {
      const tid = nextTid();
      buf = encode({ method: METHOD.DATA, cls: CLASS.INDICATION, transactionId: tid, attributes: [
        { type: ATTR.XOR_PEER_ADDRESS, value: encodeXorAddress({ family: alloc.family, address: ip, port }, tid) },
        { type: ATTR.DATA, value: data }] }, { fingerprint: alloc.fingerprint });
    }
    sendToClient(alloc.ctx, buf, true);
  }

  function deleteAllocation(alloc, reason) {
    if (alloc.closed) return;
    alloc.closed = true;
    if (allocations.get(alloc.key) === alloc) allocations.delete(alloc.key);
    const owned = byUser.get(alloc.username);
    if (owned) { owned.delete(alloc); if (!owned.size) byUser.delete(alloc.username); }
    for (const k of alloc.indexKeys) if (relayIndex.get(k) === alloc) relayIndex.delete(k);
    if (alloc.internal) { const k = `${alloc.family}|${alloc.internal.port}`; if (wildcardPorts.get(k) === alloc) wildcardPorts.delete(k); }
    if (alloc.socket) closeRelaySocket(alloc.socket);
    const conn = alloc.ctx.conn;
    if (conn?.alloc === alloc) { conn.alloc = null; if (!conn.closed) conn.socket.setTimeout(limits.tcpIdleMs); }
    if (alloc.ready) {
      counters.allocationsDeleted++;
      log('allocation-deleted', { username: alloc.username, reason, relayed: `${alloc.relayed.address}:${alloc.relayed.port}` });
    }
  }
  function purgeCache(tuple) { for (const [k, v] of responseCache) if (v.tuple === tuple) responseCache.delete(k); }
  function tearDown(alloc, reason) { purgeCache(alloc.key); deleteAllocation(alloc, reason); alloc.ctx.conn?.socket.destroy(); }

  function sweep() {
    try {
      const now = Date.now();
      for (const a of [...allocations.values()]) if (a.ready && !a.closed) { if (a.expires <= now) tearDown(a, 'expired'); else prune(a, now); }
      for (const [k, v] of responseCache) { if (v.expires > now) break; responseCache.delete(k); }
      if (now - addressesAt >= ADDRESS_REFRESH_MS) refreshOwnAddresses();
    } catch (e) { fault(e, 'sweep'); }
  }

  // ---- listeners ----
  function onUdpMessage(l, buf, rinfo) {
    counters.bytesFromClients += buf.length;
    const n = normalizeAddress(rinfo.address);
    if (!n || !rinfo.port || closed) return;
    onClientMessage({ transport: 'udp', listener: l, family: n.family, address: n.address, port: rinfo.port, sendAddress: rinfo.address,
      localAddress: l.wildcard ? null : l.localAddress, tupleKey: `udp|${l.index}|${n.address}|${rinfo.port}` }, buf);
  }
  const tcpPerAddress = new Map();
  function onRawConnection(l, raw) {
    raw.on('error', () => {});
    const address = raw.remoteAddress ?? '?', count = tcpPerAddress.get(address) ?? 0;
    // A global cap alone lets one host occupy every slot; TCP is the rescue path for
    // UDP-blocked users, so each source address gets a bounded share.
    if (closed || rawSockets.size >= limits.maxTcpConnections || count >= limits.maxTcpPerAddress) {
      counters.tcpRejected++; log('tcp-rejected', { transport: l.transport, address, reason: closed ? 'closed' : count >= limits.maxTcpPerAddress ? 'per-address' : 'max-connections' });
      raw.destroy(); return;
    }
    tcpPerAddress.set(address, count + 1);
    rawSockets.add(raw); raw.once('close', () => {
      rawSockets.delete(raw);
      const n = (tcpPerAddress.get(address) ?? 1) - 1; if (n > 0) tcpPerAddress.set(address, n); else tcpPerAddress.delete(address);
    });
    if (l.transport === 'tcp') onStream(l, raw);
  }
  // Requests on a stream are processed in order: reading pauses while a request awaits authentication
  // or relay-socket binding, so a Send/ChannelData pipelined after its CreatePermission/ChannelBind sees it.
  function updateFlow(conn) {
    const pause = conn.busy || conn.writeBlocked;
    if (pause && !conn.paused) { conn.paused = true; conn.socket.pause(); } else if (!pause && conn.paused) { conn.paused = false; conn.socket.resume(); }
  }
  function pump(conn) {
    while (conn.backlog.length && !conn.busy && !conn.closed) {
      let r;
      try { r = onClientMessage(conn.ctx, conn.backlog.shift()); } catch (e) { fault(e, 'stream'); conn.socket.destroy(); return; }
      if (isThenable(r)) {
        conn.busy = true; updateFlow(conn);
        r.then(() => { conn.busy = false; if (!conn.closed) { updateFlow(conn); pump(conn); } });
      }
    }
  }
  function onStream(l, socket) {
    const remote = normalizeAddress(socket.remoteAddress), local = normalizeAddress(socket.localAddress);
    if (closed || !remote) { socket.destroy(); return; }
    const conn = { id: ++connSeq, socket, pending: [], size: 0, need: 4, backlog: [], alloc: null, closed: false, busy: false, paused: false, writeBlocked: false };
    conn.ctx = { transport: l.transport, listener: l, conn, family: remote.family, address: remote.address, port: socket.remotePort,
      localAddress: local && !isWildcard(local.address) ? local.address : null, tupleKey: `${l.transport}|${l.index}|${conn.id}` };
    conns.add(conn);
    socket.setNoDelay(true);
    // Until an allocation exists the connection gets a short leash (pre-authentication).
    socket.setTimeout(limits.tcpPreAuthMs, () => { counters.tcpIdleClosed++; socket.destroy(); });
    socket.on('data', chunk => {
      try {
        counters.bytesFromClients += chunk.length;
        conn.pending.push(chunk); conn.size += chunk.length;
        if (conn.size < conn.need) return; // concatenate only once a whole frame is buffered
        const { messages, rest, need, error } = frameStreamMessages(conn.pending.length === 1 ? conn.pending[0] : Buffer.concat(conn.pending, conn.size));
        conn.pending = rest.length ? [rest] : []; conn.size = rest.length; conn.need = need || 4;
        for (const m of messages) conn.backlog.push(m);
        pump(conn);
        if (error) { counters.malformed++; socket.destroy(); }
      } catch (e) { fault(e, 'stream'); socket.destroy(); }
    });
    socket.on('drain', () => { if (conn.writeBlocked) { conn.writeBlocked = false; updateFlow(conn); } });
    socket.on('error', () => {});
    socket.on('close', () => {
      conn.closed = true; conn.backlog.length = 0; conns.delete(conn);
      if (conn.alloc) deleteAllocation(conn.alloc, 'connection-closed');
    });
  }
  async function openListener(spec, index) {
    const transport = spec.transport ?? 'udp', host = spec.host ?? '0.0.0.0', port = spec.port ?? (transport === 'tls' ? 5349 : 3478);
    if (!['udp', 'tcp', 'tls'].includes(transport)) throw new TypeError(`unsupported listen transport: ${transport}`);
    if (!net.isIP(host)) throw new TypeError(`listen host must be an IP literal: ${host}`);
    if (transport === 'tls' && (!spec.key || !spec.cert)) throw new TypeError('tls listeners need key and cert');
    const l = { transport, index, host, wildcard: isWildcard(host) };
    listeners.push(l);
    if (transport === 'udp') {
      l.socket = dgram.createSocket({ type: net.isIPv6(host) ? 'udp6' : 'udp4' });
      await bindDgram(l.socket, port, host);
      l.socket.on('error', e => fault(e, 'udp-listener'));
      l.socket.on('message', (m, r) => { try { onUdpMessage(l, m, r); } catch (e) { fault(e, 'udp'); } });
      setBuffers(l.socket, 4 << 20);
    } else {
      l.server = transport === 'tls'
        ? tls.createServer({ key: spec.key, cert: spec.cert, passphrase: spec.passphrase, minVersion: 'TLSv1.2', handshakeTimeout: TLS_HANDSHAKE_MS })
        : net.createServer();
      l.server.on('connection', raw => { try { onRawConnection(l, raw); } catch (e) { fault(e, 'accept'); raw.destroy(); } });
      if (transport === 'tls') {
        l.server.on('secureConnection', s => { try { onStream(l, s); } catch (e) { fault(e, 'accept'); s.destroy(); } });
        l.server.on('tlsClientError', (e, s) => { counters.tlsErrors++; s?.destroy(); });
      }
      await new Promise((resolve, reject) => { l.server.once('error', reject); l.server.listen({ host, port, exclusive: true }, () => { l.server.off('error', reject); resolve(); }); });
      l.server.on('error', e => fault(e, `${transport}-listener`));
    }
    const a = (l.socket ?? l.server).address();
    l.address = a.address; l.port = a.port; l.localAddress = normalizeAddress(a.address)?.address ?? a.address;
    log('listening', { transport, address: l.address, port: l.port });
  }

  function close() {
    if (closing) return closing;
    closed = true;
    clearInterval(sweepTimer);
    closing = (async () => {
      for (const a of [...allocations.values()]) deleteAllocation(a, 'shutdown');
      for (const c of conns) c.socket.destroy();
      for (const raw of rawSockets) raw.destroy();
      for (const s of [...relaySockets]) closeRelaySocket(s);
      const waits = [...pendingCloses];
      for (const l of listeners) {
        if (l.socket) waits.push(closeDgram(l.socket));
        else if (l.server?.listening) waits.push(new Promise(resolve => l.server.close(() => resolve())));
      }
      await Promise.all(waits);
      responseCache.clear(); inflight.clear();
      log('closed');
    })();
    return closing;
  }

  const sweepTimer = setInterval(sweep, SWEEP_MS);
  sweepTimer.unref();
  try { for (const [i, spec] of listenSpecs.entries()) await openListener(spec, i); }
  catch (e) { await close(); throw e; }
  refreshOwnAddresses();

  return {
    addresses: () => listeners.map(l => ({ transport: l.transport, address: l.address, port: l.port })),
    relayedAddresses: () => [...allocations.values()].filter(a => a.ready && !a.closed).map(a => ({
      internal: { address: a.internal.address, port: a.internal.port }, external: { address: a.relayed.address, port: a.relayed.port }, username: a.username })),
    stats() {
      const now = Date.now();
      let allocationCount = 0, permissions = 0, channels = 0;
      for (const a of allocations.values()) {
        if (!a.ready || a.closed) continue;
        allocationCount++;
        for (const p of a.permissions.values()) if (p.expires > now) permissions++;
        for (const c of a.channels.values()) if (c.expires > now) channels++;
      }
      return { allocations: allocationCount, permissions, channels, tcpConnections: conns.size, ...counters };
    },
    revoke(predicate) {
      let count = 0;
      for (const a of [...allocations.values()]) {
        let hit = false;
        try { hit = !!predicate(a.username); } catch (e) { fault(e, 'revoke'); }
        if (hit && !a.closed) { count++; tearDown(a, 'revoked'); }
      }
      if (count) log('revoked', { count });
      return count;
    },
    close,
  };
}
