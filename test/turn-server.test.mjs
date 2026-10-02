// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createTurnServer, classifyPeerAddress } from '../src/relay/turn-server.mjs';
import { ATTR, CLASS, METHOD, decode, encode, getAttr, encodeXorAddress, decodeXorAddress, decodeErrorCode, longTermKey, verifyIntegrity,
  verifyFingerprint, encodeChannelData, decodeChannelData, frameStreamMessages } from '../src/shared/stun.mjs';

const REALM = 'peerlane.test';
const USERS = { alice: 'alice-pass', bob: 'bob-pass', carol: 'carol-pass', dave: 'dave-pass' };
const UDP_TRANSPORT = Buffer.from([17, 0, 0, 0]);
// Test-only self-signed P-256 certificate for 127.0.0.1 (not a secret, valid until 2126).
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg5vHDs393eBtkb19C
N3fTj/UMADpLGpvjDi2VIZfz96ihRANCAAS7PXF9dabpEGQBPRRCbnkt6nz8LVjV
speh5mKnlLPoYrg4Q3IHmqk5ZnBvTafxWJAUXwKIQTFV5ngM9+uGIJM2
-----END PRIVATE KEY-----`;
const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBpDCCAUmgAwIBAgIUHVDl6tJi/IUN/vPqhsbgj2tvGmMwCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNcGVlcmxhbmUtdGVzdDAgFw0yNjEwMDEyMDQ4MjdaGA8yMTI2
MDkwNzIwNDgyN1owGDEWMBQGA1UEAwwNcGVlcmxhbmUtdGVzdDBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABLs9cX11pukQZAE9FEJueS3qfPwtWNWyl6HmYqeUs+hi
uDhDcgeaqTlmcG9Np/FYkBRfAohBMVXmeAz364YgkzajbzBtMB0GA1UdDgQWBBSU
gMM2lCH7AZI5MQEr/I0Z75NgwjAfBgNVHSMEGDAWgBSUgMM2lCH7AZI5MQEr/I0Z
75NgwjAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGHBH8AAAGCCWxvY2FsaG9z
dDAKBggqhkjOPQQDAgNJADBGAiEAjLRcktoJPwVjG5vmZAvngpBybc2a0d2KXYAo
i/YrXYgCIQDtC3zSN4/frr5r5oLzMFxn72g8vwQQp85vZT2BavMZVQ==
-----END CERTIFICATE-----`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what = 'condition', ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(5); }
}
const errorCode = res => res.cls === CLASS.ERROR ? decodeErrorCode(getAttr(res, ATTR.ERROR_CODE)).code : 0;
const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
const xpa = (peer, tid) => ({ type: ATTR.XOR_PEER_ADDRESS, value: encodeXorAddress({ family: peer.address.includes(':') ? 6 : 4, address: peer.address, port: peer.port }, tid) });
const ok = res => assert.equal(res.cls, CLASS.SUCCESS, `expected success, got ${errorCode(res)} ${decodeErrorCode(getAttr(res, ATTR.ERROR_CODE) ?? Buffer.alloc(4))?.reason ?? ''}`);

async function startServer(t, overrides = {}) {
  const events = [];
  const server = await createTurnServer({
    listen: [{ transport: 'udp', host: '127.0.0.1', port: 0 }, { transport: 'tcp', host: '127.0.0.1', port: 0 }],
    relayHost: '127.0.0.1', realm: REALM, authenticate: async username => USERS[username] ?? null, allowPeer: () => true,
    log: (event, details) => events.push({ event, ...details }), ...overrides,
  });
  server.events = events;
  t.after(() => server.close());
  return server;
}
const listenerOf = (server, transport) => server.addresses().find(a => a.transport === transport);

