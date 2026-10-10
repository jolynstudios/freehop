// SPDX-License-Identifier: Apache-2.0
// A room is the set of peers sharing one secret. Gates only introduce peers; once two peers
// are linked, signalling flows over their own data channel. Media takes the cheapest
// working path: direct (host/IPv6/srflx/prflx) or an endpoint's own gateway, then a gateway
// run by another session member, then forwarding by another participant. No path uses
// infrastructure outside the session's own peers unless the application opts into its own TURN
// relay (the `turn` option), the last rung before `unreachable`.
import { deriveRoom, seal, open, randomId } from './crypto.mjs';
import { Emitter, GateClient } from './gate-client.mjs';
import { TrackerClient } from './tracker-client.mjs';
import { validIceUrl, validStunUrls, validTurnServers, normalizeTurnServers } from './ice-urls.mjs';
import { PeerLink, PHASE } from './peer.mjs';
import { classifyNat, cleanNat } from './nat.mjs';

const PEER_ID = /^[A-Za-z0-9_-]{22}$/;
const IP = /^[0-9a-fA-F.:]{2,45}$/;
const pairKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
// Gateway members (the session's host node) announce themselves with this id prefix. The
// prefix is only a hint; their gateway is learned from sealed caps like anything else.
const isGatewayMember = id => id.startsWith('gw_');
const KINDS = new Set(['caps', 'description', 'candidate', 'bye', 'restart-request', 'video-quality', 'bridge-request', 'bridge-offer', 'bridge-accept',
  'bridge-confirm', 'bridge-ready', 'bridge-active', 'bridge-release', 'bridge-fail', 'forward-map', 'forward-unmap', 'app']);
// Application messages (session.send): sealed like all signalling, at most 4096 characters of JSON; each
// receiver accepts at most 20 per second from one sender (burst 40).
export const APP_MESSAGE_BYTES = 4096;
const MIC = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const CAM = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } };
const VIDEO_QUALITY = Object.freeze(['normal', 'reduced', 'minimal', 'paused']);
const VIDEO_QUALITY_INDEX = Object.freeze(Object.fromEntries(VIDEO_QUALITY.map((level, index) => [level, index])));
const VIDEO_QUALITY_SETTINGS = Object.freeze([
  {bitrate: null, framerate: null, scale: 1, active: true},
  {bitrate: 180000, framerate: 15, scale: 1.5, active: true},
  {bitrate: 90000, framerate: 10, scale: 2, active: true},
  {bitrate: null, framerate: null, scale: 2, active: false},
]);
const deviceId = id => id === null || id === undefined || typeof id === 'string' && id.length > 0 && id.length <= 256;
const APP_RATE = 20, APP_BURST = 40;

export const DEFAULT_TIMING = Object.freeze({ capsWaitMs: 150, politeWaitMs: 1500, endpointMs: 5000, sessionMs: 7000,
  bridgedRetryMs: 30000, maxRetryMs: 300000, restartFallbackMs: 2500, mediaWatchMs: 5000,
  recoveryMs: 4000, bridgeWaitMs: 4000, departGraceMs: 8000, offerTimeoutMs: 8000, greetMs: 20000, outboxMs: 20000, sweepMs: 2000 });
export const DEFAULT_LIMITS = Object.freeze({ audioBitrate: 32000, videoBitrate: 300000, forwardVideoBitrate: 200000,
  maxPeers: 8, maxGatewayMembers: 4, maxHints: 64, maxBridges: 4, meshForwardPerMinute: 600, outboxPerPeer: 32 });

export async function join(options) {
  const room = new Room(options);
  // A failed start (e.g. a refused microphone) must not leave captured devices running.
  try { await room.start(); } catch (error) { await room.leave().catch(() => {}); throw error; }
  return room;
}

const turnUrls = list => (Array.isArray(list) ? list : []).filter(u => validIceUrl(u, 'turn')).slice(0, 4);
const addresses = list => (Array.isArray(list) ? list : []).filter(a => typeof a === 'string' && IP.test(a)).slice(0, 4);

// A gateway as shared by another peer: TURN URLs plus credentials minted for us.
function cleanGateway(g) {
  if (!g || typeof g.username !== 'string' || typeof g.credential !== 'string') return null;
  const urls = turnUrls(g.urls);
  if (!urls.length || g.username.length > 256 || g.credential.length > 256) return null;
  return { urls, username: g.username, credential: g.credential, external: addresses(g.external),
    internal: typeof g.internal === 'string' && IP.test(g.internal) ? g.internal : null };
}

// Public gateway metadata plus a credential broker. The signing key never enters the room.
function cleanOwnGateway(g) {
  if (!g || typeof g.credentialsFor !== 'function') return null;
  const info = typeof g.info === 'function' ? g.info() : g;
  if (!info) return null;
  const urls = turnUrls(info.urls);
  if (!urls.length) return null;
  return { urls, internalUrls: turnUrls(info.internalUrls), credentialsFor: g.credentialsFor.bind(g), ttlSeconds: info.ttlSeconds ?? 7200,
    external: addresses(info.external), internal: typeof info.internal === 'string' && IP.test(info.internal) ? info.internal : null };
}

const sameGateway = (a, b) => !!a && !!b && a.urls.join() === b.urls.join() && a.external.join() === b.external.join();

// Some WebKit builds reject "?transport=" in TURN URLs (WebKit bug 320931). Detect once and
// degrade to the default (UDP) form instead of failing the whole peer connection.
let transportParamSupported;
function compatibleServers(servers, PeerConnection) {
  if (transportParamSupported === undefined) {
    try { new PeerConnection({ iceServers: [{ urls: 'turn:192.0.2.1:3478?transport=tcp', username: 'u', credential: 'c' }] }).close(); transportParamSupported = true; }
    catch { transportParamSupported = false; }
  }
  if (transportParamSupported) return servers;
  return servers.map(s => ({ ...s, urls: [...new Set((Array.isArray(s.urls) ? s.urls : [s.urls]).filter(u => !/\?transport=tcp/.test(u)).map(u => u.replace(/\?transport=udp$/, '')))] }))
    .filter(s => s.urls.length);
}

export class Room extends Emitter {
  constructor(options) {
    super();
    if (!Array.isArray(options?.gates) || !options.gates.length) throw new TypeError('At least one gate URL is required.');
    if (options.stun !== undefined && !validStunUrls(options.stun)) throw new TypeError('Invalid application STUN URLs');
    if (typeof options.auth === 'string' && options.gates.length !== 1) throw new TypeError('Use per-gate auth tokens for multiple gates');
    this.options = options;
    this.app = options.app ?? 'peerlane';
    this.RTCPeerConnection = options.RTCPeerConnection ?? globalThis.RTCPeerConnection;
    this.WebSocket = options.WebSocket ?? globalThis.WebSocket;
    this.getUserMedia = options.getUserMedia ?? (c => navigator.mediaDevices.getUserMedia(c));
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    if (options.adaptiveVideo !== undefined && typeof options.adaptiveVideo !== 'boolean') throw new TypeError('adaptiveVideo must be a boolean');
    this.adaptiveVideoEnabled = options.adaptiveVideo === true;
    // Opt-in traversal aids; with both unset the ladder, caps and stats are exactly as before.
    for (const name of ['classifyNat', 'portPrediction']) if (options[name] !== undefined && typeof options[name] !== 'boolean') throw new TypeError(`${name} must be a boolean`);
    if (options.portPrediction === true && options.classifyNat === false) throw new TypeError('portPrediction needs classifyNat');
    this.portPredictionEnabled = options.portPrediction === true;
    this.classifyNatEnabled = this.portPredictionEnabled || options.classifyNat === true;
    this.nat = null;
    if (options.turn !== undefined && options.turn !== null && !validTurnServers(options.turn)) throw new TypeError('Invalid application TURN servers');
    this.turnServers = normalizeTurnServers(options.turn);
    this.log = options.log ?? (() => {});
    do { this.id = randomId(16); } while (isGatewayMember(this.id));
    this.links = new Map(); this.caps = new Map(); this.known = new Set(); this.departed = new Map(); this.gatewayMembers = new Set();
    this.presence = new Map();    // peer -> Set(gate) — unauthenticated hints from gates
    this.hintedAt = new Map(); // first unauthenticated hint; repeated rosters cannot refresh its lifetime
    this.lastContact = new Map(); // peer -> time of the last presence, authenticated envelope or live link
    this.greeted = new Map();     // peer -> time we last sent it our caps
    this.outbox = new Map();      // peer -> [{ box, until }] envelopes waiting for a route
    this.pendingLinks = new Map(); this.early = new Map(); this.sequences = new Map();
    this.gates = []; this.stunUrls = new Set(options.stun ?? []);
    this.ownGateway = cleanOwnGateway(options.gateway); this.gatewayCreds = new Map();
    this.forward = options.forward !== false;
    this.bridges = new Map();     // as an endpoint: pairKey -> { peer, via, state, requestedAt }
    this.relaying = new Map();    // as a forwarder: pairKey -> { a, b }
    this.bridgePending = new Map(); // forwarding awaits consent from the second endpoint
    this.bridgeOffers = new Map();// as a forwarder: pairKey -> { a, b, at } offers we made
    this.counters = { sent: 0, viaMesh: 0, viaGate: 0, viaIntroducer: 0, queued: 0, undeliverable: 0, received: 0, rejected: 0, duplicates: 0,
      meshForwarded: 0, candidateErrors: 0, negotiationErrors: 0, linkErrors: 0, escalations: 0, bridgesUsed: 0, bridgesServed: 0,
      offerTimeouts: 0, mediaStalls: 0, appSent: 0, appReceived: 0, appDropped: 0 };
    this.appBudget = new Map();   // sender -> { tokens, at }
    this.videoQuality = new Map(); // peer -> per-link send/receive controller state
    this.mutedPeers = new Set();  // peers muted locally (setPeerMuted)
    this.remoteAudio = new Map(); // peer -> Set of live remote audio tracks, for flipping enabled
    // Preferred capture devices (options.devices, switchDevice); every later capture uses them.
    if (!deviceId(options.devices?.audio) || !deviceId(options.devices?.video)) throw new TypeError('Invalid capture device id');
    this.devices = { audio: options.devices?.audio ?? null, video: options.devices?.video ?? null };
    this.sendCounter = 0; this.closed = false; this.localStream = null; this.ownsMedia = false;
    this.sendProgress = new Map(); this.meshBudget = new Map();
    this.audioRestores = new WeakMap(); this.checkingSending = false;
  }

