// SPDX-License-Identifier: Apache-2.0
// A WebTorrent (BitTorrent-over-WebSocket) tracker used as a gate, so a room can run on
// public infrastructure that already exists. Trackers relay opaque WebRTC offers/answers
// between peers of a swarm; Freehop places its sealed envelopes in those fields:
//   offer  = "pl1:<peer id>:<sealed hello>"   (announced, delivered to random swarm members)
//   answer = "pl1:<peer id>:<sealed envelope>" (addressed to one peer via to_peer_id)
// The swarm's info_hash is derived from the room tag, so only room members can find it, and
// every envelope is authenticated by the room key before it is trusted.
import { Emitter } from './gate-client.mjs';
import { fromBase64Url } from './crypto.mjs';

const PREFIX = 'pl1:';
const PEER_ID = /^[A-Za-z0-9_-]{22}$/;
// Trackers treat info_hash/peer_id as 20-byte strings. ASCII-only values avoid tracker
// implementations that mishandle raw bytes in JSON text frames.
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const random20 = () => [...globalThis.crypto.getRandomValues(new Uint8Array(20))].map(b => ALPHABET[b % 62]).join('');
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

export class TrackerClient extends Emitter {
  constructor(url, { room, peer, hello, needsIntroduction = () => false, bootstrapMs = [8000, 24000],
    WebSocketImpl = globalThis.WebSocket, announceMs = 30000, offers = 6,
    backoffMs = [1000, 2000, 5000, 10000, 30000, 60000] } = {}) {
    super();
    Object.assign(this, { url, room, peer, hello, needsIntroduction, bootstrapMs, WebSocketImpl, announceMs, offers, backoffMs });
    this.infoHash = hex(fromBase64Url(room)).slice(0, 20);
    this.trackerPeerId = random20();
    this.trackerIds = new Map();   // peerlane id -> tracker peer_id (binary string)
    this.state = 'idle'; this.closed = false; this.ws = null; this.attempt = 0; this.stun = []; this.started = false;
    this.counters = { sent: 0, received: 0, bytesOut: 0, bytesIn: 0, errors: 0, connects: 0, announces: 0 };
  }
  connect() {
    if (this.closed || this.ws) return;
    this.state = 'connecting';
    let ws;
    try { ws = new this.WebSocketImpl(this.url); } catch { this.#retry(); return; }
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.state = 'joined'; this.attempt = 0; this.counters.connects++; this.started = false;
      this.emit('joined', { gate: this, peers: [], stun: [] });
      this.announce();
      clearInterval(this.timer);
      this.timer = setInterval(() => this.announce(), this.announceMs);
      // Trackers commonly request a 120 s interval. A missed first offer would leave a
      // new meeting empty that long, so make two bounded introduction retries.
      this.bootstrapTimers = this.bootstrapMs.map(ms => setTimeout(() => {
        if (this.state === 'joined' && this.needsIntroduction()) this.announce();
      }, ms));
    };
    ws.onmessage = event => {
      if (ws !== this.ws || typeof event.data !== 'string' || event.data.length > 200000) return;
      this.counters.bytesIn += event.data.length;
      let m; try { m = JSON.parse(event.data); } catch { return; }
      this.#handle(m);
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.ws = null; clearInterval(this.timer);
      for (const timer of this.bootstrapTimers ?? []) clearTimeout(timer);
      this.bootstrapTimers = [];
      const was = this.state; this.state = 'idle';
      if (was === 'joined') this.emit('left', { gate: this });
      this.#retry();
    };
    ws.onerror = () => { this.counters.errors++; };
  }
  #retry() {
    if (this.closed) return;
    const delay = this.backoffMs[Math.min(this.attempt++, this.backoffMs.length - 1)];
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, delay * (0.75 + Math.random() / 2));
  }
  #raw(message) {
    if (this.ws?.readyState !== 1) return false;
    const text = JSON.stringify(message);
    this.ws.send(text); this.counters.bytesOut += text.length;
    return true;
  }
  async announce() {
    if (this.state !== 'joined') return;
    const offers = [];
    for (let i = 0; i < this.offers; i++) offers.push({ offer_id: random20(), offer: { type: 'offer', sdp: PREFIX + this.peer + ':' + await this.hello() } });
    this.#raw({ action: 'announce', info_hash: this.infoHash, peer_id: this.trackerPeerId, numwant: this.offers,
      uploaded: 0, downloaded: 0, left: 1, ...(this.started ? {} : { event: 'started' }), offers });
    this.started = true; this.counters.announces++;
  }
  #handle(m) {
    if (m?.action !== 'announce' || m.info_hash !== this.infoHash) return;
    if (Number.isFinite(m.interval) && m.interval * 1000 > this.announceMs && m.interval < 3600) {
      this.announceMs = m.interval * 1000; clearInterval(this.timer); this.timer = setInterval(() => this.announce(), this.announceMs);
    }
    const payload = m.offer?.sdp ?? m.answer?.sdp;
    if (typeof payload !== 'string' || !payload.startsWith(PREFIX) || typeof m.peer_id !== 'string' || m.peer_id === this.trackerPeerId) return;
    const rest = payload.slice(PREFIX.length), split = rest.indexOf(':');
    const from = rest.slice(0, split), box = rest.slice(split + 1);
    if (box.length > 49152 || split !== 22 || !PEER_ID.test(from) || from === this.peer || !/^[A-Za-z0-9_-]+$/.test(box)) return;
    // The tracker address is remembered only once the room authenticated this sender (bind()),
    // so a swarm member cannot redirect envelopes by impersonating a peer id.
    this.counters.received++;
    if (m.offer) this.emit('hello', { gate: this, from, box, route: m.peer_id });
    else this.emit('recv', { gate: this, from, box, route: m.peer_id });
  }
  bind(peer, route) {
    if (typeof route !== 'string' || route.length !== 20) return;
    if (!this.trackerIds.has(peer) && this.trackerIds.size >= 64) this.trackerIds.delete(this.trackerIds.keys().next().value);
    this.trackerIds.set(peer, route);
  }
  send(to, box) {
    const target = this.trackerIds.get(to);
    if (this.state !== 'joined' || !target) return false;
    const ok = this.#raw({ action: 'announce', info_hash: this.infoHash, peer_id: this.trackerPeerId, to_peer_id: target,
      answer: { type: 'answer', sdp: PREFIX + this.peer + ':' + box }, offer_id: random20() });
    if (ok) this.counters.sent++;
    return ok;
  }
  close() {
    this.closed = true; clearInterval(this.timer); clearTimeout(this.retryTimer);
    for (const timer of this.bootstrapTimers ?? []) clearTimeout(timer);
    this.bootstrapTimers = [];
    const ws = this.ws; this.ws = null; this.state = 'closed';
    if (ws) { try { if (ws.readyState === 1) ws.send(JSON.stringify({ action: 'announce', info_hash: this.infoHash, peer_id: this.trackerPeerId, event: 'stopped', numwant: 0, uploaded: 0, downloaded: 0, left: 1 })); ws.close(1000); } catch {} }
  }
}