// Minimal raw TURN client: UDP, TCP or TLS; handles 401/438 like a browser does.
class TurnClient {
  constructor(server, { transport = 'udp', username = 'alice', password = USERS[username], fingerprint = false } = {}) {
    Object.assign(this, { server, transport, username, password, fingerprint, realm: null, nonce: null });
    this.pending = new Map(); this.received = []; this.responses = []; this.rest = Buffer.alloc(0);
  }
  async open() {
    const { address, port } = listenerOf(this.server, this.transport);
    this.target = { address, port };
    if (this.transport === 'udp') {
      this.socket = dgram.createSocket('udp4');
      this.socket.on('message', buf => this.onPacket(buf));
      await new Promise(r => this.socket.bind(0, '127.0.0.1', r));
      this.localPort = this.socket.address().port;
    } else {
      this.socket = this.transport === 'tls' ? tls.connect({ host: address, port, ca: TLS_CERT }) : net.connect(port, address);
      this.socket.on('error', () => {});
      await once(this.socket, this.transport === 'tls' ? 'secureConnect' : 'connect');
      this.localPort = this.socket.localPort;
      this.socket.on('data', chunk => {
        const f = frameStreamMessages(Buffer.concat([this.rest, chunk]));
        assert.equal(f.error, undefined);
        this.rest = Buffer.from(f.rest);
        f.messages.forEach(m => this.onPacket(m));
      });
    }
    return this;
  }
  send(buf) { if (this.transport === 'udp') this.socket.send(buf, this.target.port, this.target.address); else this.socket.write(buf); }
  onPacket(buf) {
    if (buf[0] >= 0x40) { const cd = decodeChannelData(buf); this.received.push({ channel: cd.channel, data: Buffer.from(cd.data), raw: buf }); return; }
    const msg = decode(buf);
    assert.ok(msg, 'server sent an undecodable message');
    if (msg.cls === CLASS.INDICATION && msg.method === METHOD.DATA) {
      this.received.push({ peer: decodeXorAddress(getAttr(msg, ATTR.XOR_PEER_ADDRESS), msg.transactionId), data: Buffer.from(getAttr(msg, ATTR.DATA)), msg });
      return;
    }
    this.responses.push(msg);
    const waiter = this.pending.get(msg.transactionId.toString('hex'));
    if (waiter) { this.pending.delete(msg.transactionId.toString('hex')); waiter(msg); }
  }
  get key() { return longTermKey(this.username, this.realm, this.password); }
  build(method, attributes = [], { auth = true, tid = randomBytes(12) } = {}) {
    const attrs = typeof attributes === 'function' ? attributes(tid) : [...attributes];
    if (auth) attrs.push({ type: ATTR.USERNAME, value: this.username }, { type: ATTR.REALM, value: this.realm }, { type: ATTR.NONCE, value: this.nonce });
    return encode({ method, cls: CLASS.REQUEST, transactionId: tid, attributes: attrs }, { integrityKey: auth ? this.key : undefined, fingerprint: this.fingerprint });
  }
  transact(buf, timeout = 3000) {
    const key = buf.subarray(8, 20).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(key); reject(new Error('STUN transaction timed out')); }, timeout);
      this.pending.set(key, msg => { clearTimeout(timer); resolve(msg); });
      this.send(buf);
    });
  }
  learn(res) { this.realm = getAttr(res, ATTR.REALM).toString(); this.nonce = getAttr(res, ATTR.NONCE).toString(); }
  async request(method, attributes = []) {
    let authed = !!this.nonce, res = await this.transact(this.build(method, attributes, { auth: authed }));
    for (let i = 0; i < 2 && (errorCode(res) === 438 || (errorCode(res) === 401 && !authed)); i++) {
      this.learn(res); authed = true;
      res = await this.transact(this.build(method, attributes));
    }
    // 400/401/438 and a 500 from a failed credential lookup precede authentication, so they carry no MESSAGE-INTEGRITY.
    if (res.cls === CLASS.SUCCESS || ![400, 401, 438, 500].includes(errorCode(res))) assert.equal(verifyIntegrity(res, this.key), true, 'authenticated response must carry valid MESSAGE-INTEGRITY');
    assert.equal(verifyFingerprint(res).valid, true);
    return res;
  }
  async allocate(extra = []) {
    const res = await this.request(METHOD.ALLOCATE, tid => [{ type: ATTR.REQUESTED_TRANSPORT, value: UDP_TRANSPORT }, ...(typeof extra === 'function' ? extra(tid) : extra)]);
    if (res.cls === CLASS.SUCCESS) {
      this.relayed = decodeXorAddress(getAttr(res, ATTR.XOR_RELAYED_ADDRESS), res.transactionId);
      this.mapped = decodeXorAddress(getAttr(res, ATTR.XOR_MAPPED_ADDRESS), res.transactionId);
      this.lifetime = getAttr(res, ATTR.LIFETIME).readUInt32BE(0);
    }
    return res;
  }
  permit(...peers) { return this.request(METHOD.CREATE_PERMISSION, tid => peers.map(p => xpa(p, tid))); }
  bind(channel, peer) { return this.request(METHOD.CHANNEL_BIND, tid => [{ type: ATTR.CHANNEL_NUMBER, value: u32(channel * 0x10000) }, xpa(peer, tid)]); }
  refresh(lifetime) { return this.request(METHOD.REFRESH, lifetime === undefined ? [] : [{ type: ATTR.LIFETIME, value: u32(lifetime) }]); }
  sendIndication(peer, data) {
    const tid = randomBytes(12);
    return encode({ method: METHOD.SEND, cls: CLASS.INDICATION, transactionId: tid, attributes: [xpa(peer, tid), { type: ATTR.DATA, value: data }] }, { fingerprint: this.fingerprint });
  }
  sendTo(peer, data) { this.send(this.sendIndication(peer, Buffer.from(data))); }
  channelSend(channel, data) { this.send(encodeChannelData(channel, Buffer.from(data), { pad: this.transport !== 'udp' })); }
  close() { if (this.transport === 'udp') { try { this.socket.close(); } catch {} } else this.socket.destroy(); }
}
async function client(t, server, opts) { const c = await new TurnClient(server, opts).open(); t.after(() => c.close()); return c; }
async function udpPeer(t, host = '127.0.0.1') {
  const socket = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4'), got = [];
  socket.on('message', (data, r) => got.push({ data, address: r.address, port: r.port }));
  await new Promise(r => socket.bind(0, host, r));
  t.after(() => { try { socket.close(); } catch {} });
  return { socket, got, address: host, port: socket.address().port, send: (data, to) => socket.send(Buffer.from(data), to.port, to.address) };
}
const bindUdp = (port, host) => new Promise((resolve, reject) => {
  const s = dgram.createSocket('udp4');
  s.once('error', e => { try { s.close(); } catch {} reject(e); });
  s.bind(port, host, () => resolve(s));
});

test('Binding answers with XOR-MAPPED-ADDRESS on UDP and TCP listeners', async t => {
  const server = await startServer(t);
  for (const transport of ['udp', 'tcp']) {
    const c = await client(t, server, { transport });
    const res = await c.transact(c.build(METHOD.BINDING, [], { auth: false }));
    assert.equal(res.cls, CLASS.SUCCESS);
    assert.deepEqual(decodeXorAddress(getAttr(res, ATTR.XOR_MAPPED_ADDRESS), res.transactionId), { family: 4, address: '127.0.0.1', port: c.localPort });
    assert.deepEqual(verifyFingerprint(res), { present: true, valid: true });
  }
  assert.equal(server.stats().bindings, 2);
});

test('401 challenge, then authenticated Allocate with XOR-RELAYED/XOR-MAPPED/LIFETIME', async t => {
  const server = await startServer(t);
  const c = await client(t, server);
  const challenge = await c.transact(c.build(METHOD.ALLOCATE, [{ type: ATTR.REQUESTED_TRANSPORT, value: UDP_TRANSPORT }], { auth: false }));
  assert.equal(errorCode(challenge), 401);
  assert.equal(getAttr(challenge, ATTR.REALM).toString(), REALM);
  assert.match(getAttr(challenge, ATTR.NONCE).toString(), /^[0-9a-f]{32}$/);
  assert.equal(getAttr(challenge, ATTR.MESSAGE_INTEGRITY), undefined);
  assert.equal(verifyFingerprint(challenge).valid, true);
  c.learn(challenge);
  const res = await c.transact(c.build(METHOD.ALLOCATE, [{ type: ATTR.REQUESTED_TRANSPORT, value: UDP_TRANSPORT }]));
  ok(res);
  assert.equal(verifyIntegrity(res, c.key), true);
  assert.equal(verifyFingerprint(res).valid, true);
  const relayed = decodeXorAddress(getAttr(res, ATTR.XOR_RELAYED_ADDRESS), res.transactionId);
  assert.equal(relayed.address, '127.0.0.1'); assert.ok(relayed.port > 0);
  assert.deepEqual(decodeXorAddress(getAttr(res, ATTR.XOR_MAPPED_ADDRESS), res.transactionId), { family: 4, address: '127.0.0.1', port: c.localPort });
  assert.equal(getAttr(res, ATTR.LIFETIME).readUInt32BE(0), 600);
  assert.equal(getAttr(res, ATTR.SOFTWARE).toString(), 'peerlane-turn');
  assert.equal(server.stats().allocations, 1);
  assert.deepEqual(server.relayedAddresses(), [{ internal: { address: '127.0.0.1', port: relayed.port }, external: { address: '127.0.0.1', port: relayed.port }, username: 'alice' }]);
  assert.ok(server.events.some(e => e.event === 'allocation' && e.username === 'alice'));
});