  get tag8() { return this.tag.slice(0, 8); }

  async start() {
    this.crypto = await deriveRoom(this.options.secret, this.app);
    this.tag = this.crypto.tag;
    if (this.ownGateway) await this.gatewayCredsFor('self');
    await this.setMedia(this.options.media ?? null);
    this.openGates();
    this.mediaWatch = setInterval(() => this.checkSending(), this.timing.mediaWatchMs);
    this.sweeper = setInterval(() => this.sweep(), this.timing.sweepMs);
  }

  openGates() {
    const epoch = this.crypto;
    for (const url of this.options.gates) {
      // "bt+wss://tracker/..." uses a public WebTorrent tracker as a gate (magnet-style).
      const gate = url.startsWith('bt+')
        ? new TrackerClient(url.slice(3), { room: this.tag, peer: this.id, WebSocketImpl: this.WebSocket,
            needsIntroduction: () => this.known.size === 0,
            hello: () => seal(epoch, this.id, '*', { kind: 'hello', n: ++this.sendCounter }) })
        // Auth is read at every (re)connect, so refreshed tokens (session.refresh) apply without a rotation.
        : new GateClient(url, { room: this.tag, peer: this.id, auth: gateUrl => { const a = this.options.auth; return a && typeof a === 'object' ? a[gateUrl] : a; }, WebSocketImpl: this.WebSocket });
      gate.on('hello', async ({ gate: g, from, box, route }) => {
        if (this.closed || !PEER_ID.test(from) || from === this.id || this.blocked(from)) return;
        const p = await open(epoch, from, '*', box);
        if (this.closed || epoch !== this.crypto || this.blocked(from) || p?.kind !== 'hello' || !Number.isSafeInteger(p.n) || p.n < 1 || !this.acceptSequence(from, p.n)) return;
        g.bind?.(from, route);
        this.hint(from, g);
      });
      gate.on('joined', ({ peers }) => {
        if (this.closed || epoch !== this.crypto) return;
        // Gate messages cannot choose servers the browser will contact.
        this.emit('gate', { url, state: 'joined' });
        for (const p of peers) this.hint(p, gate);
      });
      gate.on('peer', ({ peer, on }) => on ? this.hint(peer, gate) : this.lostOnGate(peer, gate));
      gate.on('left', () => { for (const p of [...this.presence.keys()]) this.lostOnGate(p, gate); this.emit('gate', { url, state: 'reconnecting' }); });
      gate.on('recv', ({ gate: g, from, box, route }) => { if (PEER_ID.test(from)) this.receiveBox(from, box, g, route); });
      gate.on('gate-error', ({ code }) => this.emit('gate', { url, state: 'error', code }));
      this.gates.push(gate);
      gate.connect();
    }
  }

  // Rotation closes every old-key link, including unreported identities. Possession of the
  // new secret is required to reconnect; a known peer id alone is never sufficient.
  rekey(secret, options = {}) {
    const task = (this.rekeyTask ?? Promise.resolve()).then(() => this.changeKey(secret, options));
    this.rekeyTask = task.catch(() => {});
    return task;
  }

  async changeKey(secret, { auth, gates, stun, turn } = {}) {
    if (this.closed) return;
    if (gates !== undefined && (!Array.isArray(gates) || !gates.length)) throw new TypeError('At least one gate URL is required.');
    if (stun !== undefined && !validStunUrls(stun)) throw new TypeError('Invalid application STUN URLs');
    if (turn !== undefined && turn !== null && !validTurnServers(turn)) throw new TypeError('Invalid application TURN servers');
    const nextGates = gates ?? this.options.gates;
    if (typeof auth === 'string' && nextGates.length !== 1) throw new TypeError('Use per-gate auth tokens for multiple gates');
    const next = await deriveRoom(secret, this.app);
    if (this.closed) return;
    // A rotation may also evict a gate or change STUN: the next ticket's lists replace the old ones.
    this.options = { ...this.options, auth, gates: nextGates };
    if (stun !== undefined) this.stunUrls = new Set(stun);
    if (turn !== undefined) this.turnServers = normalizeTurnServers(turn);
    if (next.tag === this.tag) return;
    for (const gate of this.gates) gate.close();
    clearTimeout(this.capsTimer); this.capsTimer = null;
    for (const peer of [...this.known]) this.dropPeer(peer, 'rekey');
    for (const t of this.pendingLinks.values()) clearTimeout(t);
    for (const id of this.gatewayMembers) this.emit('gateway', { id, available: false });
    this.crypto = next; this.tag = next.tag;
    this.gates = []; this.presence.clear(); this.hintedAt.clear(); this.caps.clear(); this.gatewayMembers.clear();
    this.pendingLinks.clear(); this.early.clear(); this.sequences.clear(); this.greeted.clear(); this.lastContact.clear();
    this.outbox.clear(); this.bridges.clear(); this.relaying.clear(); this.bridgeOffers.clear(); this.bridgePending.clear(); this.sendProgress.clear(); this.meshBudget.clear();
    this.gatewayCreds.clear(); if (this.ownGateway) await this.gatewayCredsFor('self');
    if (!this.closed) this.openGates();
    this.scheduleCapsBroadcast();
  }

  // Disconnect a peer now (e.g. after a kick, together with rekey()).
  drop(peer) { this.dropPeer(peer, 'dropped'); }

  /**
   * Send application data (any JSON value, at most 4096 characters) to one member (`{ to: peerId }`) or to every
   * member. It travels sealed, like signalling: over the peers' own data channel once linked,
   * otherwise through the gates. Receivers get a 'message' event { from, data }; treat it as
   * untrusted input. Resolves to the number of members it was handed to.
   */
  async send(data, { to } = {}) {
    if (this.closed) return 0;
    let size; try { size = JSON.stringify(data ?? null).length; } catch { throw new TypeError('Message data must be JSON-serialisable.'); }
    if (data === undefined || size > APP_MESSAGE_BYTES) throw new RangeError(`Message data must be at most ${APP_MESSAGE_BYTES} characters of JSON.`);
    const targets = to === undefined ? [...this.known] : this.known.has(to) ? [to] : [];
    for (const peer of targets) { this.signalTo(peer, { kind: 'app', data }).catch(() => {}); this.counters.appSent++; }
    return targets.length;
  }

