// SPDX-License-Identifier: Apache-2.0
// A room is the set of peers sharing one secret. Gates only introduce peers; once two peers
// are linked, signalling flows over their own data channel. Media takes the cheapest
// working path: direct (host/IPv6/srflx/prflx) or an endpoint's own gateway, then a gateway
// run by another session member, then forwarding by another participant. No path ever uses
// infrastructure outside the session's own peers.
import { deriveRoom, seal, open, randomId } from './crypto.mjs';
import { Emitter, GateClient } from './gate-client.mjs';
import { TrackerClient } from './tracker-client.mjs';
import { validIceUrl, validStunUrls } from './ice-urls.mjs';
import { PeerLink, PHASE } from './peer.mjs';

const PEER_ID = /^[A-Za-z0-9_-]{22}$/;
const IP = /^[0-9a-fA-F.:]{2,45}$/;
const pairKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
// Gateway members (the session's host node) announce themselves with this id prefix. The
// prefix is only a hint; their gateway is learned from sealed caps like anything else.
const isGatewayMember = id => id.startsWith('gw_');
const KINDS = new Set(['caps', 'description', 'candidate', 'bye', 'restart-request', 'bridge-request', 'bridge-offer', 'bridge-accept',
  'bridge-confirm', 'bridge-ready', 'bridge-active', 'bridge-release', 'bridge-fail', 'forward-map', 'forward-unmap']);

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
      offerTimeouts: 0, mediaStalls: 0 };
    this.sendCounter = 0; this.closed = false; this.localStream = null; this.ownsMedia = false;
    this.sendProgress = new Map(); this.meshBudget = new Map();
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

  async changeKey(secret, { auth, gates, stun } = {}) {
    if (this.closed) return;
    if (gates !== undefined && (!Array.isArray(gates) || !gates.length)) throw new TypeError('At least one gate URL is required.');
    if (stun !== undefined && !validStunUrls(stun)) throw new TypeError('Invalid application STUN URLs');
    const nextGates = gates ?? this.options.gates;
    if (typeof auth === 'string' && nextGates.length !== 1) throw new TypeError('Use per-gate auth tokens for multiple gates');
    const next = await deriveRoom(secret, this.app);
    if (this.closed) return;
    // A rotation may also evict a gate or change STUN: the next ticket's lists replace the old ones.
    this.options = { ...this.options, auth, gates: nextGates };
    if (stun !== undefined) this.stunUrls = new Set(stun);
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
    this.sendProgress.delete(peer); this.meshBudget.delete(peer);
    this.lastContact.delete(peer); this.gatewayCreds.delete(`${this.tag8}:${peer}`);
    // The replay window survives a soft departure: a returning peer keeps its counter.
    if (reason !== 'gone') this.sequences.delete(peer);
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
      case 'restart-request': {
        // The polite side saw its media stall; only the impolite side restarts (no glare).
        const link = this.links.get(from);
        if (link && !link.polite) link.enqueue(() => link.restart());
        return;
      }
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
    return { v: 1, forward: this.forward, peers: [...this.links.values()].filter(l => l.connected && l.control.readyState === 'open').map(l => l.id), gateway };
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
    // Nothing better exists right now: keep retrying slowly. New peers, gateways or a network
    // change may open a path later; every retry is a cheap ICE restart, never a server relay.
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
  }

  gatewayOwner(info) {
    const owns = (g, address, url) => g && (address && g.external.includes(address) || url && (g.urls.includes(url) || g.internalUrls?.includes(url)) ||
      address && g.internal === address);
    const candidates = [[this.id, this.ownGateway], ...[...this.caps].map(([id, c]) => [id, c.gateway])];
    for (const [id, g] of candidates) {
      if ((info.local === 'relay' || info.relayProtocol) && owns(g, info.localAddress, info.relayUrl)) return id;
      if (info.remote === 'relay' && owns(g, info.remoteAddress, null)) return id;
    }
    return 'unknown';
  }

  onLinkConnected(link) {
    this.lastContact.set(link.id, Date.now());
    this.scheduleCapsBroadcast();
    this.applyEncodingLimits(link);
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
      return;
    }
    if (track) { track.enabled = true; return; }
    const captured = await this.getUserMedia({ [kind]: constraints });
    if (this.closed) { for (const t of captured.getTracks()) t.stop(); return; }
    track = captured.getTracks().find(t => t.kind === kind);
    if (!track) return;
    this.localStream.addTrack(track);
    for (const link of this.links.values()) {
      const sender = link.senders.get(kind);
      if (sender) await sender.replaceTrack(track);
      else link.senders.set(kind, link.pc.addTrack(track, this.localStream));
    }
  }

  setMicrophone(enabled) { return this.#enableTrack('audio', enabled, { echoCancellation: true, noiseSuppression: true, autoGainControl: true }); }
  setCamera(enabled) { return this.#enableTrack('video', enabled, { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } }); }

  async applyEncodingLimits(link) {
    const forwarded = new Set();
    for (const entry of link.forwardSenders.values()) for (const s of entry.senders.values()) forwarded.add(s);
    for (const sender of link.pc.getSenders()) {
      if (!sender.track) continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) continue;
      const max = sender.track.kind === 'audio' ? this.limits.audioBitrate : forwarded.has(sender) ? this.limits.forwardVideoBitrate : this.limits.videoBitrate;
      let changed = false;
      for (const e of params.encodings) if (e.maxBitrate !== max) { e.maxBitrate = max; changed = true; }
      if (changed) { try { await sender.setParameters(params); } catch (error) { this.count('encodingErrors', error); } }
    }
  }

  // Safety net: a connected link whose live local track sends no packets for two checks gets
  // a fresh ICE restart from its impolite side (the polite side asks for one).
  async checkSending() {
    const epoch = this.crypto;
    for (const link of [...this.links.values()]) {
      if (!link.connected || link.closed) continue;
      let stats; try { stats = await link.pc.getStats(); } catch { continue; }
      if (this.closed || this.crypto !== epoch || link.closed) return;
      this.updatePath(link, stats);
      const sent = {};
      for (const s of stats.values()) if (s.type === 'outbound-rtp' && s.kind) sent[s.kind] = (sent[s.kind] ?? 0) + (s.packetsSent ?? 0);
      const progress = this.sendProgress.get(link.id) ?? {};
      for (const track of this.localStream?.getTracks() ?? []) {
        if (track.readyState !== 'live' || !link.senders.get(track.kind)?.track) continue;
        const now = sent[track.kind] ?? 0, before = progress[track.kind];
        const stalls = before && now <= before.packets ? before.stalls + 1 : 0;
        progress[track.kind] = { packets: now, stalls };
        if (stalls === 2) {
          this.counters.mediaStalls++;
          if (link.polite) this.signalTo(link.id, { kind: 'restart-request' }); else link.restart();
        }
      }
      this.sendProgress.set(link.id, progress);
    }
  }

  onRemoteTrack(link, origin, track, stream) {
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
      bridges: [...this.bridges.values()].map(b => ({ ...b })), relaying: [...this.relaying.values()].map(b => ({ ...b })), links };
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
    for (const gate of this.gates) gate.close();
    if (this.ownsMedia) for (const track of this.localStream?.getTracks() ?? []) track.stop();
    this.emit('closed', {});
  }
}