test('wrong password or unknown user gets 401 and counts authFailures', async t => {
  const server = await startServer(t);
  const wrong = await client(t, server, { username: 'alice', password: 'not-it' });
  assert.equal(errorCode(await wrong.allocate()), 401);
  assert.equal(server.stats().authFailures, 1);
  const unknown = await client(t, server, { username: 'mallory', password: 'x' });
  assert.equal(errorCode(await unknown.allocate()), 401);
  const s = server.stats();
  assert.equal(s.authFailures, 2); assert.equal(s.allocations, 0);
  assert.ok(server.events.filter(e => e.event === 'auth-failure').every(e => !('username' in e)), 'failed usernames are not logged');
});

test('stale and forged nonces get 438 with a fresh NONCE; the retry succeeds', async t => {
  const server = await startServer(t, { limits: { nonceLifetime: 1 } });
  const c = await client(t, server);
  c.learn(await c.transact(c.build(METHOD.ALLOCATE, [{ type: ATTR.REQUESTED_TRANSPORT, value: UDP_TRANSPORT }], { auth: false })));
  const old = c.nonce;
  await sleep(2100);
  const stale = await c.transact(c.build(METHOD.ALLOCATE, [{ type: ATTR.REQUESTED_TRANSPORT, value: UDP_TRANSPORT }]));
  assert.equal(errorCode(stale), 438);
  assert.equal(getAttr(stale, ATTR.MESSAGE_INTEGRITY), undefined);
  assert.notEqual(getAttr(stale, ATTR.NONCE).toString(), old);
  c.learn(stale);
  ok(await c.transact(c.build(METHOD.ALLOCATE, [{ type: ATTR.REQUESTED_TRANSPORT, value: UDP_TRANSPORT }])));
  c.nonce = 'f'.repeat(32);
  assert.equal(errorCode(await c.transact(c.build(METHOD.REFRESH))), 438);
  ok(await c.refresh()); // request() follows the 438 like browsers do
  assert.ok(server.stats().staleNonces >= 2);
});

test('CreatePermission + Send indication reach the peer from the relayed address, and back as Data indication', async t => {
  const server = await startServer(t);
  const c = await client(t, server);
  ok(await c.allocate());
  const peer = await udpPeer(t);
  ok(await c.permit(peer));
  c.sendTo(peer, 'to-peer');
  await waitFor(() => peer.got.length === 1, 'relayed datagram');
  assert.equal(peer.got[0].data.toString(), 'to-peer');
  assert.deepEqual({ address: peer.got[0].address, port: peer.got[0].port }, { address: c.relayed.address, port: c.relayed.port });
  peer.send('to-client', c.relayed);
  await waitFor(() => c.received.length === 1, 'data indication');
  assert.deepEqual(c.received[0].peer, { family: 4, address: '127.0.0.1', port: peer.port });
  assert.equal(c.received[0].data.toString(), 'to-client');
  assert.equal(verifyFingerprint(c.received[0].msg).present, false, 'no FINGERPRINT when the client sent none');
  const s = server.stats();
  assert.equal(s.bytesToPeers, 7); assert.equal(s.bytesFromPeers, 9); assert.equal(s.permissions, 1);
});

test('FINGERPRINT on Data indications mirrors the client', async t => {
  const server = await startServer(t);
  const c = await client(t, server, { fingerprint: true });
  ok(await c.allocate());
  const peer = await udpPeer(t);
  ok(await c.permit(peer));
  peer.send('x', c.relayed);
  await waitFor(() => c.received.length === 1, 'data indication');
  assert.deepEqual(verifyFingerprint(c.received[0].msg), { present: true, valid: true });
});

test('datagrams from peers without a permission (by IP) are dropped', async t => {
  const server = await startServer(t);
  const c = await client(t, server);
  ok(await c.allocate());
  const peer = await udpPeer(t);
  peer.send('no-permission', c.relayed);
  ok(await c.permit({ address: '192.0.2.1', port: 1 })); // some other IP
  peer.send('wrong-ip', c.relayed);
  await waitFor(() => server.stats().droppedNoPermission === 2, 'two drops');
  assert.equal(c.received.length, 0);
  ok(await c.permit({ address: '127.0.0.1', port: 9 })); // port is irrelevant for permissions
  peer.send('allowed', c.relayed);
  await waitFor(() => c.received.length === 1, 'permitted datagram');
  assert.equal(c.received[0].data.toString(), 'allowed');
  c.sendTo({ address: '198.51.100.1', port: 5 }, 'no-permission-out');
  await waitFor(() => server.stats().droppedNoPermission === 3, 'outbound drop');
});

test('ChannelBind then ChannelData in both directions (UDP, unpadded)', async t => {
  const server = await startServer(t);
  const c = await client(t, server);
  ok(await c.allocate());
  const peer = await udpPeer(t);
  ok(await c.bind(0x4000, peer));
  assert.equal(server.stats().channels, 1); assert.equal(server.stats().permissions, 1, 'ChannelBind installs a permission');
  c.channelSend(0x4000, 'cd-out');
  await waitFor(() => peer.got.length === 1, 'channel data at peer');
  assert.equal(peer.got[0].data.toString(), 'cd-out'); assert.equal(peer.got[0].port, c.relayed.port);
  peer.send('cd-in', c.relayed);
  await waitFor(() => c.received.length === 1, 'channel data at client');
  assert.equal(c.received[0].channel, 0x4000); assert.equal(c.received[0].data.toString(), 'cd-in'); assert.equal(c.received[0].raw.length, 9);
  c.channelSend(0x4001, 'unbound');
  await waitFor(() => server.stats().droppedNoChannel === 1, 'unbound channel drop');
});

