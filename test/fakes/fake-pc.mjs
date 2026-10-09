// SPDX-License-Identifier: Apache-2.0
// A deterministic, in-process stand-in for the browser pieces the path ladder touches: a virtual
// clock (setTimeout/setInterval/Date.now), a fake RTCPeerConnection with perfect-negotiation
// semantics, and a scripted "world" that decides which candidate pairs would connect. It proves
// ladder decisions only; real ICE, NAT and media behaviour are proven by the browser suites and
// the NAT lab.

// ---------- virtual clock ----------
const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval, now: Date.now, setImmediate: globalThis.setImmediate };

export function installClock(start = 0) {
  let now = start, seq = 0;
  const timers = new Map(), errors = [];
  const handle = id => ({ id, unref() { return this; }, ref() { return this; }, hasRef() { return true; }, [Symbol.toPrimitive]() { return id; } });
  const add = (fn, ms, args, interval) => {
    const id = ++seq, delay = Math.max(0, Number(ms) || 0);
    timers.set(id, { id, seq: id, at: now + delay, fn, args, interval: interval ? Math.max(1, delay) : 0 });
    return handle(id);
  };
  const clear = h => { if (h !== undefined && h !== null) timers.delete(typeof h === 'object' ? h.id : h); };
  globalThis.setTimeout = (fn, ms, ...args) => add(fn, ms, args, false);
  globalThis.setInterval = (fn, ms, ...args) => add(fn, ms, args, true);
  globalThis.clearTimeout = clear; globalThis.clearInterval = clear;
  Date.now = () => now;
  const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => real.setImmediate(resolve)); };
  return {
    now: () => now,
    errors,
    pending: () => timers.size,
    // Fire timers in due order up to `until`, draining promise jobs after every callback, as the
    // event loop does.
    async run(until) {
      for (;;) {
        await settle();
        let next = null;
        for (const t of timers.values()) if (!next || t.at < next.at || t.at === next.at && t.seq < next.seq) next = t;
        if (!next || next.at > until) break;
        now = Math.max(now, next.at);
        if (next.interval) { next.at += next.interval; next.seq = ++seq; } else timers.delete(next.id);
        try { next.fn(...next.args); } catch (error) { errors.push(error?.message ?? String(error)); }
      }
      now = Math.max(now, until);
      await settle();
    },
    restore() {
      timers.clear();
      Object.assign(globalThis, { setTimeout: real.setTimeout, clearTimeout: real.clearTimeout, setInterval: real.setInterval, clearInterval: real.clearInterval });
      Date.now = real.now;
    }
  };
}

// ---------- fake RTCPeerConnection ----------
const UFRAG = /^a=ice-ufrag:(\S+)\r?$/m;
export const ufragOf = sdp => UFRAG.exec(sdp ?? '')?.[1] ?? null;
export const sdpFor = ufrag => `v=0\r\na=ice-ufrag:${ufrag}\r\na=ice-pwd:fakefakefakefakefakefake\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\n`;
const PROBE = 'turn:192.0.2.1:3478?transport=tcp';

class FakeDataChannel {
  constructor(label) { this.label = label; this.readyState = 'connecting'; this.sent = []; this.onmessage = null; this.onopen = null; }
  send(data) { if (this.readyState !== 'open') throw new Error('InvalidStateError: channel not open'); this.sent.push(data); }
  close() { this.readyState = 'closed'; }
  open() { if (this.readyState === 'connecting') { this.readyState = 'open'; this.onopen?.(); } }
}

const domError = (name, message) => Object.assign(new Error(message), { name });

