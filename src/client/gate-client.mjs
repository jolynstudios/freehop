// SPDX-License-Identifier: Apache-2.0
// One connection to one gate. Gates are interchangeable mailboxes: a room uses several at
// once, reconnects each independently and never depends on any single one.
export class Emitter {
  #handlers = new Map();
  on(type, fn) { (this.#handlers.get(type) ?? this.#handlers.set(type, new Set()).get(type)).add(fn); return () => this.off(type, fn); }
  off(type, fn) { this.#handlers.get(type)?.delete(fn); }
  emit(type, detail) { for (const fn of [...(this.#handlers.get(type) ?? [])]) { try { fn(detail); } catch (error) { console.error(error); } } }
}

export class GateClient extends Emitter {
  constructor(url, { room, peer, auth, WebSocketImpl = globalThis.WebSocket, backoffMs = [500, 1000, 2000, 4000, 8000, 15000, 30000] } = {}) {
    super();
    Object.assign(this, { url, room, peer, auth, WebSocketImpl, backoffMs, pingMs: 30000 });
    this.state = 'idle'; this.attempt = 0; this.ws = null; this.closed = false; this.stun = [];
    this.counters = { sent: 0, received: 0, bytesOut: 0, bytesIn: 0, errors: 0, connects: 0 };
  }
  connect() {
    if (this.closed || this.ws) return;
    this.state = 'connecting';
    let ws;
    try { ws = new this.WebSocketImpl(this.url); } catch { this.#retry(); return; }
    this.ws = ws;
    ws.onopen = async () => {
      let auth;
      try { auth = typeof this.auth === 'function' ? await this.auth(this.url) : typeof this.auth === 'object' && this.auth ? this.auth[this.url] : this.auth; }
      catch { if (ws === this.ws) { this.counters.errors++; ws.close(); } return; }
      if (ws !== this.ws) return;
      this.#raw({ t: 'hello', v: 1, ...(auth ? { auth } : {}) });
    };
    ws.onmessage = event => {
      if (ws !== this.ws || typeof event.data !== 'string' || event.data.length > 65536) return;
      this.counters.bytesIn += event.data.length;
      let m; try { m = JSON.parse(event.data); } catch { return; }
      switch (m?.t) {
        case 'welcome':
          // STUN belongs to application configuration, never to an untrusted mailbox.
          this.stun = [];
          this.#raw({ t: 'join', room: this.room, peer: this.peer });
          break;
        case 'peers':
          if (m.room !== this.room || !Array.isArray(m.peers) || m.peers.length > 64) return;
          this.state = 'joined'; this.attempt = 0; this.joinAttempts = 0; this.counters.connects++;
          // Application-level keepalive: the gate drops sockets it has not heard from.
          clearInterval(this.pinger);
          this.pinger = setInterval(() => this.#raw({ t: 'ping' }), this.pingMs);
          this.emit('joined', { gate: this, peers: m.peers.filter(p => typeof p === 'string'), stun: this.stun });
          break;
        case 'peer': if (m.room === this.room) this.emit('peer', { gate: this, peer: m.peer, on: !!m.on }); break;
        case 'recv':
          if (m.room === this.room && typeof m.from === 'string' && typeof m.box === 'string' && m.box.length <= 49152) {
            this.counters.received++; this.emit('recv', { gate: this, from: m.from, box: m.box });
          }
          break;
        case 'error':
          this.counters.errors++; this.emit('gate-error', { gate: this, code: m.code });
          // After a network change the gate may still hold our previous socket for a moment.
          if (m.code === 'peer-taken' && this.state !== 'joined' && (this.joinAttempts = (this.joinAttempts ?? 0) + 1) <= 8) {
            setTimeout(() => { if (ws === this.ws && this.state !== 'joined') this.#raw({ t: 'join', room: this.room, peer: this.peer }); }, 1000 * this.joinAttempts);
          }
          break;
      }
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      clearInterval(this.pinger);
      this.ws = null; const was = this.state; this.state = 'idle';
      if (was === 'joined') this.emit('left', { gate: this });
      this.#retry();
    };
    ws.onerror = () => { this.counters.errors++; };
  }
  #retry() {
    if (this.closed) return;
    const delay = this.backoffMs[Math.min(this.attempt++, this.backoffMs.length - 1)];
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, delay * (0.75 + Math.random() / 2));
  }
  #raw(message) {
    if (this.ws?.readyState !== 1) return false;
    const text = JSON.stringify(message);
    this.ws.send(text); this.counters.bytesOut += text.length;
    return true;
  }
  send(to, box) {
    if (this.state !== 'joined') return false;
    const ok = this.#raw({ t: 'send', room: this.room, to, box });
    if (ok) this.counters.sent++;
    return ok;
  }
  close() {
    this.closed = true; clearTimeout(this.timer); clearInterval(this.pinger);
    const ws = this.ws; this.ws = null; this.state = 'closed';
    if (ws) { try { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'leave', room: this.room })); ws.close(1000); } catch {} }
  }
}