test('ChannelBind validation and conflicts (RFC 8656 12.2)', async t => {
  const server = await startServer(t, { limits: { maxChannels: 2 } });
  const c = await client(t, server);
  ok(await c.allocate());
  const p1 = { address: '127.0.0.1', port: 40000 }, p2 = { address: '127.0.0.1', port: 40001 }, p3 = { address: '127.0.0.1', port: 40002 };
  assert.equal(errorCode(await c.bind(0x3fff, p1)), 400);
  assert.equal(errorCode(await c.bind(0x5000, p1)), 400);
  ok(await c.bind(0x4000, p1));
  assert.equal(errorCode(await c.bind(0x4000, p2)), 400, 'channel already bound to another peer');
  assert.equal(errorCode(await c.bind(0x4001, p1)), 400, 'peer already bound to another channel');
  ok(await c.bind(0x4000, p1)); // refresh
  ok(await c.bind(0x4001, p2));
  assert.equal(errorCode(await c.bind(0x4002, p3)), 508, 'maxChannels');
  assert.equal(errorCode(await c.request(METHOD.CHANNEL_BIND, [{ type: ATTR.CHANNEL_NUMBER, value: u32(0x4003 * 0x10000) }])), 400, 'missing peer');
  assert.equal(errorCode(await c.bind(0x4003, { address: '::1', port: 1 })), 443);
});

test('Refresh: lifetime clamping, LIFETIME 0 deletes the allocation and frees the port', async t => {
  const server = await startServer(t);
  const c = await client(t, server);
  ok(await c.allocate());
  const { port } = c.relayed;
  await assert.rejects(bindUdp(port, '127.0.0.1'), /EADDRINUSE/);
  assert.equal(getAttr(await c.refresh(30), ATTR.LIFETIME).readUInt32BE(0), 600, 'below default -> default');
  assert.equal(getAttr(await c.refresh(7200), ATTR.LIFETIME).readUInt32BE(0), 3600, 'above max -> max');
  const del = await c.refresh(0);
  ok(del); assert.equal(getAttr(del, ATTR.LIFETIME).readUInt32BE(0), 0);
  assert.equal(server.stats().allocations, 0);
  const probe = await bindUdp(port, '127.0.0.1');
  probe.close();
  assert.equal(errorCode(await c.refresh()), 437);
  ok(await c.allocate()); // the 5-tuple can allocate again
});

test('retransmitted Allocate gets the identical response; a new transaction gets 437', async t => {
  const server = await startServer(t);
  const c = await client(t, server);
  c.learn(await c.transact(c.build(METHOD.ALLOCATE, [{ type: ATTR.REQUESTED_TRANSPORT, value: UDP_TRANSPORT }], { auth: false })));
  const request = c.build(METHOD.ALLOCATE, [{ type: ATTR.REQUESTED_TRANSPORT, value: UDP_TRANSPORT }]);
  c.send(request); c.send(request); // burst: second copy arrives while the first is in flight
  const first = await c.transact(request);
  const second = await c.transact(request);
  ok(first);
  assert.deepEqual(second.raw, first.raw);
  await sleep(50);
  assert.ok(c.responses.filter(r => r.transactionId.equals(first.transactionId)).every(r => r.raw.equals(first.raw)));
  assert.equal(server.stats().allocations, 1); assert.ok(server.stats().retransmissions >= 1);
  assert.equal(errorCode(await c.allocate()), 437);
});

test('quotas: maxAllocationsPerUsername -> 486, maxAllocations -> 508', async t => {
  const server = await startServer(t, { limits: { maxAllocationsPerUsername: 2, maxAllocations: 3 } });
  for (let i = 0; i < 2; i++) ok(await (await client(t, server)).allocate());
  assert.equal(errorCode(await (await client(t, server)).allocate()), 486);
  ok(await (await client(t, server, { username: 'bob' })).allocate());
  assert.equal(errorCode(await (await client(t, server, { username: 'carol' })).allocate()), 508);
  assert.equal(server.stats().allocations, 3);
});

test('default peer policy: loopback always 403, private 403 unless allowPrivatePeers, allowPeer replaces it', async t => {
  const strict = await startServer(t, { allowPeer: undefined });
  const c = await client(t, strict);
  ok(await c.allocate());
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '100.64.0.1', '169.254.1.1', '0.1.2.3', '224.0.0.1', '255.255.255.255'])
    assert.equal(errorCode(await c.permit({ address, port: 1 })), 403, address);
  ok(await c.permit({ address: '8.8.8.8', port: 1 }));
  assert.equal(errorCode(await c.permit({ address: '8.8.8.8', port: 1 }, { address: '127.0.0.1', port: 1 })), 403, 'all-or-nothing');
  assert.equal(errorCode(await c.bind(0x4000, { address: '127.0.0.1', port: 5 })), 403);
  assert.ok(strict.stats().peersDenied >= 10);

  const lan = await startServer(t, { allowPeer: undefined, allowPrivatePeers: true });
  const d = await client(t, lan);
  ok(await d.allocate());
  ok(await d.permit({ address: '10.1.2.3', port: 1 }, { address: '192.168.1.1', port: 1 }));
  assert.equal(errorCode(await d.permit({ address: '127.0.0.1', port: 1 })), 403);

  const seen = [];
  const custom = await startServer(t, { allowPeer: (peer, info) => { seen.push([peer, info]); return peer.port !== 666; } });
  const e = await client(t, custom);
  ok(await e.allocate());
  ok(await e.permit({ address: '127.0.0.1', port: 1 }));
  assert.equal(errorCode(await e.permit({ address: '8.8.8.8', port: 666 })), 403);
  assert.deepEqual(seen[0], [{ family: 4, address: '127.0.0.1', port: 1 }, { username: 'alice' }]);

  assert.equal(classifyPeerAddress('::ffff:127.0.0.1'), 'deny');
  assert.equal(classifyPeerAddress('::ffff:10.0.0.1'), 'private');
  assert.equal(classifyPeerAddress('64:ff9b::a00:1'), 'private');
  assert.equal(classifyPeerAddress('::1'), 'deny');
  assert.equal(classifyPeerAddress('fe80::1'), 'deny');
  assert.equal(classifyPeerAddress('ff02::1'), 'deny');
  assert.equal(classifyPeerAddress('fd00::1'), 'private');
  assert.equal(classifyPeerAddress('2001:db8::1'), 'public');
  assert.equal(classifyPeerAddress('1.1.1.1'), 'public');
  assert.equal(classifyPeerAddress('garbage'), 'deny');
});