export function createFakePeerConnection(world) {
  return class FakeRTCPeerConnection {
    constructor(config = {}) {
      this.world = world; this.config = { ...config, iceServers: [...(config.iceServers ?? [])] };
      this.probe = this.config.iceServers.some(s => [].concat(s.urls).includes(PROBE));
      this.signalingState = 'stable'; this.connectionState = 'new'; this.iceGatheringState = 'new';
      this.localDescription = null; this.remoteDescription = null; this.stableLocal = null;
      this.localGeneration = 0; this.remoteUfrag = null; this.answeredRemoteUfrag = null; this.gatheredIceServers = [];
      this.remoteCandidates = []; this.sctpNegotiated = false; this.wantsNegotiation = false; this.iceRestartPending = false;
      this.negotiationQueued = false; this.connectTimer = null; this.closed = false; this.listeners = new Map();
      this.onnegotiationneeded = this.onicecandidate = this.onconnectionstatechange = this.onsignalingstatechange = this.ontrack = null;
      this.id = this.probe ? 'probe' : world.register(this);
      if (!this.probe) world.record(this, 'new', { iceServers: this.config.iceServers });
    }
    addEventListener(type, fn) { const set = this.listeners.get(type) ?? new Set(); set.add(fn); this.listeners.set(type, set); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    fire(type, event = {}) {
      const handler = this[`on${type}`];
      if (typeof handler === 'function') handler.call(this, event);
      for (const fn of this.listeners.get(type) ?? []) fn.call(this, event);
    }
    createDataChannel(label) { this.channel = new FakeDataChannel(label); this.wantsNegotiation = true; this.queueNegotiation(); return this.channel; }
    getConfiguration() { return { ...this.config, iceServers: [...this.config.iceServers] }; }
    setConfiguration(config) {
      if (this.closed) throw domError('InvalidStateError', 'closed');
      this.world.checkConfiguration?.(this, config);
      this.config = { ...config, iceServers: [...(config.iceServers ?? [])] };
      this.world.record(this, 'setConfiguration', { iceServers: this.config.iceServers });
      this.world.evaluate(this);
    }
    restartIce() { if (this.closed) return; this.iceRestartPending = true; this.world.record(this, 'restartIce'); this.queueNegotiation(); }
    queueNegotiation() {
      if (this.negotiationQueued || this.closed) return;
      this.negotiationQueued = true;
      setTimeout(() => {
        this.negotiationQueued = false;
        if (this.closed || this.signalingState !== 'stable') return;
        if (this.iceRestartPending || this.wantsNegotiation && !this.sctpNegotiated) this.fire('negotiationneeded');
      }, 0);
    }
    setSignaling(state) {
      if (this.signalingState === state) return;
      this.signalingState = state;
      if (state === 'stable') this.stableLocal = this.localDescription;
      this.fire('signalingstatechange');
      if (state === 'stable') this.queueNegotiation();
    }
    async setLocalDescription(description) {
      if (this.closed) throw domError('InvalidStateError', 'closed');
      if (description?.type === 'rollback') {
        if (this.signalingState !== 'have-local-offer') throw domError('InvalidStateError', 'nothing to roll back');
        this.world.record(this, 'setLocalDescription', { type: 'rollback' });
        this.localDescription = this.stableLocal;
        this.setSignaling('stable');
        return;
      }
      if (this.signalingState === 'have-remote-offer') {
        // An ICE restart by the offerer restarts the answerer's ICE too.
        const restart = this.localGeneration === 0 || this.answeredRemoteUfrag !== this.remoteUfrag;
        if (restart) this.localGeneration++;
        this.answeredRemoteUfrag = this.remoteUfrag;
        this.localDescription = { type: 'answer', sdp: sdpFor(this.localUfrag()) };
        this.world.record(this, 'setLocalDescription', { type: 'answer', ufrag: this.localUfrag() });
        this.sctpNegotiated = true;
        this.setSignaling('stable');
        if (restart) this.gather();
        this.world.evaluate(this);
        return;
      }
      const restart = this.localGeneration === 0 || this.iceRestartPending;
      if (restart) { this.localGeneration++; this.iceRestartPending = false; }
      this.localDescription = { type: 'offer', sdp: sdpFor(this.localUfrag()) };
      this.world.record(this, 'setLocalDescription', { type: 'offer', ufrag: this.localUfrag() });
      this.setSignaling('have-local-offer');
      if (restart) this.gather();
    }
    async setRemoteDescription(description) {
      if (this.closed) throw domError('InvalidStateError', 'closed');
      if (description.type === 'offer') {
        if (this.signalingState === 'have-local-offer') { this.localDescription = this.stableLocal; this.setSignaling('stable'); }
        this.remoteDescription = { type: 'offer', sdp: description.sdp };
        this.trackRemoteUfrag();
        this.world.record(this, 'setRemoteDescription', { type: 'offer', ufrag: this.remoteUfrag });
        this.setSignaling('have-remote-offer');
      } else {
        if (this.signalingState !== 'have-local-offer') throw domError('InvalidStateError', `answer in ${this.signalingState}`);
        this.remoteDescription = { type: 'answer', sdp: description.sdp };
        this.trackRemoteUfrag();
        this.world.record(this, 'setRemoteDescription', { type: 'answer', ufrag: this.remoteUfrag });
        this.sctpNegotiated = true;
        this.setSignaling('stable');
      }
      this.world.evaluate(this);
    }
    trackRemoteUfrag() {
      const ufrag = ufragOf(this.remoteDescription.sdp);
      if (ufrag !== this.remoteUfrag) { this.remoteUfrag = ufrag; this.remoteCandidates = []; }
    }
    async addIceCandidate(candidate) {
      if (this.closed) throw domError('InvalidStateError', 'closed');
      if (!this.remoteDescription) throw domError('InvalidStateError', 'no remote description');
      const text = candidate?.candidate ?? '';
      this.world.record(this, 'addIceCandidate', { candidate: text, ufrag: candidate?.usernameFragment ?? null });
      if (!candidate?.usernameFragment || candidate.usernameFragment === this.remoteUfrag) this.remoteCandidates.push(text);
      this.world.evaluate(this);
    }
    localUfrag() { return `${this.id}g${this.localGeneration}`; }
    // Host, then one srflx per STUN server, then one relay per TURN entry, then end of candidates.
    gather() {
      const generation = this.localGeneration, ufrag = this.localUfrag();
      // New ICE servers only matter once a gathering used them (setConfiguration alone gathers nothing).
      this.gatheredIceServers = [...this.config.iceServers];
      const list = this.world.candidatesFor(this);
      this.iceGatheringState = 'gathering';
      this.fire('icegatheringstatechange');
      list.forEach((entry, index) => setTimeout(() => {
        if (this.closed || generation !== this.localGeneration) return;
        if (entry.error) { this.fire('icecandidateerror', { url: entry.url, errorCode: 701, errorText: 'STUN host lookup failed' }); return; }
        const init = { candidate: entry.candidate, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: ufrag };
        this.fire('icecandidate', { candidate: { ...init, toJSON: () => ({ ...init }) } });
      }, entry.delay ?? 5 * (index + 1)));
      setTimeout(() => {
        if (this.closed || generation !== this.localGeneration) return;
        this.iceGatheringState = 'complete';
        this.fire('icecandidate', { candidate: null });
        this.fire('icegatheringstatechange');
      }, Math.max(0, ...list.map((entry, index) => entry.delay ?? 5 * (index + 1))) + 5);
    }
    async getStats() { return this.world.stats(this); }
    getTransceivers() { return []; }
    getSenders() { return []; }
    addTrack() { throw new Error('fake peer connection carries no media'); }
    removeTrack() {}
    setState(state) {
      if (this.closed || this.connectionState === state) return;
      this.connectionState = state;
      if (state === 'connected') this.channel?.open();
      this.fire('connectionstatechange');
    }
    close() {
      if (this.closed) return;
      this.closed = true; this.connectionState = 'closed'; this.signalingState = 'closed';
      clearTimeout(this.connectTimer); this.channel?.close();
      if (!this.probe) this.world.record(this, 'close');
    }
  };
}
