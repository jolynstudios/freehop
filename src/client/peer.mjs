// SPDX-License-Identifier: Apache-2.0
// One RTCPeerConnection per remote peer. Perfect negotiation (W3C WebRTC "perfect negotiation"
// example) lets either side renegotiate; the path ladder escalates only after the cheaper
// path demonstrably failed, so media cost stays with the two endpoints whenever possible.
export const PHASE = Object.freeze({ ENDPOINT: 0, SESSION: 1, BRIDGED: 2 });
const UFRAG = /^a=ice-ufrag:(\S+)\r?$/gm;

export class PeerLink {
  constructor(room, id, { forOffer = false } = {}) {
    this.room = room; this.id = id; this.polite = room.id > id;
    // A link created to answer an incoming offer must not race it with an offer of its own.
    this.suppress = forOffer; this.missedNegotiation = false; this.restartPending = false;
    this.phase = PHASE.ENDPOINT; this.connected = false; this.everConnected = false; this.closed = false;
    this.makingOffer = false; this.ignoreOffer = false; this.settingAnswer = false;
    this.pendingCandidates = []; this.forwardMap = new Map(); this.forwardSenders = new Map();
    this.senders = new Map(); this.remoteTracks = new Map(); this.queue = Promise.resolve();
    this.watchdog = null; this.grace = false; this.restarts = 0; this.retries = 0; this.path = { kind: 'connecting' };
    this.extraGateways = new Set();   // other participants' gateways added for this pair
    this.lastDescriptionN = 0;        // envelope counter of the last applied remote description
    this.createdAt = Date.now(); this.connectedAt = null;
    const pc = this.pc = new room.RTCPeerConnection({ iceServers: room.iceServersFor(this), bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    this.control = pc.createDataChannel('peerlane', { negotiated: true, id: 0, ordered: true });
    this.control.onmessage = event => room.onControlMessage(this, event.data);
    this.control.onopen = () => room.onControlOpen(this);
    pc.onnegotiationneeded = () => this.negotiate();
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && candidate.candidate) room.signal(this, { kind: 'candidate', candidate: candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => this.onConnectionState();
    pc.onsignalingstatechange = () => { if (pc.signalingState === 'stable') this.room.applyEncodingLimits(this); };
    pc.ontrack = event => this.onTrack(event);
    room.attachLocalMedia(this);
    this.armWatchdog();
  }

  enqueue(task) {
    this.queue = this.queue.then(() => this.closed ? undefined : task()).catch(error => this.room.count('linkErrors', error));
    return this.queue;
  }

  async negotiate() {
    // The negotiation-needed flag only re-fires after it was cleared, so a skipped event is
    // remembered and re-checked once the connection is stable again.
    if (this.suppress || this.closed || this.pc.signalingState !== 'stable') { this.missedNegotiation = true; return; }
    try {
      this.makingOffer = true;
      this.offerIsRestart = this.restartPending;
      await this.pc.setLocalDescription();
      this.sendDescription();
      this.armOfferTimer();
    } catch (error) { this.room.count('negotiationErrors', error); } finally { this.makingOffer = false; }
  }

  // An offer or answer lost in transit would leave this side in have-local-offer forever,
  // ignoring the other side's offers. Roll back and offer again after offerTimeoutMs.
  armOfferTimer() {
    clearTimeout(this.offerTimer);
    this.offerTimer = setTimeout(() => this.enqueue(async () => {
      if (this.closed || this.pc.signalingState !== 'have-local-offer') return;
      this.room.count('offerTimeouts');
      await this.pc.setLocalDescription({ type: 'rollback' });
      if (this.offerIsRestart) this.restart(); else await this.negotiate();
    }), this.room.timing.offerTimeoutMs);
  }

  needsNegotiation() {
    return this.restartPending || this.pc.getTransceivers().some(t => !t.stopped && t.currentDirection !== 'stopped' &&
      (t.mid === null || t.sender.track && !['sendrecv', 'sendonly'].includes(t.currentDirection)));
  }

  async sendDescription() {
    const d = this.pc.localDescription;
    if (!d) return;
    if (d.type === 'offer') this.restartPending = false;
    const description = { type: d.type, sdp: d.sdp };
    const epoch = this.room.crypto, caps = await this.room.capsFor(this.id);
    // A rotation during the await closed this link: never seal its old description under the new key.
    if (this.closed || this.room.crypto !== epoch) return;
    this.room.signal(this, { kind: 'description', description, phase: Math.min(this.phase, PHASE.SESSION),
      gateways: [...this.extraGateways], caps });
  }

  remoteUfrags() { return [...(this.pc.remoteDescription?.sdp ?? '').matchAll(UFRAG)].map(m => m[1]); }

  async onDescription({ description, phase, gateways, caps, n }) {
    const pc = this.pc;
    // Envelopes may take different routes (data channel, several gates); never let an older
    // description overtake a newer one.
    if (Number.isSafeInteger(n)) { if (n <= this.lastDescriptionN) return; this.lastDescriptionN = n; }
    if (caps) this.room.updateCaps(this.id, caps);
    // A restart offer may name gateways the other side now uses: align our ICE servers before
    // answering so our fresh gathering includes the same relays.
    const added = (Array.isArray(gateways) ? gateways : []).filter(id => typeof id === 'string' && id !== this.room.id &&
      id !== this.id && !this.extraGateways.has(id) && this.room.caps.get(id)?.gateway).slice(0, 2);
    for (const id of added) this.extraGateways.add(id);
    if (Number.isInteger(phase) && phase > this.phase && phase <= PHASE.SESSION) this.setPhase(phase);
    if (added.length) this.applyServers(false);
    const readyForOffer = !this.makingOffer && (pc.signalingState === 'stable' || this.settingAnswer);
    const collision = description.type === 'offer' && !readyForOffer;
    this.ignoreOffer = !this.polite && collision;
    if (this.ignoreOffer) return;
    if (description.type === 'offer') this.lastRemoteOfferAt = Date.now();
    this.settingAnswer = description.type === 'answer';
    try { await pc.setRemoteDescription(description); } finally { this.settingAnswer = false; }
    if (description.type === 'answer') clearTimeout(this.offerTimer);
    if (description.type === 'offer') { clearTimeout(this.offerTimer); await pc.setLocalDescription(); this.sendDescription(); }
    await this.flushCandidates();
    this.suppress = false;
    if (this.missedNegotiation && pc.signalingState === 'stable') {
      this.missedNegotiation = false;
      if (this.needsNegotiation()) this.negotiate();
    }
    this.armWatchdog();
  }

  async onCandidate({ candidate }) {
    if (!candidate?.candidate) return;
    const ufrags = this.remoteUfrags();
    if (!this.pc.remoteDescription || candidate.usernameFragment && !ufrags.includes(candidate.usernameFragment)) {
      // Candidates for a future ICE generation wait; the oldest are evicted first.
      this.pendingCandidates.push(candidate);
      if (this.pendingCandidates.length > 128) this.pendingCandidates.shift();
      return;
    }
    try { await this.pc.addIceCandidate(candidate); } catch (error) { if (!this.ignoreOffer) this.room.count('candidateErrors', error); }
  }

  async flushCandidates() {
    const pending = this.pendingCandidates; this.pendingCandidates = [];
    const ufrags = this.remoteUfrags();
    for (const c of pending) {
      if (c.usernameFragment && !ufrags.includes(c.usernameFragment)) { this.pendingCandidates.push(c); continue; }
      await this.onCandidate({ candidate: c });
    }
    if (this.pendingCandidates.length > 128) this.pendingCandidates.splice(0, this.pendingCandidates.length - 128);
  }

  setPhase(phase) {
    if (phase <= this.phase || this.closed) return false;
    this.phase = phase;
    this.grace = false; this.armWatchdog(true);
    this.room.emitPath(this);
    return true;
  }

  applyServers(initiate) {
    if (this.closed) return;
    this.pc.setConfiguration({ ...this.pc.getConfiguration(), iceServers: this.room.iceServersFor(this) });
    if (initiate) this.requestRestart();
  }

  restart() { if (!this.closed) { this.restarts++; this.restartPending = true; this.pc.restartIce(); } }

  // ICE restarts come from the impolite side only: simultaneous restarts collide, and a rolled
  // back restart offer has been observed to leave Chromium's RTP senders silent. The polite
  // side takes over only if no restart offer arrives within restartFallbackMs.
  requestRestart() {
    if (this.closed) return;
    if (!this.polite) { this.restart(); return; }
    const since = Date.now();
    clearTimeout(this.restartFallback);
    this.restartFallback = setTimeout(() => {
      if (!this.closed && !this.connected && (this.lastRemoteOfferAt ?? 0) < since) this.restart();
    }, this.room.timing.restartFallbackMs);
  }

  refreshServers() {
    if (this.closed || this.connected) return;
    this.applyServers(true);
  }

  armWatchdog(reset = false) {
    if (this.closed || this.connected) return;
    if (this.watchdog && !reset) return;
    clearTimeout(this.watchdog);
    const t = this.room.timing;
    const ms = this.phase === PHASE.ENDPOINT ? t.endpointMs : this.phase === PHASE.SESSION ? t.sessionMs : t.bridgedRetryMs;
    this.watchdog = setTimeout(() => { this.watchdog = null; this.enqueue(() => this.checkProgress()); }, ms);
  }

  async checkProgress() {
    if (this.closed || this.connected) return;
    if (!this.grace && this.phase < PHASE.BRIDGED) {
      // Connectivity checks that get answers mean a route is forming: allow one grace period.
      let responses = 0;
      for (const s of (await this.pc.getStats()).values()) if (s.type === 'candidate-pair') responses += s.responsesReceived ?? 0;
      if (responses > 0) { this.grace = true; this.armWatchdog(true); return; }
    }
    this.room.escalate(this);
  }

  onConnectionState() {
    const state = this.pc.connectionState;
    if (state === 'connected') {
      const first = !this.connected; this.connected = true; this.everConnected = true; this.connectedAt ??= Date.now();
      clearTimeout(this.watchdog); this.watchdog = null; clearTimeout(this.recovery); this.recovery = null;
      if (first) this.room.onLinkConnected(this);
      this.room.updatePath(this);
    } else if (state === 'disconnected' || state === 'failed') {
      const was = this.connected; this.connected = false;
      if (was) this.room.onLinkDown(this);
      clearTimeout(this.recovery);
      // Transient loss heals by itself (consent freshness); a failure needs fresh candidates.
      this.recovery = setTimeout(() => this.enqueue(async () => {
        if (this.closed || this.connected) return;
        this.requestRestart();
        this.grace = false; this.armWatchdog(true);
      }), state === 'failed' ? 0 : this.room.timing.recoveryMs);
    }
  }

  onTrack(event) {
    const stream = event.streams[0] ?? null;
    const origin = stream && this.forwardMap.get(stream.id) || this.id;
    if (origin === this.id) {
      const set = this.remoteTracks.get(origin) ?? new Set(); set.add(event.track); this.remoteTracks.set(origin, set);
      event.track.addEventListener('ended', () => set.delete(event.track));
    }
    this.room.onRemoteTrack(this, origin, event.track, stream);
  }

  ownTracks() { return [...(this.remoteTracks.get(this.id) ?? [])].filter(t => t.readyState === 'live'); }

  addForward(origin, tracks) {
    let entry = this.forwardSenders.get(origin);
    if (!entry) { entry = { stream: new MediaStream(), senders: new Map() }; this.forwardSenders.set(origin, entry); }
    for (const track of tracks) {
      if (entry.senders.has(track.id)) continue;
      entry.stream.addTrack(track);
      entry.senders.set(track.id, this.pc.addTrack(track, entry.stream));
    }
    return entry.stream.id;
  }

  removeForward(origin) {
    const entry = this.forwardSenders.get(origin);
    if (!entry) return;
    this.forwardSenders.delete(origin);
    // Stopping the transceiver frees its m-line for reuse; removeTrack would leave it in the
    // SDP forever and grow every later offer.
    for (const sender of entry.senders.values()) {
      const transceiver = this.pc.getTransceivers().find(t => t.sender === sender);
      try { if (transceiver?.stop) transceiver.stop(); else this.pc.removeTrack(sender); } catch {}
    }
  }

  async classify(report) {
    if (this.closed) return null;
    const stats = report ?? await this.pc.getStats();
    let pair;
    for (const s of stats.values()) if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
    if (!pair) for (const s of stats.values()) if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.selected || s.nominated)) { pair = s; break; }
    if (!pair) return null;
    const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
    return {
      local: local?.candidateType, remote: remote?.candidateType,
      protocol: local?.protocol, relayProtocol: local?.relayProtocol ?? null,
      localAddress: local?.address ?? local?.ip ?? null, remoteAddress: remote?.address ?? remote?.ip ?? null,
      relayUrl: local?.url ?? null, rtt: pair.currentRoundTripTime ?? null,
      bytesSent: pair.bytesSent ?? 0, bytesReceived: pair.bytesReceived ?? 0
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true; this.connected = false;
    clearTimeout(this.watchdog); clearTimeout(this.recovery); clearTimeout(this.restartFallback); clearTimeout(this.offerTimer);
    try { this.control.close(); } catch {}
    try { this.pc.close(); } catch {}
    this.pendingCandidates = []; this.forwardMap.clear(); this.forwardSenders.clear(); this.remoteTracks.clear();
  }
}