test('relaying to the server\'s own UDP listener is dropped even with allowPeer', async t => {
  const server = await startServer(t);
  const c = await client(t, server);
  ok(await c.allocate());
  const listener = listenerOf(server, 'udp');
  ok(await c.permit(listener));
  c.sendTo(listener, encode({ method: METHOD.BINDING, cls: CLASS.REQUEST }));
  await waitFor(() => server.stats().droppedPolicy === 1, 'self-loop drop');
  await sleep(50);
  assert.equal(server.stats().bindings, 0);
});

test('TCP: allocate, pipelined requests and data, padded ChannelData both ways', async t => {
  const server = await startServer(t);
  const c = await client(t, server, { transport: 'tcp' });
  ok(await c.allocate());
  assert.equal(c.mapped.port, c.localPort);
  const peer = await udpPeer(t);
  // CreatePermission and the Send that depends on it in one TCP write: processed in order
  const tid = randomBytes(12);
  c.send(Buffer.concat([c.build(METHOD.CREATE_PERMISSION, [xpa(peer, tid)], { tid }), c.sendIndication(peer, Buffer.from('after-permission'))]));
  await waitFor(() => peer.got.length === 1, 'pipelined send');
  assert.equal(peer.got[0].data.toString(), 'after-permission');
  ok(await c.bind(0x4001, peer));
  c.send(Buffer.concat([encodeChannelData(0x4001, Buffer.from('abcde'), { pad: true }), encodeChannelData(0x4001, Buffer.from('xyz'), { pad: true }),
    c.sendIndication(peer, Buffer.from('via-send'))]));
  await waitFor(() => peer.got.length === 4, 'three relayed frames');
  assert.deepEqual(peer.got.slice(1).map(g => g.data.toString()), ['abcde', 'xyz', 'via-send']);
  peer.send('12345', c.relayed); peer.send('1234', c.relayed);
  await waitFor(() => c.received.length === 2, 'channel data over TCP');
  assert.deepEqual(c.received.map(r => [r.channel, r.data.toString(), r.raw.length]), [[0x4001, '12345', 12], [0x4001, '1234', 8]]);
  c.close();
  await waitFor(() => server.stats().allocations === 0, 'allocation removed with the connection');
  assert.ok(server.events.some(e => e.event === 'allocation-deleted' && e.reason === 'connection-closed'));
});

test('TLS transport: allocate and relay', async t => {
  const server = await startServer(t, { listen: [{ transport: 'tls', host: '127.0.0.1', port: 0, key: TLS_KEY, cert: TLS_CERT }] });
  const c = await client(t, server, { transport: 'tls' });
  ok(await c.allocate());
  const peer = await udpPeer(t);
  ok(await c.bind(0x4abc, peer));
  c.channelSend(0x4abc, 'over-tls');
  await waitFor(() => peer.got.length === 1, 'tls relayed');
  peer.send('back', c.relayed);
  await waitFor(() => c.received.length === 1, 'tls channel data');
  assert.equal(c.received[0].data.toString(), 'back'); assert.equal(c.received[0].raw.length, 8);
});

test('relay↔relay on one server via advertised addresses the machine does not own (internal delivery)', async t => {
  const server = await startServer(t, { allowPeer: undefined, externalAddress: '203.0.113.10' }); // default policy
  const a = await client(t, server), b = await client(t, server, { username: 'bob' });
  ok(await a.allocate()); ok(await b.allocate());
  assert.equal(a.relayed.address, '203.0.113.10'); assert.equal(b.relayed.address, '203.0.113.10');
  const diag = server.relayedAddresses();
  assert.equal(diag.length, 2);
  for (const d of diag) { assert.equal(d.internal.address, '127.0.0.1'); assert.equal(d.external.address, '203.0.113.10'); }
  ok(await a.permit(b.relayed)); ok(await b.permit(a.relayed));
  a.sendTo(b.relayed, 'a->b');
  await waitFor(() => b.received.length === 1, 'internal data indication');
  assert.deepEqual(b.received[0].peer, a.relayed); assert.equal(b.received[0].data.toString(), 'a->b');
  ok(await a.bind(0x4000, b.relayed)); ok(await b.bind(0x4001, a.relayed));
  a.channelSend(0x4000, 'cd a->b'); b.channelSend(0x4001, 'cd b->a');
  await waitFor(() => b.received.length === 2 && a.received.length === 1, 'internal channel data');
  assert.deepEqual([b.received[1].channel, b.received[1].data.toString()], [0x4001, 'cd a->b']);
  assert.deepEqual([a.received[0].channel, a.received[0].data.toString()], [0x4000, 'cd b->a']);
  const before = server.stats();
  a.sendTo({ address: '203.0.113.10', port: 9 }, 'not a relay'); // own address, no allocation: never leaves the box
  await waitFor(() => server.stats().droppedPolicy === before.droppedPolicy + 1, 'own-address drop');
  assert.equal(server.stats().bytesToPeers, before.bytesToPeers);
  assert.equal(server.stats().relayedInternally, 3);
});

test('internal delivery also matches locally bound relayed addresses and enforces the target\'s permissions', async t => {
  let nextPort = 41000;
  const server = await startServer(t, { externalAddress: '203.0.113.10', mapRelayPort: async () => nextPort++ });
  const a = await client(t, server), b = await client(t, server, { username: 'bob' });
  ok(await a.allocate()); ok(await b.allocate());
  assert.deepEqual([a.relayed.port, b.relayed.port], [41000, 41001]);
  const bInternal = server.relayedAddresses().find(d => d.username === 'bob').internal;
  assert.equal(bInternal.address, '127.0.0.1'); assert.notEqual(bInternal.port, 41001);
  ok(await a.permit(bInternal));
  a.sendTo(bInternal, 'no permission at b');
  await waitFor(() => server.stats().droppedNoPermission === 1, 'target permission enforced');
  ok(await b.permit(a.relayed));
  a.sendTo(bInternal, 'to internal');
  ok(await a.permit(b.relayed));
  a.sendTo(b.relayed, 'to advertised');
  await waitFor(() => b.received.length === 2, 'both deliveries');
  assert.deepEqual(b.received.map(r => [r.peer.address, r.peer.port, r.data.toString()]),
    [['203.0.113.10', 41000, 'to internal'], ['203.0.113.10', 41000, 'to advertised']]);
  assert.equal(server.stats().relayedInternally, 3);
});