  takeAppToken(from) {
    const now = Date.now(), b = this.appBudget.get(from) ?? { tokens: APP_BURST, at: now };
    b.tokens = Math.min(APP_BURST, b.tokens + (now - b.at) * APP_RATE / 1000); b.at = now;
    this.appBudget.set(from, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1; return true;
  }

  count(name, error) { this.counters[name] = (this.counters[name] ?? 0) + 1; if (error) this.log(name, { message: error?.message ?? String(error) }); }

  // ---------- discovery: hints from gates, admission only after authentication ----------
  // A peer that left (bye) or was dropped (kick) stays out; one that merely vanished from
  // the gates (network change) is welcome back once it proves itself again.
  blocked(peer) {
    const d = this.departed.get(peer);
    if (!d) return false;
    if (d.reason !== 'gone' && d.reason !== 'rekey') return true;
    this.departed.delete(peer);
    return false;
  }

  // Gate rosters are unauthenticated: they only make us greet the peer with sealed caps. A
  // peer becomes a member (events, links, slots) once an envelope from it authenticates.
  hint(peer, gate) {
    if (this.closed || peer === this.id || !PEER_ID.test(peer) || this.blocked(peer)) return;
    if (gate) {
      let set = this.presence.get(peer);
      if (!set) {
        const budget = Math.max(1, Math.floor(this.limits.maxHints / this.options.gates.length));
        const used = [...this.presence].filter(([id, sources]) => !this.known.has(id) && !this.gatewayMembers.has(id) && sources.has(gate)).length;
        if (this.presence.size >= this.limits.maxHints || !this.known.has(peer) && !this.gatewayMembers.has(peer) && used >= budget) return;
        set = new Set(); this.presence.set(peer, set);
      }
      set.add(gate);
      if (!this.known.has(peer) && !this.gatewayMembers.has(peer) && !this.hintedAt.has(peer)) this.hintedAt.set(peer, Date.now());
      this.lastContact.set(peer, Date.now());
      this.flushOutbox(peer);
    }
    const last = this.greeted.get(peer) ?? 0;
    if (!this.known.has(peer) && !this.gatewayMembers.has(peer) && Date.now() - last > this.timing.greetMs) {
      this.greeted.set(peer, Date.now());
      if (this.greeted.size > this.limits.maxHints * 2) this.greeted.delete(this.greeted.keys().next().value);
      this.sendCaps(peer);
    }
  }

  admit(peer) {
    if (this.known.has(peer)) return true;
    if (isGatewayMember(peer) || this.closed || this.blocked(peer) || this.known.size >= this.limits.maxPeers) return false;
    this.hintedAt.delete(peer);
    this.known.add(peer); this.emit('peer', { id: peer });
    if (!this.greeted.has(peer) || Date.now() - this.greeted.get(peer) > 2000) { this.greeted.set(peer, Date.now()); this.sendCaps(peer); }
    if (!this.links.has(peer) && !this.pendingLinks.has(peer)) {
      // The impolite side (lower id) opens the link right away (the caps it just
      // authenticated name any gateway); the polite side waits for that offer.
      const delay = this.id < peer ? this.timing.capsWaitMs : this.timing.politeWaitMs;
      this.pendingLinks.set(peer, setTimeout(() => this.ensureLink(peer), delay));
    }
    return true;
  }

  lostOnGate(peer, gate) {
    const set = this.presence.get(peer); if (!set) return;
    set.delete(gate);
    if (!set.size) this.presence.delete(peer);
  }

  // Departures: a peer absent from every gate whose link is not connected is dropped after
  // departGraceMs; a dead data channel can read "open" for a long time, so it does not count.
  sweep() {
    if (this.closed) return;
    const now = Date.now();
    for (const [peer, at] of this.hintedAt) {
      if (this.known.has(peer) || this.gatewayMembers.has(peer)) { this.hintedAt.delete(peer); continue; }
      if (now - at >= this.timing.greetMs) { this.presence.delete(peer); this.hintedAt.delete(peer); this.lastContact.delete(peer); this.outbox.delete(peer); }
    }
    for (const peer of [...this.known, ...this.gatewayMembers]) {
      const link = this.links.get(peer);
      if (this.presence.has(peer) || link?.connected) { this.lastContact.set(peer, now); continue; }
      if (now - (this.lastContact.get(peer) ?? now) < this.timing.departGraceMs) continue;
      if (this.gatewayMembers.has(peer)) { this.gatewayMembers.delete(peer); this.caps.delete(peer); this.lastContact.delete(peer); this.emit('gateway', { id: peer, available: false }); }
      else this.dropPeer(peer, 'gone');
    }
    for (const [peer, list] of this.outbox) {
      const live = list.filter(e => e.until > now);
      if (live.length) this.outbox.set(peer, live); else this.outbox.delete(peer);
    }
    for (const [key, offer] of this.bridgeOffers) if (now - offer.at > 30000) this.bridgeOffers.delete(key);
    // An accepted forwarder that never activated must not block other forwarders forever.
    for (const [key, bridge] of [...this.bridges]) if (bridge.state === 'accepted' && now - bridge.requestedAt >= 30000 && !this.links.get(bridge.peer)?.connected) {
      this.bridges.delete(key);
      if (bridge.via && this.known.has(bridge.via)) this.signalTo(bridge.via, { kind: 'bridge-release', a: key.split('|')[0], b: key.split('|')[1] }).catch(() => {});
      this.rescueLink(bridge.peer);
    }
    for (const [key, pending] of this.bridgePending) if (now - pending.at >= 30000) {
      this.bridgePending.delete(key);
      for (const to of [pending.a, pending.b]) this.signalTo(to, {kind: 'bridge-fail', a: pending.a, b: pending.b});
    }
  }

  ensureLink(peer, forOffer = false) {
    clearTimeout(this.pendingLinks.get(peer)); this.pendingLinks.delete(peer);
    if (this.closed || this.blocked(peer) || !this.known.has(peer)) return null;
    let link = this.links.get(peer);
    if (!link) {
      try { link = new PeerLink(this, peer, { forOffer }); }
      catch (error) { this.log('peer-link-error', {peer, message: error.message}); this.emit('path', {peer, kind: 'unreachable'}); return null; }
      this.links.set(peer, link);
      for (const c of this.early.get(peer) ?? []) link.enqueue(() => link.onCandidate({ candidate: c }));
      this.early.delete(peer);
    }
    return link;
  }

  dropPeer(peer, reason) {
    if (!this.known.has(peer) && !this.links.has(peer)) return;
    clearTimeout(this.pendingLinks.get(peer)); this.pendingLinks.delete(peer);
    this.links.get(peer)?.close(); this.links.delete(peer);
    this.known.delete(peer); this.hintedAt.delete(peer); this.caps.delete(peer); this.presence.delete(peer); this.early.delete(peer); this.outbox.delete(peer);
    this.sendProgress.delete(peer); this.meshBudget.delete(peer); this.appBudget.delete(peer); this.videoQuality.delete(peer);
    this.lastContact.delete(peer); this.gatewayCreds.delete(`${this.tag8}:${peer}`);
    this.remoteAudio.delete(peer);
    // A softly departed ('gone') peer may return with the same id: its replay window and local
    // mute survive. Terminal departures ('bye', 'dropped', 'rekey') clear both.
    if (reason !== 'gone') { this.sequences.delete(peer); this.mutedPeers.delete(peer); }
    this.departed.set(peer, { at: Date.now(), reason });
    if (this.departed.size > 256) this.departed.delete(this.departed.keys().next().value);
    for (const [key, b] of [...this.bridgePending]) if (b.a === peer || b.b === peer) {
      this.bridgePending.delete(key);
      const other = b.a === peer ? b.b : b.a;
      if (this.known.has(other)) this.signalTo(other, { kind: 'bridge-fail', a: b.a, b: b.b }).catch(() => {});
    }
    for (const [key, b] of [...this.relaying]) if (b.a === peer || b.b === peer) this.endRelayBridge(key, 'peer-left');
    for (const [key, b] of [...this.bridges]) if (b.via === peer || b.peer === peer) { this.bridges.delete(key); if (b.via === peer) this.rescueLink(b.peer); }
    for (const link of this.links.values()) for (const [stream, origin] of [...link.forwardMap]) if (origin === peer) link.forwardMap.delete(stream);
    this.emit('peer-left', { id: peer, reason });
    this.scheduleCapsBroadcast();
  }

  // ---------- signalling transport ----------
  async signal(link, payload) { return this.signalTo(link.id, payload); }

  async signalTo(peer, payload) {
    if (this.closed && payload.kind !== 'bye') return false;
    const crypto = this.crypto;
    const box = await seal(crypto, this.id, peer, { ...payload, n: ++this.sendCounter });
    if (crypto !== this.crypto || this.closed && payload.kind !== 'bye') return false;
    this.counters.sent++;
    if (this.route(peer, box)) return true;
    // No route right now (gate reconnecting, peer not yet present): keep it briefly.
    const list = this.outbox.get(peer) ?? [];
    list.push({ box, until: Date.now() + this.timing.outboxMs });
    if (list.length > this.limits.outboxPerPeer) list.shift();
    this.outbox.set(peer, list); this.counters.queued++;
    return false;
  }

  flushOutbox(peer) {
    const list = this.outbox.get(peer);
    if (!list?.length) return;
    this.outbox.delete(peer);
    const now = Date.now(), left = [];
    for (const entry of list) if (entry.until > now && !this.route(peer, entry.box)) left.push(entry);
    if (left.length) this.outbox.set(peer, left);
  }

  route(to, box) {
    const link = this.links.get(to);
    const frame = JSON.stringify({ t: 'env', from: this.id, to, box });
    // A data channel can still read "open" for tens of seconds after its connection died, so
    // it is trusted alone only while the link is connected; otherwise gates carry the
    // envelope too (receivers drop duplicates).
    if (link?.connected && link.control.readyState === 'open') {
      try { link.control.send(frame); this.counters.viaMesh++; return true; } catch {}
    }
    let sent = false;
    if (link?.control.readyState === 'open') { try { link.control.send(frame); sent = true; } catch {} }
    for (const gate of this.presence.get(to) ?? []) sent = gate.send(to, box) || sent;
    if (sent) { this.counters.viaGate++; return true; }
    // Introduction through the mesh: a neighbour that reports a live link to `to` forwards once.
    for (const l of this.links.values()) {
      if (l.id !== to && l.connected && l.control.readyState === 'open' && this.caps.get(l.id)?.peers.includes(to)) {
        l.control.send(JSON.stringify({ t: 'env', from: this.id, to, box, hop: 1 })); this.counters.viaIntroducer++; return true;
      }
    }
    this.counters.undeliverable++;
    return false;
  }

  onControlOpen(link) { this.sendCaps(link.id); this.flushOutbox(link.id); this.scheduleCapsBroadcast(); }

  onControlMessage(link, data) {
    if (typeof data !== 'string' || data.length > 70000) return;
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m?.t !== 'env' || typeof m.box !== 'string' || !PEER_ID.test(m.from ?? '') || !PEER_ID.test(m.to ?? '')) return;
    if (m.to === this.id) { if (m.from === link.id || m.hop === 2) this.receiveBox(m.from, m.box, 'mesh'); return; }
    if (m.hop !== 1 || m.from !== link.id) return;
    const minute = Math.floor(Date.now() / 60000), budget = this.meshBudget.get(link.id);
    const used = budget?.minute === minute ? budget.used : 0;
    if (used >= this.limits.meshForwardPerMinute) return;
    this.meshBudget.set(link.id, { minute, used: used + 1 });
    const target = this.links.get(m.to);
    if (target?.connected && target.control.readyState === 'open') { target.control.send(JSON.stringify({ t: 'env', from: m.from, to: m.to, box: m.box, hop: 2 })); this.counters.meshForwarded++; }
  }

  acceptSequence(from, n) {
    let s = this.sequences.get(from);
    if (!s) {
      if (this.sequences.size > this.limits.maxHints * 4) this.sequences.delete(this.sequences.keys().next().value);
      s = { max: 0, seen: new Set() }; this.sequences.set(from, s);
    }
    if (n <= s.max - 1024 || s.seen.has(n)) return false;
    s.seen.add(n); if (n > s.max) s.max = n;
    if (s.seen.size > 2048) for (const v of s.seen) if (v <= s.max - 1024) s.seen.delete(v);
    return true;
  }

  async receiveBox(from, box, via, route) {
    if (this.closed || this.blocked(from)) return;
    const crypto = this.crypto;
    const p = await open(crypto, from, this.id, box);
    if (crypto !== this.crypto || this.closed || this.blocked(from)) return;
    if (!p || !Number.isSafeInteger(p.n) || p.n < 1 || !KINDS.has(p.kind)) { this.counters.rejected++; return; }
    if (!this.acceptSequence(from, p.n)) { this.counters.duplicates++; return; }
    this.counters.received++;
    this.lastContact.set(from, Date.now());
    // An authenticated envelope through a gate proves the sender is reachable there.
    if (via && typeof via === 'object') { via.bind?.(from, route); this.hint(from, via); }
    try { this.dispatch(from, p); } catch (error) { this.count('linkErrors', error); }
  }

  dispatch(from, p) {
    if (isGatewayMember(from)) {
      if (p.kind === 'bye') { this.gatewayMembers.delete(from); this.caps.delete(from); this.emit('gateway', { id: from, available: false }); return; }
      if (p.kind === 'caps' && p.caps?.role === 'gateway' && (this.gatewayMembers.has(from) || this.gatewayMembers.size < this.limits.maxGatewayMembers)) {
        const fresh = !this.gatewayMembers.has(from);
        this.gatewayMembers.add(from); this.updateCaps(from, p.caps);
        if (fresh) { this.emit('gateway', { id: from, available: !!this.caps.get(from)?.gateway }); this.sendCaps(from); }
      }
      return;
    }
    if (p.kind === 'bye') return this.dropPeer(from, 'bye');
    if (!this.admit(from)) return;
    switch (p.kind) {
      case 'caps':
        this.updateCaps(from, p.caps);
        if (this.pendingLinks.has(from) && this.id < from) this.ensureLink(from);
        return;
      case 'description': {
        if (!p.description || !['offer', 'answer'].includes(p.description.type) || typeof p.description.sdp !== 'string' || p.description.sdp.length > 131072) return;
        const link = this.ensureLink(from, p.description.type === 'offer');
        link?.enqueue(() => link.onDescription(p));
        return;
      }
      case 'candidate': {
        if (typeof p.candidate?.candidate !== 'string' || p.candidate.candidate.length > 1024) return;
        const link = this.links.get(from);
        if (link) link.enqueue(() => link.onCandidate(p));
        else { const list = this.early.get(from) ?? []; list.push(p.candidate); if (list.length > 64) list.shift(); this.early.set(from, list); }
        return;
      }
      case 'app': {
        // Untrusted application data from a room member: bounded, rate-limited, never interpreted here.
        let size; try { size = JSON.stringify(p.data ?? null).length; } catch { size = Infinity; }
        if (p.data === undefined || size > APP_MESSAGE_BYTES || !this.takeAppToken(from)) { this.counters.appDropped++; return; }
        this.counters.appReceived++;
        this.emit('message', { from, data: p.data });
        return;
      }
      case 'restart-request': {
        // The polite side saw its media stall; only the impolite side restarts (no glare).
        const link = this.links.get(from);
        if (link && !link.polite) link.enqueue(() => link.restart());
        return;
      }
      case 'video-quality':
        this.receiveVideoQuality(from, p);
        return;
      default: return this.onBridgeMessage(from, p);
    }
  }