test('relay↔relay across two servers goes through real UDP sockets', async t => {
  const s1 = await startServer(t), s2 = await startServer(t);
  const a = await client(t, s1), b = await client(t, s2, { username: 'bob' });
  ok(await a.allocate()); ok(await b.allocate());
  ok(await a.permit(b.relayed)); ok(await b.permit(a.relayed));
  a.sendTo(b.relayed, 'kernel a->b');
  await waitFor(() => b.received.length === 1, 'cross-server data');
  assert.deepEqual(b.received[0].peer, a.relayed);
  ok(await a.bind(0x4000, b.relayed)); ok(await b.bind(0x4000, a.relayed));
  a.channelSend(0x4000, 'cd1'); b.channelSend(0x4000, 'cd2');
  await waitFor(() => b.received.length === 2 && a.received.length === 1, 'cross-server channel data');
  assert.equal(s1.stats().relayedInternally + s2.stats().relayedInternally, 0);
});

test('permissions and allocations expire', async t => {
  const server = await startServer(t, { limits: { permissionLifetime: 1, defaultLifetime: 2, maxLifetime: 2 } });
  const c = await client(t, server);
  ok(await c.allocate());
  assert.equal(c.lifetime, 2);
  const peer = await udpPeer(t);
  ok(await c.permit(peer));
  peer.send('early', c.relayed);
  await waitFor(() => c.received.length === 1, 'before expiry');
  await sleep(1100);
  peer.send('late', c.relayed);
  await waitFor(() => server.stats().droppedNoPermission === 1, 'permission expired');
  await waitFor(() => server.stats().allocations === 0, 'allocation expired', 4000);
  assert.ok(server.events.some(e => e.event === 'allocation-deleted' && e.reason === 'expired'));
});

test('token-bucket rate limits per allocation and globally', async t => {
  const server = await startServer(t, { limits: { allocationBitrate: 64_000 } }); // 8 kB/s, 8 kB burst
  const c = await client(t, server);
  ok(await c.allocate());
  const peer = await udpPeer(t);
  ok(await c.permit(peer));
  for (let i = 0; i < 40; i++) c.sendTo(peer, Buffer.alloc(1000, i));
  await waitFor(() => peer.got.length + server.stats().droppedRateLimited === 40, 'all sends accounted');
  assert.ok(peer.got.length >= 7 && peer.got.length <= 9, `delivered ${peer.got.length}`);
  for (let i = 0; i < 20; i++) peer.send(Buffer.alloc(1000), c.relayed); // other direction has its own bucket
  await waitFor(() => c.received.length + server.stats().droppedRateLimited === 20 + 40 - peer.got.length, 'downstream accounted');
  assert.ok(c.received.length >= 7 && c.received.length <= 9, `received ${c.received.length}`);

  const global = await startServer(t, { limits: { totalBitrate: 64_000 } });
  const g1 = await client(t, global), g2 = await client(t, global, { username: 'bob' });
  ok(await g1.allocate()); ok(await g2.allocate());
  ok(await g1.permit(peer)); ok(await g2.permit(peer));
  const before = peer.got.length;
  for (let i = 0; i < 20; i++) { g1.sendTo(peer, Buffer.alloc(500)); g2.sendTo(peer, Buffer.alloc(500)); }
  await waitFor(() => peer.got.length - before + global.stats().droppedRateLimited === 40, 'global accounted');
  assert.ok(peer.got.length - before <= 17, 'shared global bucket');
});

test('revoke() tears down matching allocations immediately (and their TCP connections)', async t => {
  const server = await startServer(t);
  const alice = await client(t, server), bob = await client(t, server, { username: 'bob' }), aliceTcp = await client(t, server, { transport: 'tcp' });
  ok(await alice.allocate()); ok(await bob.allocate()); ok(await aliceTcp.allocate());
  const closed = once(aliceTcp.socket, 'close');
  assert.equal(server.revoke(u => u === 'alice'), 2);
  await closed;
  assert.equal(server.stats().allocations, 1);
  assert.equal(errorCode(await alice.refresh()), 437);
  ok(await bob.refresh());
  assert.equal(server.revoke(() => { throw new Error('bad predicate'); }), 0);
});

test('Allocate error paths: 400, 420, 437, 440, 441, 442, 443, 508 and EVEN-PORT', async t => {
  const server = await startServer(t);
  const c = await client(t, server);
  assert.equal(errorCode(await c.request(METHOD.ALLOCATE, [])), 400, 'missing REQUESTED-TRANSPORT');
  assert.equal(errorCode(await c.request(METHOD.ALLOCATE, [{ type: ATTR.REQUESTED_TRANSPORT, value: Buffer.from([6, 0, 0, 0]) }])), 442);
  const unknown = await c.allocate([{ type: 0x7fff, value: Buffer.from('?') }]);
  assert.equal(errorCode(unknown), 420);
  assert.deepEqual(getAttr(unknown, ATTR.UNKNOWN_ATTRIBUTES), Buffer.from([0x7f, 0xff]));
  assert.equal(errorCode(await c.allocate([{ type: ATTR.REQUESTED_ADDRESS_FAMILY, value: Buffer.from([2, 0, 0, 0]) }])), 440, 'no IPv6 relay host');
  assert.equal(errorCode(await c.allocate([{ type: ATTR.REQUESTED_ADDRESS_FAMILY, value: Buffer.from([3, 0, 0, 0]) }])), 440);
  assert.equal(errorCode(await c.allocate([{ type: ATTR.RESERVATION_TOKEN, value: Buffer.alloc(8) }])), 508);
  assert.equal(errorCode(await c.allocate([{ type: ATTR.EVEN_PORT, value: Buffer.from([0x80]) }])), 508);
  assert.equal(errorCode(await c.allocate([{ type: ATTR.EVEN_PORT, value: Buffer.from([0]) }, { type: ATTR.RESERVATION_TOKEN, value: Buffer.alloc(8) }])), 400);
  assert.equal(errorCode(await c.refresh()), 437, 'no allocation yet');
  ok(await c.allocate([{ type: ATTR.EVEN_PORT, value: Buffer.from([0]) }, { type: ATTR.DONT_FRAGMENT, value: Buffer.alloc(0) }, { type: ATTR.LIFETIME, value: u32(0) }]));
  assert.equal(c.relayed.port % 2, 0, 'EVEN-PORT honoured');
  assert.equal(c.lifetime, 600);
  assert.equal(errorCode(await c.refresh(undefined)), 0);
  assert.equal(errorCode(await c.request(METHOD.REFRESH, [{ type: ATTR.REQUESTED_ADDRESS_FAMILY, value: Buffer.from([2, 0, 0, 0]) }])), 443);
  assert.equal(errorCode(await c.allocate()), 437, 'second Allocate on the same 5-tuple');
  Object.assign(c, { username: 'bob', password: USERS.bob });
  assert.equal(errorCode(await c.refresh()), 441, 'same 5-tuple, different user');
  assert.equal(errorCode(await c.request(0x0b, [])), 400, 'unsupported method');
});

test('IPv6 relayed addresses with REQUESTED-ADDRESS-FAMILY', async t => {
  const probe = dgram.createSocket('udp6');
  const hasIpv6 = await new Promise(r => { probe.once('error', () => r(false)); probe.bind(0, '::1', () => r(true)); });
  try { probe.close(); } catch {}
  if (!hasIpv6) return t.skip('::1 unavailable');
  const server = await startServer(t, { relayHost: ['127.0.0.1', '::1'] });
  const c = await client(t, server);
  ok(await c.allocate([{ type: ATTR.REQUESTED_ADDRESS_FAMILY, value: Buffer.from([2, 0, 0, 0]) }]));
  assert.equal(c.relayed.family, 6); assert.equal(c.relayed.address, '::1');
  const peer = await udpPeer(t, '::1');
  assert.equal(errorCode(await c.permit({ address: '127.0.0.1', port: 1 })), 443);
  ok(await c.permit(peer));
  c.sendTo(peer, 'v6 out');
  await waitFor(() => peer.got.length === 1, 'ipv6 relay out');
  assert.equal(peer.got[0].address, '::1'); assert.equal(peer.got[0].port, c.relayed.port);
  peer.send('v6 in', c.relayed);
  await waitFor(() => c.received.length === 1, 'ipv6 relay in');
  assert.deepEqual(c.received[0].peer, { family: 6, address: '::1', port: peer.port });
  const v4 = await client(t, server, { username: 'bob' });
  ok(await v4.allocate());
  assert.equal(v4.relayed.family, 4);
});

test('relayPortRange confines relayed ports; exhaustion -> 508; EVEN-PORT inside the range; software: null', async t => {
  let base;
  for (let attempt = 0; attempt < 20 && base === undefined; attempt++) { // find 3 free consecutive ports starting even
    const b = 40000 + 2 * Math.floor(Math.random() * 10000), probes = [];
    try { for (let p = b; p < b + 3; p++) probes.push(await bindUdp(p, '127.0.0.1')); base = b; } catch {} finally { probes.forEach(s => s.close()); }
  }
  assert.ok(base, 'no free port range found');
  const server = await startServer(t, { relayPortRange: [base, base + 2], software: null });
  const ports = [];
  for (let i = 0; i < 3; i++) {
    const c = await client(t, server, { username: ['alice', 'bob', 'carol'][i] });
    const res = await c.allocate(i === 0 ? [{ type: ATTR.EVEN_PORT, value: Buffer.from([0]) }] : []);
    ok(res); ports.push(c.relayed.port);
    assert.equal(getAttr(res, ATTR.SOFTWARE), undefined);
  }
  assert.equal(ports[0] % 2, 0);
  assert.deepEqual([...ports].sort(), [base, base + 1, base + 2]);
  assert.equal(errorCode(await (await client(t, server, { username: 'dave' })).allocate()), 508);
});

test('hung authenticate/mapRelayPort hooks time out instead of wedging requests or streams', async t => {
  let hang = true;
  const server = await startServer(t, { limits: { hookTimeoutMs: 200 }, authenticate: u => (hang ? new Promise(() => {}) : USERS[u] ?? null),
    mapRelayPort: () => new Promise(() => {}) });
  const c = await client(t, server, { transport: 'tcp' });
  const started = Date.now();
  assert.equal(errorCode(await c.allocate()), 500);
  assert.ok(Date.now() - started >= 190);
  hang = false;
  ok(await c.allocate()); // same TCP connection keeps working; port mapping fell back to the local port
  assert.equal(c.relayed.port, server.relayedAddresses()[0].internal.port);
  assert.ok(server.events.some(e => e.event === 'map-port-error'));
});

test('TCP connection limit and idle timeout', async t => {
  const server = await startServer(t, { limits: { maxTcpConnections: 2, tcpIdleMs: 300 } });
  const { port } = listenerOf(server, 'tcp');
  const closes = [], started = Date.now();
  for (let i = 0; i < 3; i++) {
    const s = net.connect(port, '127.0.0.1'); s.on('error', () => {}); t.after(() => s.destroy());
    closes.push(once(s, 'close').then(() => Date.now() - started));
    await once(s, 'connect'); await sleep(20);
  }
  const rejectedAfter = await closes[2];
  assert.equal(server.stats().tcpRejected, 1);
  assert.ok(rejectedAfter < 250, `rejected connection closed after ${rejectedAfter} ms`);
  const idleAfter = await Promise.all(closes.slice(0, 2));
  assert.ok(idleAfter.every(ms => ms >= 280), `idle connections closed after ${idleAfter} ms`);
  assert.equal(server.stats().tcpIdleClosed, 2);
  const c = await client(t, server, { transport: 'tcp' });
  ok(await c.allocate());
  await sleep(500);
  assert.equal(c.socket.destroyed, false, 'connections carrying an allocation are not idle-closed');
});