  // ---------- capabilities ----------
  async gatewayCredsFor(label) {
    const g = this.ownGateway; if (!g) return null;
    const name = `${this.tag8}:${label}`;
    const cached = this.gatewayCreds.get(name);
    if (cached && cached.expiry * 1000 - Date.now() > g.ttlSeconds * 500) return cached;
    const epoch = this.crypto, tag = this.tag;
    let minted;
    try { minted = await g.credentialsFor(tag, label); }
    catch (error) { this.log('gateway-credentials-unavailable', {message: error.message}); return null; }
    if (this.closed || epoch !== this.crypto || !minted || typeof minted.username !== 'string' || typeof minted.credential !== 'string') return null;
    const [rawExpiry, scope, owner, extra] = minted.username.split(':');
    const expiry = Number(rawExpiry);
    if (extra !== undefined || scope !== this.tag8 || owner !== label || !Number.isSafeInteger(expiry) || expiry * 1000 <= Date.now()) return null;
    const creds = {...minted, expiry};
    this.gatewayCreds.set(name, creds);
    if (this.gatewayCreds.size > this.limits.maxHints * 2) this.gatewayCreds.delete(this.gatewayCreds.keys().next().value);
    return creds;
  }

  async capsFor(peer) {
    let gateway = null;
    // Gateway credentials go only to admitted members, never to an unauthenticated hint.
    if (this.ownGateway && (this.known.has(peer) || this.gatewayMembers.has(peer))) {
      const c = await this.gatewayCredsFor(peer);
      if (c) gateway = { urls: this.ownGateway.urls, username: c.username, credential: c.credential, external: this.ownGateway.external, internal: this.ownGateway.internal };
    }
    const caps = { v: 1, forward: this.forward, peers: [...this.links.values()].filter(l => l.connected && l.control.readyState === 'open').map(l => l.id), gateway };
    if (this.classifyNatEnabled && this.nat) caps.nat = { type: this.nat.type, delta: this.nat.delta };
    return caps;
  }

  async sendCaps(peer) {
    const epoch = this.crypto, caps = await this.capsFor(peer);
    if (!this.closed && epoch === this.crypto) return this.signalTo(peer, { kind: 'caps', caps });
  }

  scheduleCapsBroadcast() {
    if (this.capsTimer || this.closed) return;
    this.capsTimer = setTimeout(() => { this.capsTimer = null; for (const peer of this.known) this.sendCaps(peer); }, 250);
  }

  updateCaps(from, caps) {
    if (!caps || typeof caps !== 'object') return;
    const before = this.caps.get(from);
    const clean = { role: caps.role === 'gateway' && isGatewayMember(from) ? 'gateway' : 'peer', forward: caps.forward === true,
      peers: (Array.isArray(caps.peers) ? caps.peers : []).filter(p => typeof p === 'string' && PEER_ID.test(p)).slice(0, 32),
      gateway: cleanGateway(caps.gateway) };
    if (this.classifyNatEnabled) { const nat = cleanNat(caps.nat); if (nat) clean.nat = nat; }
    this.caps.set(from, clean);
    // Peers a member reports are hints too: greet them through the mesh.
    for (const p of clean.peers) if (p !== this.id && !this.known.has(p)) this.hint(p, null);
    if (clean.gateway && !sameGateway(before?.gateway, clean.gateway)) {
      // An endpoint's own gateway joins that pair's servers directly; for pairs that already
      // escalated, a new session gateway is tried right away instead of at the next retry.
      for (const link of this.links.values()) {
        if (link.connected) continue;
        if (link.id === from) link.refreshServers();
        else if (link.phase >= PHASE.SESSION) this.rescueLink(link.id);
      }
    }
  }

  // Opt-in (classifyNat): one ICE generation's srflx evidence from any link. Only a conclusive
  // verdict is kept; a change is announced to peers in caps.
  observeNat(sample, complete) {
    try {
      const servers = [...this.stunUrls].slice(0, 3).filter(url => /^stun:/i.test(url)).length;
      const nat = classifyNat({ ...sample, servers, complete });
      if (nat.type === 'unknown') return;
      this.count('natSamples');
      if (this.nat?.type === nat.type && this.nat.delta === nat.delta) return;
      this.nat = nat;
      this.log('nat', { ...nat });
      this.scheduleCapsBroadcast();
    } catch (error) { this.count('natErrors', error); }
  }

  async setGateway(gateway) {
    this.ownGateway = cleanOwnGateway(gateway); this.gatewayCreds.clear();
    if (this.ownGateway) await this.gatewayCredsFor('self');
    this.scheduleCapsBroadcast();
    for (const link of this.links.values()) if (!link.connected) link.refreshServers();
  }

  iceServersFor(link) {
    const servers = [];
    const stun = [...this.stunUrls].slice(0, 3);
    if (stun.length) servers.push({ urls: stun });
    const add = g => { if (g && servers.length < 6 && !servers.some(s => s.urls[0] === g.urls[0])) servers.push({ urls: g.urls, username: g.username, credential: g.credential }); };
    const self = this.gatewayCreds.get(`${this.tag8}:self`);
    if (this.ownGateway && self) add({ urls: this.ownGateway.internalUrls.length ? this.ownGateway.internalUrls : this.ownGateway.urls, username: self.username, credential: self.credential });
    add(this.caps.get(link.id)?.gateway);
    for (const id of link.extraGateways) if (id !== link.id) add(this.caps.get(id)?.gateway);
    // The application's TURN relay joins only links that reached that rung of the ladder.
    if (link.useTurn && this.turnServers) for (const s of this.turnServers) servers.push({ urls: [...s.urls], username: s.username, credential: s.credential });
    return compatibleServers(servers, this.RTCPeerConnection);
  }

  sessionGatewayIds(link) {
    // Gateways of connected participants and of the session's gateway members (host node).
    return [...this.caps.entries()].filter(([id, c]) => id !== link.id && c.gateway &&
      (this.gatewayMembers.has(id) || this.links.get(id)?.connected)).map(([id]) => id);
  }

  // ---------- path ladder ----------
  escalate(link) {
    if (this.closed || link.closed || link.connected) return;
    this.counters.escalations++;
    // Gateways of other session members not yet tried for this pair come first — also for a
    // bridged pair: a relayed path keeps media end-to-end encrypted and avoids re-encoding.
    const fresh = this.sessionGatewayIds(link).filter(id => !link.extraGateways.has(id)).slice(0, 2);
    if (fresh.length) {
      for (const id of fresh) link.extraGateways.add(id);
      if (link.phase < PHASE.SESSION) link.setPhase(PHASE.SESSION); else link.armWatchdog(true);
      link.applyServers(true);
      return;
    }
    if (link.phase < PHASE.BRIDGED && this.bridgeCandidates(link).length) {
      link.setPhase(PHASE.BRIDGED);
      this.requestBridge(link);
      return;
    }
    if (link.phase === PHASE.BRIDGED && !this.bridges.get(pairKey(this.id, link.id))?.via) this.requestBridge(link);
    if ((this.portPredictionEnabled || this.turnServers) && this.bridges.get(pairKey(this.id, link.id))?.state !== 'active' && this.optInRung(link)) return;
    // Nothing better exists right now: keep retrying slowly. New peers, gateways or a network
    // change may open a path later; every retry is a cheap ICE restart, through a server relay only
    // when the application configured its own (`turn`).
    if (link.phase === PHASE.ENDPOINT) link.phase = PHASE.SESSION;
    link.path = this.bridges.get(pairKey(this.id, link.id))?.state === 'active' ? link.path : { kind: 'unreachable' };
    this.emitPath(link);
    link.grace = false;
    link.requestRestart();
    // Exponential backoff: a pair that stays unreachable costs the gate almost nothing.
    const delay = Math.min(this.timing.bridgedRetryMs * 2 ** Math.min(link.retries++, 4), this.timing.maxRetryMs);
    clearTimeout(link.watchdog);
    link.watchdog = setTimeout(() => { link.watchdog = null; link.enqueue(() => link.checkProgress()); }, delay);
  }

  // Opt-in rungs between the last route inside the session and `unreachable`: port prediction when
  // the NATs allocate predictably, then the application's own TURN relay. Each is tried once per
  // link; any failure falls through to `unreachable` exactly as without them.
  optInRung(link) {
    try {
      if (this.portPredictionEnabled && !link.predictTried && this.predictionPair(link)) {
        link.predictTried = true; link.predicting = true;
        this.count('predictAttempts');
        this.retryRung(link, this.timing.predictMs ?? 10000);
        return true;
      }
      if (this.turnServers && !link.turnTried) {
        link.turnTried = true; link.useTurn = true;
        try { link.applyServers(false); } catch (error) { link.useTurn = false; this.count('turnErrors', error); return false; }
        this.count('turnAttempts');
        this.retryRung(link, this.timing.turnMs ?? 10000);
        return true;
      }
    } catch (error) { this.count('rungErrors', error); }
    return false;
  }

  // One side's NAT allocates ports in order and the other's either does too or keeps one mapping.
  predictionPair(link) {
    const local = this.nat?.type, remote = this.caps.get(link.id)?.nat?.type;
    return local === 'sequential' && (remote === 'sequential' || remote === 'eim') || remote === 'sequential' && local === 'eim';
  }