test('hostile datagrams and streams never take the server down', async t => {
  const server = await startServer(t);
  const c = await client(t, server);
  ok(await c.allocate());
  const valid = [c.build(METHOD.ALLOCATE, [{ type: ATTR.REQUESTED_TRANSPORT, value: UDP_TRANSPORT }]), c.build(METHOD.REFRESH),
    c.sendIndication({ address: '127.0.0.1', port: 9 }, Buffer.from('x')), encodeChannelData(0x4000, Buffer.from('abc'))];
  const fuzz = dgram.createSocket('udp4');
  await new Promise(r => fuzz.bind(0, '127.0.0.1', r));
  t.after(() => fuzz.close());
  const { port } = listenerOf(server, 'udp');
  for (let i = 0; i < 3000; i++) {
    let buf;
    if (i % 3 === 0) buf = randomBytes(1 + (i % 200));
    else { buf = Buffer.from(valid[i % valid.length]); for (let k = 0; k < 3; k++) buf[(i * 7 + k * 13) % buf.length] ^= 1 << (i % 8); }
    if (i % 5 === 0) buf = buf.subarray(0, i % buf.length);
    if (buf.length) fuzz.send(buf, port, '127.0.0.1');
    if (i % 200 === 0) await sleep(2);
  }
  const tcpPort = listenerOf(server, 'tcp').port;
  // Unframeable input: the server closes the connection by itself.
  for (const payload of [Buffer.from([0x00, 0x01, 0x00, 0x03]), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from([0x00, 0x01, 0xff, 0xfc, 1, 2, 3, 4])]) {
    const s = net.connect(tcpPort, '127.0.0.1'); s.on('error', () => {});
    const closed = once(s, 'close');
    await once(s, 'connect'); s.write(payload); await closed;
  }
  // Random bytes may be a legal prefix of a longer frame; half-close and let the server finish.
  for (let i = 0; i < 20; i++) {
    const s = net.connect(tcpPort, '127.0.0.1'); s.on('error', () => {});
    const closed = once(s, 'close');
    await once(s, 'connect'); s.end(randomBytes(1 + i * 9)); await closed;
  }
  await sleep(100);
  const after = await client(t, server, { username: 'bob' });
  ok(await after.allocate());
  ok(await c.refresh());
  const s = server.stats();
  assert.equal(s.errors, 0); assert.ok(s.malformed > 0);
});

test('close() releases every handle: a child process exits on its own', async () => {
  const serverUrl = new URL('../src/relay/turn-server.mjs', import.meta.url).href, stunUrl = new URL('../src/shared/stun.mjs', import.meta.url).href;
  const script = `
    import dgram from 'node:dgram'; import net from 'node:net';
    import { createTurnServer } from ${JSON.stringify(serverUrl)};
    import { ATTR, CLASS, METHOD, encode, decode, getAttr, longTermKey, encodeXorAddress, encodeChannelData } from ${JSON.stringify(stunUrl)};
    const server = await createTurnServer({ listen: [{ transport: 'udp', host: '127.0.0.1', port: 0 }, { transport: 'tcp', host: '127.0.0.1', port: 0 },
      { transport: 'tls', host: '127.0.0.1', port: 0, key: ${JSON.stringify(TLS_KEY)}, cert: ${JSON.stringify(TLS_CERT)} }],
      relayHost: '127.0.0.1', realm: 'r', authenticate: async () => 'p', allowPeer: () => true });
    const [udp, tcp, tlsl] = server.addresses();
    const s = dgram.createSocket('udp4'); await new Promise(r => s.bind(0, '127.0.0.1', r));
    const ask = buf => new Promise(r => { s.once('message', m => r(decode(m))); s.send(buf, udp.port, '127.0.0.1'); });
    const req = (method, attrs, nonce) => encode({ method, cls: CLASS.REQUEST, transactionId: Buffer.from('0123456789ab'), attributes: [...attrs, ...(nonce ? [
      { type: ATTR.USERNAME, value: 'u' }, { type: ATTR.REALM, value: 'r' }, { type: ATTR.NONCE, value: nonce }] : [])] }, nonce ? { integrityKey: longTermKey('u', 'r', 'p') } : {});
    const nonce = getAttr(await ask(req(METHOD.ALLOCATE, [{ type: ATTR.REQUESTED_TRANSPORT, value: Buffer.from([17, 0, 0, 0]) }])), ATTR.NONCE);
    const res = await ask(req(METHOD.ALLOCATE, [{ type: ATTR.REQUESTED_TRANSPORT, value: Buffer.from([17, 0, 0, 0]) }], nonce));
    if (res.cls !== CLASS.SUCCESS) throw new Error('allocate failed');
    const peer = { family: 4, address: '127.0.0.1', port: 9 }, tid = Buffer.from('ba9876543210');
    const bound = await ask(encode({ method: METHOD.CHANNEL_BIND, cls: CLASS.REQUEST, transactionId: tid, attributes: [
      { type: ATTR.CHANNEL_NUMBER, value: Buffer.from([0x40, 0, 0, 0]) }, { type: ATTR.XOR_PEER_ADDRESS, value: encodeXorAddress(peer, tid) },
      { type: ATTR.USERNAME, value: 'u' }, { type: ATTR.REALM, value: 'r' }, { type: ATTR.NONCE, value: nonce }] }, { integrityKey: longTermKey('u', 'r', 'p') }));
    if (bound.cls !== CLASS.SUCCESS) throw new Error('channel bind failed');
    s.send(encodeChannelData(0x4000, Buffer.from('x')), udp.port, '127.0.0.1');
    const idle = net.connect(tcp.port, '127.0.0.1'); idle.on('error', () => {}); await new Promise(r => idle.on('connect', r));
    const handshaking = net.connect(tlsl.port, '127.0.0.1'); handshaking.on('error', () => {}); await new Promise(r => handshaking.on('connect', r));
    await new Promise(r => setTimeout(r, 50));
    await server.close();
    s.close();
    console.log('closed ' + JSON.stringify(server.stats()));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  const [code, signal] = await once(child, 'exit');
  clearTimeout(timer);
  assert.equal(signal, null, `child hung after close(): ${out}`);
  assert.equal(code, 0, out);
  assert.match(out, /^closed /m);
  assert.equal(JSON.parse(out.slice(out.indexOf('{'))).allocations, 0);
});

test('unauthenticated TURN Binding answers obey both per-source and global UDP budgets', async t => {
  for (const limits of [{errorBurst: 2, errorRate: 0}, {errorBurst: 100, udpResponseBurst: 2, udpResponseRate: 0}]) {
    const server = await startServer(t, {limits});
    const client = await new TurnClient(server).open();
    try {
      for (let i = 0; i < 10; i++) client.send(client.build(METHOD.BINDING, [], {auth: false}));
      await waitFor(() => server.stats().bindings + server.stats().droppedErrorRate >= 10);
      await waitFor(() => client.responses.length === 2);
      assert.equal(server.stats().bindings, 2);
      assert.equal(server.stats().droppedErrorRate, 8);
    } finally {client.close();}
  }
});