  // A fresh ICE generation under the usual restart rules, then the next escalation after `ms`.
  retryRung(link, ms) {
    if (link.phase === PHASE.ENDPOINT) link.phase = PHASE.SESSION;
    link.grace = false;
    link.requestRestart();
    clearTimeout(link.watchdog);
    link.watchdog = setTimeout(() => { link.watchdog = null; link.enqueue(() => link.checkProgress()); }, ms);
  }

  /** Replace the application TURN servers (e.g. fresh credentials); links using them pick them up at their next restart. */
  setTurn(servers) {
    if (servers !== null && !validTurnServers(servers)) throw new TypeError('Invalid application TURN servers');
    this.turnServers = normalizeTurnServers(servers);
    for (const link of this.links.values()) if (link.useTurn) { try { link.applyServers(false); } catch (error) { this.count('turnErrors', error); } }
  }

  // The application's TURN relay stays the last resort after it connected a pair. The pair keeps
  // looking for a cheaper route: after turnUpgradeMs, then less often (up to maxRetryMs), and within
  // seconds when a gateway it could use appears. The relay stays configured during each try, so the
  // call keeps its route when nothing better exists. Once a cheaper route has held for two media
  // checks, the relay leaves the pair's servers and a fresh ICE generation releases its allocations;
  // if that route fails later, the ladder runs again with TURN last. Only the impolite side
  // restarts: the polite side drops the relay from its servers, for the next generation it answers.
  // Without application TURN servers (never set, or removed by setTurn) nothing here restarts a link.
  planTurn(link) {
    if (link.closed || !link.connected || !this.turnServers) return;
    if (this.onTurn(link)) {
      link.turnHeld = true; link.offTurnSince = null;
      if (link.polite) return;
      const routes = this.upgradeRoutes(link), known = link.turnRoutes ?? routes;
      link.turnRoutes = routes;
      const fresh = routes.some(id => !known.includes(id));
      if (link.turnTimer && !fresh) return;
      clearTimeout(link.turnTimer);
      const delay = fresh ? 1000 : Math.min((this.timing.turnUpgradeMs ?? 60000) * 2 ** Math.min(link.turnProbes ?? 0, 4), this.timing.maxRetryMs);
      link.turnTimer = setTimeout(() => { link.turnTimer = null; this.probeTurn(link); }, delay);
      return;
    }
    clearTimeout(link.turnTimer); link.turnTimer = null; link.turnRoutes = undefined;
    if (!link.turnHeld && !link.useTurn) return;
    link.offTurnSince ??= Date.now();
    if (link.polite) this.releaseTurn(link, false);
    else if (Date.now() - link.offTurnSince >= 2 * this.timing.mediaWatchMs) this.releaseTurn(link, true);
  }

  // Carried by the application's relay: attributed to it, or an unattributed relay on a pair that
  // reached the TURN rung (a TURN URL with a host name hides the remote end's relay address).
  onTurn(link) {
    const { kind, via } = link.path;
    return !!this.turnServers && kind === 'relay' && (via === 'turn' || via === 'unknown' && !!link.useTurn);
  }

  // Relays this pair could use instead: our own gateway, the peer's, and other session members'.
  upgradeRoutes(link) {
    return [this.ownGateway ? this.id : null, this.caps.get(link.id)?.gateway ? link.id : null, ...this.sessionGatewayIds(link)].filter(Boolean);
  }

  probeTurn(link) {
    if (this.closed || link.closed || !link.connected || link.polite || !this.onTurn(link)) return;
    link.turnProbes = (link.turnProbes ?? 0) + 1;
    this.count('turnProbes');
    for (const id of this.sessionGatewayIds(link).filter(id => !link.extraGateways.has(id)).slice(0, 2)) link.extraGateways.add(id);
    try { link.applyServers(false); } catch (error) { this.count('turnErrors', error); return; }
    link.requestRestart();
  }

  releaseTurn(link, restart) {
    link.useTurn = false; link.turnTried = false; link.turnHeld = false; link.offTurnSince = null;
    this.count('turnReleases');
    try { link.applyServers(false); } catch (error) { this.count('turnErrors', error); return; }
    if (restart) link.requestRestart();
  }

  rescueLink(peer) {
    const link = this.links.get(peer);
    if (!link || link.connected || link.closed) return;
    link.grace = false; link.enqueue(() => link.checkProgress());
  }

  emitPath(link) {
    const bridge = this.bridges.get(pairKey(this.id, link.id));
    if (!link.connected && bridge?.state === 'active') link.path = { kind: 'bridged', via: bridge.via };
    else if (!link.connected && link.path.kind !== 'unreachable') link.path = { kind: 'connecting', phase: link.phase };
    this.emit('path', { peer: link.id, ...link.path });
  }

  // The selected pair can be missing from stats right at "connected"; retry briefly. The media
  // watch also refreshes every connected link, which catches later route upgrades.
  async updatePath(link, report, attempt = 0) {
    const info = await link.classify(report).catch(() => null);
    if (link.closed || !link.connected) return;
    if (!info) { if (attempt < 10) setTimeout(() => this.updatePath(link, undefined, attempt + 1), 300); return; }
    let kind = 'direct', via = null;
    // A local peer-reflexive candidate learned through a TURN allocation still rides the relay.
    if (info.local === 'relay' || info.relayProtocol || info.remote === 'relay') {
      via = this.gatewayOwner(info);
      kind = via === this.id || via === link.id ? 'gateway' : 'relay';
    }
    const changed = link.path.kind !== kind || link.path.via !== via;
    link.path = { kind, via, ...info };
    if (changed) this.emit('path', { peer: link.id, ...link.path });
    this.planTurn(link);
  }

  gatewayOwner(info) {
    const owns = (g, address, url) => g && (address && g.external.includes(address) || url && (g.urls.includes(url) || g.internalUrls?.includes(url)) ||
      address && g.internal === address);
    const candidates = [[this.id, this.ownGateway], ...[...this.caps].map(([id, c]) => [id, c.gateway])];
    for (const [id, g] of candidates) {
      if ((info.local === 'relay' || info.relayProtocol) && owns(g, info.localAddress, info.relayUrl)) return id;
      if (info.remote === 'relay' && owns(g, info.remoteAddress, null)) return id;
    }
    if (this.turnServers && this.turnOwns(info)) return 'turn';
    return 'unknown';
  }

  turnOwns(info) {
    const strip = url => String(url ?? '').replace(/\?transport=(udp|tcp)$/, '');
    const urls = this.turnServers.flatMap(s => s.urls);
    if ((info.local === 'relay' || info.relayProtocol) && info.relayUrl && urls.some(url => strip(url) === strip(info.relayUrl))) return true;
    const hosts = urls.map(url => /^turns?:(\[[^\]]+\]|[^:?]+)/.exec(url)?.[1].replace(/^\[|\]$/g, ''));
    return info.remote === 'relay' && !!info.remoteAddress && hosts.includes(info.remoteAddress);
  }

  onLinkConnected(link) {
    this.lastContact.set(link.id, Date.now());
    this.scheduleCapsBroadcast();
    this.applyEncodingLimits(link);
    if (this.adaptiveVideoEnabled) {
      const quality = this.videoQualityState(link.id);
      quality.previous = null; quality.sendBad = quality.sendGood = quality.receiveBad = quality.receiveGood = 0;
      this.emit('video-quality', {peer: link.id, direction: 'send', level: this.effectiveVideoLevel(quality), reason: 'monitoring'});
      this.emit('video-quality', {peer: link.id, direction: 'receive', level: quality.receiveLevel, reason: 'monitoring'});
      if (quality.receiveLevel !== 'normal') this.signalTo(link.id, {kind: 'video-quality', level: quality.receiveLevel}).catch(() => {});
    }
    this.flushOutbox(link.id);
    const key = pairKey(this.id, link.id), bridge = this.bridges.get(key);
    if (bridge) { this.bridges.delete(key); if (bridge.via) this.signalTo(bridge.via, { kind: 'bridge-release', a: this.id, b: link.id }); }
    if (link.phase === PHASE.BRIDGED) link.phase = PHASE.SESSION;
    link.retries = 0;
    this.emit('link', { peer: link.id, connected: true });
  }

  onLinkDown(link) {
    this.scheduleCapsBroadcast();
    for (const [key, b] of [...this.relaying]) if (b.a === link.id || b.b === link.id) this.endRelayBridge(key, 'link-down');
    for (const [key, b] of [...this.bridges]) if (b.via === link.id) { this.bridges.delete(key); this.rescueLink(b.peer); }
    this.emit('link', { peer: link.id, connected: false });
  }

  // ---------- participant bridging (last resort, still inside the session) ----------
  bridgeCandidates(link) {
    return [...this.links.values()].filter(l => l !== link && l.connected && this.caps.get(l.id)?.forward && this.caps.get(l.id)?.peers.includes(link.id));
  }

  requestBridge(link) {
    const key = pairKey(this.id, link.id);
    const existing = this.bridges.get(key);
    if (existing?.via) return;
    // Only the lower id coordinates, so both endpoints never pick different forwarders; the
    // other endpoint takes over if nothing happened within bridgeWaitMs.
    if (this.id > link.id && (!existing || Date.now() - existing.requestedAt < this.timing.bridgeWaitMs)) {
      if (!existing) this.bridges.set(key, { peer: link.id, via: null, state: 'waiting', requestedAt: Date.now() });
      setTimeout(() => { if (!this.bridges.get(key)?.via && !link.connected && !link.closed) this.requestBridge(link); }, this.timing.bridgeWaitMs + 50);
      return;
    }
    this.bridges.set(key, { peer: link.id, via: null, state: 'requested', requestedAt: Date.now() });
    for (const candidate of this.bridgeCandidates(link)) this.signalTo(candidate.id, { kind: 'bridge-request', a: this.id, b: link.id });
  }

  canForward(a, b, key) {
    const la = this.links.get(a), lb = this.links.get(b);
    return this.forward && !!la?.connected && !!lb?.connected && (this.relaying.has(key) || this.bridgePending.has(key) || this.relaying.size + this.bridgePending.size < this.limits.maxBridges);
  }

  async onBridgeMessage(from, p) {
    const a = p.a, b = p.b;
    if (!PEER_ID.test(a ?? '') || !PEER_ID.test(b ?? '') || a === b) return;
    const key = pairKey(a, b);
    switch (p.kind) {
      case 'bridge-request': {
        if (from !== a || !this.canForward(a, b, key)) return;
        this.bridgeOffers.set(key, { a, b, at: Date.now() });
        return this.signalTo(a, { kind: 'bridge-offer', a, b });
      }
      case 'bridge-offer': {
        const bridge = this.bridges.get(key);
        const link = this.links.get(b);
        if (a !== this.id || !bridge || bridge.via || !link || link.connected || !this.bridgeCandidates(link).some(l => l.id === from)) return;
        bridge.via = from; bridge.state = 'accepted';
        return this.signalTo(from, { kind: 'bridge-accept', a, b });
      }
      case 'bridge-accept': {
        // Only an accept for an offer we made, from the endpoint we made it to.
        const offer = this.bridgeOffers.get(key);
        if (from !== a || !offer || offer.a !== a || Date.now() - offer.at >= 30000 || !this.canForward(a, b, key)) return;
        this.bridgeOffers.delete(key);
        return this.startRelayBridge(key, a, b);
      }
      case 'bridge-confirm': {
        if (b !== this.id) return;
        const link = this.links.get(a), existing = this.bridges.get(key);
        if (!link || link.connected || existing?.via && existing.via !== from || !this.bridgeCandidates(link).some(l => l.id === from)) {
          return this.signalTo(from, {kind: 'bridge-release', a, b});
        }
        this.bridges.set(key, {peer: a, via: from, state: 'accepted', requestedAt: Date.now()});
        return this.signalTo(from, {kind: 'bridge-ready', a, b});
      }
      case 'bridge-ready': {
        const pending = this.bridgePending.get(key);
        if (!pending || pending.a !== a || pending.b !== b || from !== b || Date.now() - pending.at >= 30000 || !this.canForward(a, b, key)) return;
        this.bridgePending.delete(key);
        return this.activateRelayBridge(key, a, b);
      }
      case 'bridge-active': {
        if (a !== this.id && b !== this.id) return;
        const peer = a === this.id ? b : a;
        const link = this.links.get(peer), bridge = this.bridges.get(key);
        // A second forwarder (both endpoints asked) or a stale one is released at once.
        if (!link || link.connected || !bridge || bridge.via !== from || !['accepted', 'active'].includes(bridge.state) || !this.bridgeCandidates(link).some(l => l.id === from)) { this.signalTo(from, { kind: 'bridge-release', a, b }); return; }
        this.bridges.set(key, { peer, via: from, state: 'active', requestedAt: bridge?.requestedAt ?? Date.now() });
        this.counters.bridgesUsed++;
        if (link.phase < PHASE.BRIDGED) link.phase = PHASE.BRIDGED;
        link.path = { kind: 'bridged', via: from };
        this.emit('path', { peer, kind: 'bridged', via: from });
        return;
      }
      case 'bridge-release': {
        const pending = this.bridgePending.get(key);
        if (pending && (from === pending.a || from === pending.b)) {
          this.bridgePending.delete(key);
          this.signalTo(from === pending.a ? pending.b : pending.a, {kind: 'bridge-fail', a, b});
        }
        const bridge = this.relaying.get(key);
        if (bridge && (from === bridge.a || from === bridge.b)) this.endRelayBridge(key, 'released');
        return;
      }
      case 'bridge-fail': {
        const bridge = this.bridges.get(key);
        if (bridge?.via === from) { this.bridges.delete(key); this.rescueLink(bridge.peer); }
        return;
      }
      case 'forward-map': {
        // Accept a forwarded stream only for an origin we cannot reach ourselves, and only from
        // the forwarder of that pair once one is established.
        const link = this.links.get(from), origin = p.origin;
        if (!link || !PEER_ID.test(origin ?? '') || origin === from || origin === this.id || this.links.get(origin)?.connected) return;
        const bridge = this.bridges.get(pairKey(this.id, origin));
        if (bridge?.state !== 'active' || bridge.via !== from) return;
        if (typeof p.stream !== 'string' || p.stream.length > 128 || link.forwardMap.size >= 16) return;
        link.forwardMap.set(p.stream, origin);
        return;
      }
      case 'forward-unmap': {
        const link = this.links.get(from);
        if (!link) return;
        for (const [stream, origin] of [...link.forwardMap]) if (origin === p.origin) {
          link.forwardMap.delete(stream);
          this.emit('track-ended', { peer: origin, via: from, stream });
        }
        return;
      }
    }
  }

  async startRelayBridge(key, a, b) {
    if (!this.canForward(a, b, key)) return;
    this.bridgePending.set(key, {a, b, at: Date.now()});
    await this.signalTo(b, {kind: 'bridge-confirm', a, b});
  }

  async activateRelayBridge(key, a, b) {
    const la = this.links.get(a), lb = this.links.get(b);
    if (!la?.connected || !lb?.connected) return this.signalTo(a, { kind: 'bridge-fail', a, b });
    if (!this.relaying.has(key)) { this.relaying.set(key, { a, b }); this.counters.bridgesServed++; }
    const bridge = this.relaying.get(key);
    const current = () => !this.closed && this.relaying.get(key) === bridge && la.connected && lb.connected;
    // Establish the authenticated forwarding relationship before sending attribution maps.
    await this.signalTo(a, { kind: 'bridge-active', a, b });
    if (!current()) return;
    await this.signalTo(b, { kind: 'bridge-active', a, b });
    if (!current()) return;
    await this.forwardTracks(la, lb);
    if (!current()) return;
    await this.forwardTracks(lb, la);
  }

  async forwardTracks(fromLink, toLink) {
    const key = pairKey(fromLink.id, toLink.id), bridge = this.relaying.get(key);
    if (!bridge) return;
    const tracks = fromLink.ownTracks();
    const entry = toLink.forwardSenders.get(fromLink.id);
    const stream = entry?.stream ?? new MediaStream();
    if (!entry) toLink.forwardSenders.set(fromLink.id, { stream, senders: new Map() });
    // The receiver must learn the stream's origin before the renegotiation that carries it.
    await this.signalTo(toLink.id, { kind: 'forward-map', a: fromLink.id, b: toLink.id, origin: fromLink.id, stream: stream.id });
    if (!this.closed && this.relaying.get(key) === bridge && fromLink.connected && toLink.connected && tracks.length) toLink.addForward(fromLink.id, tracks);
  }

  endRelayBridge(key, reason) {
    const bridge = this.relaying.get(key);
    if (!bridge) return;
    this.relaying.delete(key);
    for (const [from, to] of [[bridge.a, bridge.b], [bridge.b, bridge.a]]) {
      const link = this.links.get(to);
      if (!link) continue;
      link.removeForward(from);
      this.signalTo(to, { kind: 'forward-unmap', a: bridge.a, b: bridge.b, origin: from });
      if (reason !== 'released') this.signalTo(to, { kind: 'bridge-fail', a: bridge.a, b: bridge.b });
    }
  }

  // ---------- media ----------
  async setMedia(media) {
    if (media && typeof media.getTracks === 'function') { this.localStream = media; this.ownsMedia = false; return; }
    this.localStream = new MediaStream(); this.ownsMedia = true;
    if (media?.audio) await this.setMicrophone(true);
    if (media?.video) await this.setCamera(true);
  }

  attachLocalMedia(link) {
    for (const track of this.localStream?.getTracks() ?? []) {
      if (!link.senders.has(track.kind)) link.senders.set(track.kind, link.pc.addTrack(track, this.localStream));
    }
  }

  async #enableTrack(kind, enabled, constraints) {
    if (this.closed) return;
    let track = this.localStream.getTracks().find(t => t.kind === kind);
    if (!enabled) {
      if (!track) return;
      if (kind === 'audio') { track.enabled = false; return; }   // muted mic keeps its slot, no renegotiation
      track.stop(); this.localStream.removeTrack(track);
      for (const link of this.links.values()) link.senders.get(kind)?.replaceTrack(null);
      // Camera-off is an explicit user choice. Do not leave an automatic pause latched
      // when the user turns the camera back on later.
      if (kind === 'video' && this.adaptiveVideoEnabled) {
        for (const [peer, state] of this.videoQuality) {
          state.sendLevel = 'normal'; state.sendBad = state.sendGood = 0; state.sendProbe = false;
          this.setVideoQuality(peer, 'send', this.effectiveVideoLevel(state), 'camera-off');
        }
      }
      return;
    }
    if (track) { track.enabled = true; return; }
    const captured = await this.getUserMedia({ [kind]: this.constraintsFor(kind, constraints) });
    if (this.closed) { for (const t of captured.getTracks()) t.stop(); return; }
    track = captured.getTracks().find(t => t.kind === kind);
    if (!track) return;
    this.localStream.addTrack(track);
    for (const link of this.links.values()) {
      const sender = link.senders.get(kind);
      if (sender) await sender.replaceTrack(track);
      else link.senders.set(kind, link.pc.addTrack(track, this.localStream));
      await this.applyEncodingLimits(link);
    }
  }

  setMicrophone(enabled) { return this.#enableTrack('audio', enabled, MIC); }
  setCamera(enabled) { return this.#enableTrack('video', enabled, CAM); }

  /**
   * Silences one member locally: enabled = false on their current and future remote audio
   * tracks. Media still arrives and nothing is signalled, so the peer cannot tell. Muting
   * an unknown peer is allowed and applies when their audio arrives. Video is untouched.
   */
  setPeerMuted(peer, muted) {
    if (typeof peer !== 'string' || !PEER_ID.test(peer)) throw new TypeError('Invalid peer id');
    if (typeof muted !== 'boolean') throw new TypeError('muted must be a boolean');
    if (muted) this.mutedPeers.add(peer); else this.mutedPeers.delete(peer);
    for (const track of this.remoteAudio.get(peer) ?? []) track.enabled = !muted;
  }

  constraintsFor(kind, base) { const id = this.devices[kind]; return id ? { ...base, deviceId: { exact: id } } : base; }

  /**
   * Use another microphone ('audio') or camera ('video'): a deviceId from enumerateDevices(), or
   * null for the default. A running track is replaced on every link without renegotiation and
   * keeps its mute state; otherwise the choice applies to the next setMicrophone/setCamera(true).
   */
  async switchDevice(kind, id) {
    if (kind !== 'audio' && kind !== 'video') throw new TypeError("kind must be 'audio' or 'video'");
    if (!deviceId(id)) throw new TypeError('Invalid capture device id');
    this.devices = { ...this.devices, [kind]: id ?? null };
    const old = this.localStream?.getTracks().find(t => t.kind === kind);
    if (this.closed || !old) return !this.closed;
    const captured = await this.getUserMedia({ [kind]: this.constraintsFor(kind, kind === 'audio' ? MIC : CAM) });
    const track = captured.getTracks().find(t => t.kind === kind);
    // Never keep a device that was captured after leave(), or for a track that was switched off meanwhile.
    if (this.closed || !track || !this.localStream.getTracks().includes(old)) { for (const t of captured.getTracks()) t.stop(); return false; }
    track.enabled = old.enabled;
    this.localStream.addTrack(track); this.localStream.removeTrack(old);
    for (const link of this.links.values()) await link.senders.get(kind)?.replaceTrack(track);
    for (const link of this.links.values()) await this.applyEncodingLimits(link);
    old.stop();
    return true;
  }

  async applyEncodingLimits(link) {
    const forwarded = new Set();
    for (const entry of link.forwardSenders?.values?.() ?? []) for (const s of entry.senders.values()) forwarded.add(s);
    const senders = link.pc.getSenders?.() ?? [...link.senders.values()];
    for (const sender of senders) {
      if (!sender.track) continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) continue;
      const max = sender.track.kind === 'audio' ? this.limits.audioBitrate : forwarded.has(sender) ? this.limits.forwardVideoBitrate : this.limits.videoBitrate;
      const state = this.videoQuality.get(link.id);
      const localLevel = this.adaptiveVideoEnabled ? state?.sendLevel ?? 'normal' : 'normal';
      const remoteLevel = this.adaptiveVideoEnabled ? state?.remoteLevel ?? 'normal' : 'normal';
      const quality = VIDEO_QUALITY_SETTINGS[Math.max(VIDEO_QUALITY_INDEX[localLevel], VIDEO_QUALITY_INDEX[remoteLevel])];
      let changed = false;
      for (const e of params.encodings) {
        const bitrate = sender.track.kind === 'audio' ? max : quality.bitrate === null ? max : Math.min(max, quality.bitrate);
        if (e.maxBitrate !== bitrate) { e.maxBitrate = bitrate; changed = true; }
        if (sender.track.kind === 'video') {
          if (e.active !== quality.active) { e.active = quality.active; changed = true; }
          if (quality.framerate !== null && e.maxFramerate !== quality.framerate) { e.maxFramerate = quality.framerate; changed = true; }
          if (quality.framerate === null && e.maxFramerate !== undefined) { delete e.maxFramerate; changed = true; }
          if (e.scaleResolutionDownBy !== quality.scale) { e.scaleResolutionDownBy = quality.scale; changed = true; }
        }
      }
      if (changed) { try { await sender.setParameters(params); } catch (error) { this.count('encodingErrors', error); } }
    }
  }

  videoQualityState(peer) {
    let state = this.videoQuality.get(peer);
    if (!state) {
      state = {sendLevel: 'normal', reportedSendLevel: 'normal', receiveLevel: 'normal', remoteLevel: 'normal', sendBad: 0, sendGood: 0,
        receiveBad: 0, receiveGood: 0, previous: null, receiveProbe: false, sendProbe: false, lastControlAt: 0, lastRequestN: 0};
      this.videoQuality.set(peer, state);
    }
    return state;
  }

  setVideoQuality(peer, direction, level, reason) {
    const state = this.videoQualityState(peer);
    const property = direction === 'send' ? 'reportedSendLevel' : 'receiveLevel';
    if (state[property] === level) return false;
    state[property] = level;
    this.emit('video-quality', {peer, direction, level, reason});
    return true;
  }

  async setAdaptiveVideo(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    if (enabled === this.adaptiveVideoEnabled) return enabled;
    if (!enabled) {
      for (const [peer, state] of this.videoQuality) {
        if (state.receiveLevel !== 'normal') this.signalTo(peer, {kind: 'video-quality', level: 'normal'}).catch(() => {});
        if (state.reportedSendLevel !== 'normal') this.emit('video-quality', {peer, direction: 'send', level: 'normal', reason: 'disabled'});
        if (state.receiveLevel !== 'normal') this.emit('video-quality', {peer, direction: 'receive', level: 'normal', reason: 'disabled'});
        state.sendBad = state.sendGood = state.receiveBad = state.receiveGood = 0;
        state.sendProbe = state.receiveProbe = false;
        state.sendLevel = state.reportedSendLevel = state.receiveLevel = state.remoteLevel = 'normal';
      }
      this.adaptiveVideoEnabled = false;
    } else {
      this.adaptiveVideoEnabled = true;
      for (const [peer, link] of this.links) {
        const state = this.videoQualityState(peer);
        state.previous = null; state.sendBad = state.sendGood = state.receiveBad = state.receiveGood = 0;
        this.emit('video-quality', {peer, direction: 'send', level: this.effectiveVideoLevel(state), reason: 'monitoring'});
        this.emit('video-quality', {peer, direction: 'receive', level: state.receiveLevel, reason: 'monitoring'});
        if (link.connected && state.receiveLevel !== 'normal') this.signalTo(peer, {kind: 'video-quality', level: state.receiveLevel}).catch(() => {});
      }
    }
    for (const link of this.links.values()) await this.applyEncodingLimits(link);
    return enabled;
  }

  receiveVideoQuality(from, message) {
    const link = this.links.get(from);
    if (!this.adaptiveVideoEnabled || !link?.connected || !VIDEO_QUALITY.includes(message.level) ||
        !Number.isSafeInteger(message.n) || message.n <= 0) return;
    const state = this.videoQualityState(from), now = Date.now();
    if (message.n <= state.lastRequestN || now - state.lastControlAt < 1000) return;
    state.lastRequestN = message.n; state.lastControlAt = now;
    if (state.remoteLevel === message.level) return;
    state.remoteLevel = message.level;
    this.setVideoQuality(from, 'send', this.effectiveVideoLevel(state), 'peer-request');
    this.applyEncodingLimits(link);
  }

  effectiveVideoLevel(state) {
    return VIDEO_QUALITY[Math.max(VIDEO_QUALITY_INDEX[state.sendLevel], VIDEO_QUALITY_INDEX[state.remoteLevel])];
  }

  reportReceiveVideoQuality(link, level, reason) {
    const state = this.videoQualityState(link.id);
    const changed = state.receiveLevel !== level;
    if (!changed) return;
    state.receiveLevel = level;
    this.emit('video-quality', {peer: link.id, direction: 'receive', level, reason});
    this.signalTo(link.id, {kind: 'video-quality', level}).catch(error => this.count('videoQualityErrors', error));
  }

  async checkAdaptiveVideo(link, stats) {
    if (!this.adaptiveVideoEnabled || !link.connected || link.closed) return;
    const state = this.videoQualityState(link.id), values = [...stats.values()];
    const outbound = values.filter(s => s.type === 'outbound-rtp' && s.kind === 'video');
    const inbound = values.filter(s => s.type === 'inbound-rtp' && s.kind === 'video');
    const transport = values.find(s => s.type === 'transport' && s.selectedCandidatePairId);
    const pair = (transport && stats.get(transport.selectedCandidatePairId)) ??
      values.find(s => s.type === 'candidate-pair' && (s.selected || s.nominated)) ??
      values.find(s => s.type === 'candidate-pair' && s.state === 'succeeded');
    const sum = (items, key) => items.reduce((total, item) => total + (item[key] ?? 0), 0);
    const current = {
      outBytes: sum(outbound, 'bytesSent'), outPackets: sum(outbound, 'packetsSent'),
      inBytes: sum(inbound, 'bytesReceived'), inPackets: sum(inbound, 'packetsReceived'), inLost: sum(inbound, 'packetsLost'),
      inFrames: sum(inbound, 'framesDecoded'), inDropped: sum(inbound, 'framesDropped'), inDecode: sum(inbound, 'totalDecodeTime'),
      limitation: outbound.some(s => s.qualityLimitationReason === 'cpu') ? 'cpu' : outbound.some(s => s.qualityLimitationReason === 'bandwidth') ? 'bandwidth' : 'none',
      available: pair?.availableOutgoingBitrate ?? null,
    };
    const previous = state.previous;
    state.previous = current;
    if (!previous) return;
    const hasLocalVideo = this.localStream?.getTracks().some(track => track.kind === 'video' && track.readyState === 'live');
    const sentBytes = current.outBytes - previous.outBytes;
    const recvPackets = current.inPackets - previous.inPackets;
    const lostPackets = current.inLost - previous.inLost;
    const decoded = current.inFrames - previous.inFrames;
    const dropped = current.inDropped - previous.inDropped;
    const decodeTime = current.inDecode - previous.inDecode;
    const lossRate = Math.max(0, recvPackets) + Math.max(0, lostPackets) > 0 ? Math.max(0, lostPackets) / (Math.max(0, recvPackets) + Math.max(0, lostPackets)) : 0;
    const dropRate = Math.max(0, decoded) + Math.max(0, dropped) > 0 ? Math.max(0, dropped) / (Math.max(0, decoded) + Math.max(0, dropped)) : 0;
    const decodeSlow = decoded >= 5 && decodeTime / decoded > 0.05;
    const sendLimit = VIDEO_QUALITY_SETTINGS[VIDEO_QUALITY_INDEX[this.effectiveVideoLevel(state)]].bitrate ?? this.limits.videoBitrate;
    const lowEstimate = current.available !== null && current.available < Math.min(180000, sendLimit * 0.7);
    const outgoingBad = current.limitation === 'cpu' || current.limitation === 'bandwidth' && lowEstimate || lowEstimate && sentBytes > 0;
    const incomingBad = recvPackets + lostPackets >= 10 && lossRate >= 0.08 || decoded + dropped >= 10 && dropRate >= 0.12 || decodeSlow;
    const severeReceive = lossRate >= 0.25 || dropRate >= 0.3 || decoded >= 5 && decodeTime / decoded > 0.15;
    const now = Date.now();

    state.sendBad = hasLocalVideo && outgoingBad ? state.sendBad + 1 : 0;
    state.sendGood = hasLocalVideo && !outgoingBad ? state.sendGood + 1 : 0;
    if (hasLocalVideo && state.sendBad >= 2) {
      const severeSend = current.available !== null && current.available < 60000 || state.sendLevel === 'minimal' && current.limitation === 'cpu';
      const next = severeSend ? 'paused' : VIDEO_QUALITY[Math.min(2, VIDEO_QUALITY_INDEX[state.sendLevel] + 1)];
      state.sendBad = 0;
      if (next !== state.sendLevel) {
        state.sendProbe = false;
        state.sendGood = state.sendBad = 0;
        state.sendChangedAt = now;
        state.sendLevel = next;
        this.setVideoQuality(link.id, 'send', this.effectiveVideoLevel(state), current.limitation === 'cpu' ? 'cpu' : 'bandwidth');
        await this.applyEncodingLimits(link);
      }
    } else if (hasLocalVideo && state.sendLevel === 'paused' && !state.sendProbe && now - (state.sendChangedAt ?? now) >= 25000) {
      state.sendProbe = true; state.sendLevel = 'minimal'; state.sendGood = 0;
      this.setVideoQuality(link.id, 'send', this.effectiveVideoLevel(state), 'recovery-probe');
      await this.applyEncodingLimits(link);
    } else if (hasLocalVideo && state.sendGood >= 5 && state.sendLevel !== 'normal') {
      state.sendLevel = VIDEO_QUALITY[Math.max(0, VIDEO_QUALITY_INDEX[state.sendLevel] - 1)];
      state.sendProbe = false; state.sendGood = state.sendBad = 0; state.sendChangedAt = now;
      this.setVideoQuality(link.id, 'send', this.effectiveVideoLevel(state), 'recovery');
      await this.applyEncodingLimits(link);
    }

    state.receiveBad = incomingBad ? state.receiveBad + 1 : 0;
    state.receiveGood = incomingBad ? 0 : state.receiveGood + 1;
    if (state.receiveBad >= 2) {
      const next = severeReceive ? 'paused' : VIDEO_QUALITY[Math.min(3, VIDEO_QUALITY_INDEX[state.receiveLevel] + 1)];
      state.receiveBad = 0;
      if (next !== state.receiveLevel) {
        state.receiveProbe = false; state.receiveGood = state.receiveBad = 0; state.receiveChangedAt = now;
        this.reportReceiveVideoQuality(link, next, decodeSlow ? 'cpu' : 'bandwidth');
      }
    } else if (state.receiveLevel === 'paused' && !state.receiveProbe && now - (state.receiveChangedAt ?? now) >= 25000) {
      state.receiveProbe = true; state.receiveGood = 0;
      this.reportReceiveVideoQuality(link, 'minimal', 'recovery-probe');
    } else if (state.receiveGood >= 5 && state.receiveLevel !== 'normal') {
      const next = VIDEO_QUALITY[Math.max(0, VIDEO_QUALITY_INDEX[state.receiveLevel] - 1)];
      state.receiveProbe = false; state.receiveGood = state.receiveBad = 0; state.receiveChangedAt = now;
      this.reportReceiveVideoQuality(link, next, 'recovery');
    }
  }

  // A negotiated Chromium audio sender can remain silent although ICE and
  // video are healthy. Rebind its existing track before trying ICE recovery.
  async restoreAudioSender(link, sender, state) {
    const { track, epoch } = state;
    // Leave, rekey, replacement links, or a device switch owns the new state.
    if (this.closed || this.crypto !== epoch || link.closed || this.links.get(link.id) !== link ||
        sender.track !== null || !this.localStream?.getTracks().includes(track) || track.readyState !== 'live') {
      this.audioRestores.delete(sender);
      return true;
    }
    if (state.wait > 0) { state.wait--; return true; }
    try {
      await sender.replaceTrack(track);
      this.audioRestores.delete(sender);
      this.log('audio-sender-refreshed', { peer: link.id });
      return true;
    } catch (error) {
      // Detachment succeeded: keep ownership so a later watch can reattach.
      // Persistent failures back off rather than leaving a null sender forever.
      state.failures++;
      state.wait = Math.min(12, 2 ** Math.min(state.failures - 1, 4)) - 1;
      this.count('linkErrors', error);
      return false;
    }
  }

  async refreshAudioSender(link, sender, track, epoch) {
    if (link.pc.signalingState !== 'stable' || typeof sender.replaceTrack !== 'function') return false;
    const state = { track, epoch, failures: 0, wait: 0 };
    try {
      await sender.replaceTrack(null);
    } catch (error) { this.count('linkErrors', error); return false; }
    this.audioRestores.set(sender, state);
    return this.restoreAudioSender(link, sender, state);
  }

  // Safety net: observe packet progress after an audio refresh. Continued
  // silence falls back to ICE once; successful promises alone are not recovery.
  async checkSending() {
    if (this.checkingSending) return;
    this.checkingSending = true;
    const epoch = this.crypto;
    try {
      for (const link of [...this.links.values()]) {
        if (!link.connected || link.closed) continue;
        let stats; try { stats = await link.pc.getStats(); } catch { continue; }
        if (this.closed || this.crypto !== epoch || link.closed) return;
        this.updatePath(link, stats);
        await this.checkAdaptiveVideo(link, stats);
        const sent = {};
        for (const s of stats.values()) if (s.type === 'outbound-rtp' && s.kind) sent[s.kind] = (sent[s.kind] ?? 0) + (s.packetsSent ?? 0);
        const progress = this.sendProgress.get(link.id) ?? {};
        for (const track of this.localStream?.getTracks() ?? []) {
          const sender = link.senders.get(track.kind);
          const pending = sender && this.audioRestores.get(sender);
          if (pending) {
            await this.restoreAudioSender(link, sender, pending);
            if (this.closed || this.crypto !== epoch || link.closed) return;
          }
          if (track.kind === 'video' && this.effectiveVideoLevel(this.videoQualityState(link.id)) === 'paused') { delete progress.video; continue; }
          if (track.readyState !== 'live' || track.enabled === false || !sender?.track) {
            if (!this.audioRestores.has(sender ?? {})) delete progress[track.kind];
            continue;
          }
          const now = sent[track.kind] ?? 0, before = progress[track.kind];
          const stalls = before && now <= before.packets ? before.stalls + 1 : 0;
          const state = progress[track.kind] = { packets: now, stalls,
            fallback: stalls > 0 && before?.fallback === true };
          let restart = false;
          if (stalls === 2) {
            this.counters.mediaStalls++;
            restart = track.kind !== 'audio' || !await this.refreshAudioSender(link, sender, track, epoch);
          } else if (track.kind === 'audio' && stalls >= 4 && !state.fallback) {
            restart = true;
          }
          if (this.closed || this.crypto !== epoch || link.closed) return;
          if (restart) {
            state.fallback = true;
            if (link.polite) this.signalTo(link.id, { kind: 'restart-request' }); else link.restart();
          }
        }
        this.sendProgress.set(link.id, progress);
      }
    } finally { this.checkingSending = false; }
  }

  onRemoteTrack(link, origin, track, stream) {
    if (track.kind === 'audio') {
      let set = this.remoteAudio.get(origin);
      if (!set) this.remoteAudio.set(origin, set = new Set());
      set.add(track);
      track.addEventListener('ended', () => set.delete(track));
      if (this.mutedPeers.has(origin)) track.enabled = false;
    }
    this.emit('track', { peer: origin, via: origin === link.id ? null : link.id, track, stream });
    if (origin !== link.id) return;
    // A forwarder keeps forwarding tracks the origin adds later (e.g. camera switched on).
    for (const bridge of this.relaying.values()) {
      const other = bridge.a === origin ? bridge.b : bridge.b === origin ? bridge.a : null;
      const target = other && this.links.get(other);
      if (target?.connected) target.addForward(origin, [track]);
    }
  }

  // ---------- inspection & teardown ----------
  async stats() {
    const links = [];
    for (const link of this.links.values()) {
      const media = { inbound: {}, outbound: {} };
      try {
        for (const s of (await link.pc.getStats()).values()) {
          if (s.type === 'inbound-rtp' && s.kind) {
            const m = media.inbound[s.kind] ??= { packets: 0, bytes: 0, frames: 0, samples: 0, lost: 0, jitter: 0, streams: 0 };
            m.streams++; m.packets += s.packetsReceived ?? 0; m.bytes += s.bytesReceived ?? 0; m.frames += s.framesDecoded ?? 0;
            m.samples += s.totalSamplesReceived ?? 0; m.lost += s.packetsLost ?? 0; m.jitter = Math.max(m.jitter, s.jitter ?? 0);
            if (s.frameWidth) { m.width = s.frameWidth; m.height = s.frameHeight; }
          } else if (s.type === 'outbound-rtp' && s.kind) {
            const m = media.outbound[s.kind] ??= { packets: 0, bytes: 0, frames: 0, streams: 0 };
            m.streams++; m.packets += s.packetsSent ?? 0; m.bytes += s.bytesSent ?? 0; m.frames += s.framesEncoded ?? 0;
          }
        }
      } catch {}
      links.push({ peer: link.id, connected: link.connected, phase: link.phase, path: { ...link.path }, restarts: link.restarts,
        connectMs: link.connectedAt ? link.connectedAt - link.createdAt : null, forwardedOrigins: [...link.forwardMap.values()], forwarding: [...link.forwardSenders.keys()], media });
    }
    return { id: this.id, tag: this.tag, counters: { ...this.counters },
      gates: this.gates.map(g => ({ url: g.url, state: g.state, ...g.counters })),
      bridges: [...this.bridges.values()].map(b => ({ ...b })), relaying: [...this.relaying.values()].map(b => ({ ...b })), links,
      ...(this.classifyNatEnabled ? { nat: this.nat ? { ...this.nat } : { type: 'unknown', delta: 0 } } : {}) };
  }

  async leave() {
    if (this.closed) return;
    const goodbyes = [...this.known, ...this.gatewayMembers].map(peer => this.signalTo(peer, { kind: 'bye' }).catch(() => {}));
    await Promise.race([Promise.all(goodbyes), new Promise(r => setTimeout(r, 300))]);
    this.closed = true;
    clearTimeout(this.capsTimer); clearInterval(this.mediaWatch); clearInterval(this.sweeper);
    for (const t of this.pendingLinks.values()) clearTimeout(t);
    for (const link of this.links.values()) link.close();
    this.links.clear(); this.outbox.clear();
    this.videoQuality.clear();
    for (const gate of this.gates) gate.close();
    if (this.ownsMedia) for (const track of this.localStream?.getTracks() ?? []) track.stop();
    this.emit('closed', {});
  }
}
