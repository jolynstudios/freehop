// SPDX-License-Identifier: Apache-2.0
// Relay review regressions: internal relay scope, canonical own addresses, per-room revocation with
// credential floors, UDP answer budgets, TCP teardown, router mapping lifetime and address classes.
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createTurnServer, classifyPeerAddress } from '../src/relay/turn-server.mjs';
import { startGateway, isPublicAddress } from '../src/relay/agent.mjs';
import { ATTR, CLASS, METHOD, decode, encode, getAttr, encodeXorAddress, decodeXorAddress, decodeErrorCode, longTermKey,
  encodeChannelData, decodeChannelData, frameStreamMessages } from '../src/shared/stun.mjs';

const USERS = { alice: 'alice-pass', bob: 'bob-pass', carol: 'carol-pass' };
const UDP_TRANSPORT = Buffer.from([17, 0, 0, 0]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what = 'condition', ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(5); }
}
const errorCode = res => res.cls === CLASS.ERROR ? decodeErrorCode(getAttr(res, ATTR.ERROR_CODE)).code : 0;
const ok = (res, what = '') => assert.equal(res.cls, CLASS.SUCCESS, `${what} expected success, got ${errorCode(res)}`);
const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
const xpa = (peer, tid) => ({ type: ATTR.XOR_PEER_ADDRESS, value: encodeXorAddress({ family: peer.address.includes(':') ? 6 : 4, address: peer.address, port: peer.port }, tid) });
const udpOf = server => server.addresses().find(a => a.transport === 'udp');
const tcpOf = server => server.addresses().find(a => a.transport === 'tcp');
let v6;
const ipv6 = () => v6 ??= new Promise(resolve => {
  const probe = dgram.createSocket('udp6');
  probe.once('error', () => resolve(false));
  probe.bind(0, '::1', () => { probe.close(); resolve(true); });
});

// Raw TURN client over UDP or TCP that follows 401/438 like a browser.
class Turn {
  constructor(target, { transport = 'udp', username, password, source = '127.0.0.1' } = {}) {
    Object.assign(this, { target, transport, username, password, source, realm: null, nonce: null, pending: new Map(), received: [], responses: [], rest: Buffer.alloc(0) });
  }
  async open() {
    if (this.transport === 'udp') {
      this.socket = dgram.createSocket(net.isIPv6(this.source) ? 'udp6' : 'udp4');
      this.socket.on('message', buf => this.onPacket(buf));
      await new Promise(r => this.socket.bind(0, this.source, r));
    } else {
      this.socket = net.connect(this.target.port, this.target.address);
      this.socket.on('error', () => {});
      await once(this.socket, 'connect');
      this.socket.on('data', chunk => { const f = frameStreamMessages(Buffer.concat([this.rest, chunk])); this.rest = Buffer.from(f.rest); f.messages.forEach(m => this.onPacket(m)); });
    }
    return this;
  }
  send(buf) { if (this.transport === 'udp') this.socket.send(buf, this.target.port, this.target.address); else this.socket.write(buf); }
  onPacket(buf) {
    if (buf[0] >= 0x40) { const cd = decodeChannelData(buf); this.received.push({ channel: cd.channel, data: Buffer.from(cd.data) }); return; }
    const msg = decode(buf);
    if (!msg) return;
    if (msg.cls === CLASS.INDICATION && msg.method === METHOD.DATA) {
      this.received.push({ peer: decodeXorAddress(getAttr(msg, ATTR.XOR_PEER_ADDRESS), msg.transactionId), data: Buffer.from(getAttr(msg, ATTR.DATA)) });
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
    return encode({ method, cls: CLASS.REQUEST, transactionId: tid, attributes: attrs }, { integrityKey: auth ? this.key : undefined });
  }
  answer(buf) { return new Promise(resolve => this.pending.set(buf.subarray(8, 20).toString('hex'), resolve)); }
  transact(buf, timeout = 3000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('STUN transaction timed out')), timeout);
      timer.unref();
      this.answer(buf).then(msg => { clearTimeout(timer); resolve(msg); });
      this.send(buf);
    });
  }
  async request(method, attributes = []) {
    let authed = !!this.nonce, res = await this.transact(this.build(method, attributes, { auth: authed }));
    for (let i = 0; i < 2 && (errorCode(res) === 438 || (errorCode(res) === 401 && !authed)); i++) {
      this.realm = getAttr(res, ATTR.REALM).toString(); this.nonce = getAttr(res, ATTR.NONCE).toString(); authed = true;
      res = await this.transact(this.build(method, attributes));
    }
    return res;
  }
  async allocate(extra = []) {
    const res = await this.request(METHOD.ALLOCATE, tid => [{ type: ATTR.REQUESTED_TRANSPORT, value: UDP_TRANSPORT }, ...(typeof extra === 'function' ? extra(tid) : extra)]);
    if (res.cls === CLASS.SUCCESS) this.relayed = decodeXorAddress(getAttr(res, ATTR.XOR_RELAYED_ADDRESS), res.transactionId);
    return res;
  }
  unauthenticatedAllocate() { this.send(this.build(METHOD.ALLOCATE, [{ type: ATTR.REQUESTED_TRANSPORT, value: UDP_TRANSPORT }], { auth: false })); }
  permit(...peers) { return this.request(METHOD.CREATE_PERMISSION, tid => peers.map(p => xpa(p, tid))); }
  bind(channel, peer) { return this.request(METHOD.CHANNEL_BIND, tid => [{ type: ATTR.CHANNEL_NUMBER, value: u32(channel * 0x10000) }, xpa(peer, tid)]); }
  refresh(lifetime) { return this.request(METHOD.REFRESH, lifetime === undefined ? [] : [{ type: ATTR.LIFETIME, value: u32(lifetime) }]); }
  sendTo(peer, data) {
    const tid = randomBytes(12);
    this.send(encode({ method: METHOD.SEND, cls: CLASS.INDICATION, transactionId: tid, attributes: [xpa(peer, tid), { type: ATTR.DATA, value: Buffer.from(data) }] }));
  }
  channelSend(channel, data) { this.send(encodeChannelData(channel, Buffer.from(data), { pad: this.transport !== 'udp' })); }
  close() { if (this.transport === 'udp') { try { this.socket.close(); } catch {} } else this.socket.destroy(); }
}
async function client(t, target, options) { const c = await new Turn(target, options).open(); t.after(() => c.close()); return c; }
const as = credentials => ({ username: credentials.username, password: credentials.credential });
async function turnServer(t, overrides = {}) {
  const server = await createTurnServer({ listen: [{ transport: 'udp', host: '127.0.0.1', port: 0 }, { transport: 'tcp', host: '127.0.0.1', port: 0 }],
    relayHost: '127.0.0.1', realm: 'review.test', authenticate: u => USERS[u] ?? null, ...overrides });
  t.after(() => server.close());
  return server;
}
async function gateway(t, options = {}) {
  const gw = await startGateway({ host: '127.0.0.1', port: 0, portMapping: false, externalAddress: '198.51.100.7', ...options });
  t.after(() => gw.close());
  return gw;
}
const closesWithin = (socket, ms) => Promise.race([once(socket, 'close'), sleep(ms).then(() => { throw new Error(`connection still open after ${ms} ms`); })]);

// ---- 1. relay only inside the session ----

test('internal peer scope: only the server\'s own relayed addresses are reachable, everything else gets 403', async t => {
  for (const allowPeer of [undefined, () => true]) {
    const server = await turnServer(t, { externalAddress: '203.0.113.10', peerScope: 'internal', allowPeer });
    const a = await client(t, udpOf(server), { username: 'alice', password: USERS.alice }), b = await client(t, udpOf(server), { username: 'bob', password: USERS.bob });
    ok(await a.allocate()); ok(await b.allocate());
    for (const address of ['198.51.100.20', '8.8.8.8', '1.1.1.1']) {
      assert.equal(errorCode(await a.permit({ address, port: 3478 })), 403, `CreatePermission ${address}`);
      assert.equal(errorCode(await a.bind(0x4000, { address, port: 3478 })), 403, `ChannelBind ${address}`);
    }
    // Two allocations on this server still exchange data, both ways and over channels.
    ok(await a.permit(b.relayed)); ok(await b.permit(a.relayed));
    a.sendTo(b.relayed, 'a->b');
    await waitFor(() => b.received.length === 1, 'internal Send');
    assert.deepEqual(b.received[0].peer, a.relayed);
    ok(await a.bind(0x4001, b.relayed)); ok(await b.bind(0x4002, a.relayed));
    a.channelSend(0x4001, 'cd a->b'); b.channelSend(0x4002, 'cd b->a');
    await waitFor(() => b.received.length === 2 && a.received.length === 1, 'internal ChannelData');
    assert.equal(server.stats().relayedInternally, 3);
    // Even an own address that allowPeer approves never leaves the process unless it is a relay.
    const listener = dgram.createSocket('udp4'), got = [];
    listener.on('message', m => got.push(m));
    await new Promise(r => listener.bind(0, '127.0.0.1', r));
    t.after(() => listener.close());
    const own = { address: '127.0.0.1', port: listener.address().port };
    if (allowPeer) {
      ok(await a.permit(own));
      const dropped = server.stats().droppedPolicy;
      a.sendTo(own, 'not a relay');
      await waitFor(() => server.stats().droppedPolicy === dropped + 1, 'own non-relay endpoint dropped');
      await sleep(30);
      assert.equal(got.length, 0);
    } else assert.equal(errorCode(await a.permit(own)), 403, 'loopback stays denied');
  }
  await assert.rejects(createTurnServer({ authenticate: () => null, peerScope: 'open' }), /peerScope/);
});

test('gateway relays only between its own allocations by default; relayScope public restores public peers', async t => {
  const tag = 'ScopeAAA' + 'x'.repeat(35);
  const gw = await gateway(t, { rooms: [tag] });
  assert.equal(gw.stats().relayScope, 'internal');
  const owner = await client(t, udpOf(gw.turn), as(gw.credentialsFor(tag, 'self'))), member = await client(t, udpOf(gw.turn), as(gw.credentialsFor(tag, 'member-b')));
  ok(await owner.allocate()); ok(await member.allocate());
  assert.equal(owner.relayed.address, '198.51.100.7');
  assert.equal(errorCode(await member.permit({ address: '203.0.113.50', port: 3478 })), 403, 'arbitrary public host');
  assert.equal(errorCode(await member.bind(0x4000, { address: '203.0.113.50', port: 3478 })), 403);
  ok(await member.permit(owner.relayed)); ok(await owner.permit(member.relayed));
  member.sendTo(owner.relayed, 'member->owner');
  await waitFor(() => owner.received.length === 1, 'relay to the owner');
  ok(await owner.bind(0x4001, member.relayed));
  owner.channelSend(0x4001, 'owner->member');
  await waitFor(() => member.received.length === 1, 'relay back');
  assert.equal(member.received[0].data.toString(), 'owner->member');

  const open = await gateway(t, { rooms: [tag], relayScope: 'public' });
  const legacy = await client(t, udpOf(open.turn), as(open.credentialsFor(tag, 'member')));
  ok(await legacy.allocate());
  ok(await legacy.permit({ address: '203.0.113.50', port: 3478 }), 'public scope');
  for (const address of ['192.0.0.2', '198.18.0.1']) assert.equal(errorCode(await legacy.permit({ address, port: 1 })), 403, address);
  await assert.rejects(startGateway({ host: '127.0.0.1', port: 0, portMapping: false, externalAddress: '198.51.100.7', relayScope: 'open' }), /relayScope/);
});

test('IPv4-embedding IPv6 spellings of the server\'s own address cannot leave the server', async t => {
  if (!await ipv6()) return t.skip('::1 unavailable');
  const v6 = [{ type: ATTR.REQUESTED_ADDRESS_FAMILY, value: Buffer.from([2, 0, 0, 0]) }];
  // Own public address 203.0.113.10: mapped, IPv4-translated and NAT64 forms are relay<->relay only.
  const server = await turnServer(t, { relayHost: ['127.0.0.1', '::1'], externalAddress: '203.0.113.10' });
  const c = await client(t, udpOf(server), { username: 'alice', password: USERS.alice });
  ok(await c.allocate(v6));
  assert.equal(c.relayed.family, 6);
  for (const address of ['::ffff:203.0.113.10', '::ffff:0:cb00:710a', '64:ff9b::cb00:710a']) {
    ok(await c.permit({ address, port: 9 }), address);
    const before = server.stats();
    c.sendTo({ address, port: 9 }, 'loop?');
    await waitFor(() => server.stats().droppedPolicy === before.droppedPolicy + 1, address);
    assert.equal(server.stats().bytesToPeers, before.bytesToPeers, address);
  }
  // Our own listener in another spelling is still a self endpoint, even when allowPeer approves it.
  const loose = await turnServer(t, { relayHost: ['127.0.0.1', '::1'], allowPeer: () => true });
  const d = await client(t, udpOf(loose), { username: 'bob', password: USERS.bob });
  ok(await d.allocate(v6));
  for (const address of ['::ffff:127.0.0.1', '::ffff:0:7f00:1']) {
    ok(await d.permit({ address, port: 1 }));
    const before = loose.stats();
    d.sendTo({ address, port: udpOf(loose).port }, 'loop?');
    await waitFor(() => loose.stats().droppedPolicy === before.droppedPolicy + 1, address);
    assert.equal(loose.stats().bytesToPeers, before.bytesToPeers, address);
  }
  // Internal scope: a NAT64 spelling of someone else's address is refused outright.
  const internal = await turnServer(t, { relayHost: ['127.0.0.1', '::1'], externalAddress: '203.0.113.10', peerScope: 'internal' });
  const e = await client(t, udpOf(internal), { username: 'carol', password: USERS.carol });
  ok(await e.allocate(v6));
  assert.equal(errorCode(await e.permit({ address: '64:ff9b::808:808', port: 53 })), 403);
  ok(await e.permit({ address: '::ffff:203.0.113.10', port: 9 }));
});

// ---- 2. per-room revocation and credential floors ----

test('a room that exhausts its own revocation table is revoked alone; other rooms keep allowRoom and credentials', async t => {
  const A = 'RoomAAAA' + 'x'.repeat(35), B = 'RoomBBBB' + 'y'.repeat(35), events = [];
  const gw = await gateway(t, { rooms: [A, B], log: event => events.push(event) });
  const a = await client(t, udpOf(gw.turn), as(gw.credentialsFor(A, 'member-a'))), b = await client(t, udpOf(gw.turn), as(gw.credentialsFor(B, 'member-b')));
  ok(await a.allocate()); ok(await b.allocate());
  // Ordinary departures in many rooms, together beyond the former 4096-entry global table.
  const busy = Array.from({ length: 20 }, (_, i) => `Busy${String(i).padStart(4, '0')}` + 'z'.repeat(35));
  for (const tag of busy) { gw.allowRoom(tag); for (let i = 0; i < 255; i++) gw.revokePeer(tag, `left-${i}`); }
  assert.equal(gw.stats().revocations, 20 * 255);
  assert.equal(events.includes('room-revocations-full'), false);
  // One member of room A invents departures until A's own table overflows.
  for (let i = 0; i < 300; i++) gw.revokePeer(A, `ghost-${i}`);
  assert.ok(events.includes('room-revocations-full'));
  assert.equal(gw.credentialsFor(A, 'member-a2'), null, 'room A is revoked');
  assert.equal(gw.turn.stats().allocations, 1, 'only room A lost its allocation');
  ok(await b.refresh(), 'room B keeps its relay');
  for (const tag of busy) assert.notEqual(gw.credentialsFor(tag, 'still-here'), null, tag);
  const C = 'RoomCCCC' + 'w'.repeat(35);
  gw.allowRoom(C);
  ok(await (await client(t, udpOf(gw.turn), as(gw.credentialsFor(C, 'member-c')))).allocate(), 'a new room is admitted');
  assert.ok(gw.stats().revocations <= 21 * 256);
  // Revocations for invalid labels or rooms that are not allowed cost no state.
  const before = gw.stats().revocations;
  gw.revokePeer(A, 'after-revocation'); gw.revokePeer(B, 'not:a-label'); gw.revokePeer('Unknown0' + 'q'.repeat(35), 'x');
  assert.equal(gw.stats().revocations, before);
});

test('re-allowing a revoked room never revives credentials issued before the revocation', async t => {
  const tag = 'ReviveAA' + 'x'.repeat(35);
  const gw = await gateway(t, { rooms: [tag] });
  const attempt = async credentials => {
    const c = await new Turn(udpOf(gw.turn), as(credentials)).open();
    try { return errorCode(await c.allocate()); } finally { c.close(); }
  };
  let previous = gw.credentialsFor(tag, 'peer');
  assert.equal(await attempt(previous), 0);
  // Revoke and re-allow repeatedly, usually within one second: one-second usernames still separate the epochs.
  for (let round = 0; round < 3; round++) {
    gw.revokeRoom(tag); gw.allowRoom(tag);
    const next = gw.credentialsFor(tag, 'peer');
    assert.ok(Number(next.username.split(':')[0]) > Number(previous.username.split(':')[0]), 'minted after the floor');
    assert.equal(await attempt(previous), 401, `round ${round}: older credential stays void`);
    assert.equal(await attempt(next), 0, `round ${round}: fresh credential works`);
    previous = next;
  }
  // The overflow path keeps the floor as well.
  for (let i = 0; i < 300; i++) gw.revokePeer(tag, `ghost-${i}`);
  assert.equal(gw.credentialsFor(tag, 'peer'), null);
  gw.allowRoom(tag);
  assert.equal(await attempt(previous), 401, 'overflow then re-allow does not revive');
  assert.equal(await attempt(gw.credentialsFor(tag, 'peer')), 0);
  assert.equal(gw.stats().floors, 1);
});

test('the floor table is bounded: when it is full the secret rotates instead of forgetting a floor', async t => {
  const keep = 'KeepAAAA' + 'x'.repeat(35), events = [];
  const gw = await gateway(t, { rooms: [keep], log: event => events.push(event) });
  const old = gw.credentialsFor(keep, 'peer');
  for (let i = 0; i <= 4096; i++) { const tag = `F${String(i).padStart(7, '0')}` + 'x'.repeat(35); gw.allowRoom(tag); gw.revokeRoom(tag); }
  assert.ok(events.includes('secret-rotated'));
  assert.ok(gw.stats().floors < 4096);
  const c = await client(t, udpOf(gw.turn), as(old));
  assert.equal(errorCode(await c.allocate()), 401, 'every outstanding credential was voided');
  ok(await (await client(t, udpOf(gw.turn), as(gw.credentialsFor(keep, 'peer')))).allocate());
});

// ---- 3. UDP answer budgets ----

test('a Binding flood cannot starve authentication challenges', async t => {
  const server = await turnServer(t, { limits: { udpResponseBurst: 3, udpResponseRate: 0, errorBurst: 100, errorRate: 0 } });
  const flood = await client(t, udpOf(server));
  for (let i = 0; i < 10; i++) flood.send(flood.build(METHOD.BINDING, [], { auth: false }));
  await waitFor(() => server.stats().bindings + server.stats().droppedErrorRate >= 10, 'flood accounted');
  assert.equal(server.stats().bindings, 3);
  const c = await client(t, udpOf(server), { username: 'alice', password: USERS.alice });
  ok(await c.allocate(), 'the 401 challenge still gets through');
});

test('recently authenticated sources skip the global budget but keep their own; unknown sources stay bounded', async t => {
  const hasV6 = await ipv6();
  const server = await turnServer(t, { listen: [{ transport: 'udp', host: '127.0.0.1', port: 0 }, ...(hasV6 ? [{ transport: 'udp', host: '::1', port: 0 }] : [])],
    limits: { udpResponseBurst: 2, udpResponseRate: 0, errorBurst: 6, errorRate: 0 } });
  const [v4, v6] = server.addresses();
  const legit = await client(t, v4, { username: 'alice', password: USERS.alice });
  ok(await legit.allocate()); // one challenge: global 2 -> 1, this source 6 -> 5; 127.0.0.1 is now trusted
  const again = await client(t, v4);
  for (let i = 0; i < 8; i++) again.unauthenticatedAllocate();
  await waitFor(() => again.responses.length === 5 && server.stats().droppedErrorRate === 3, 'only the per-source limit applies');
  if (!hasV6) return;
  const stranger = await client(t, v6, { source: '::1' });
  for (let i = 0; i < 5; i++) stranger.unauthenticatedAllocate();
  await waitFor(() => server.stats().droppedErrorRate === 7 && stranger.responses.length === 1, 'unknown source accounted');
  await sleep(30);
  assert.equal(stranger.responses.length, 1, 'an unknown source still draws on the bounded global bucket');
});

// ---- 4. TCP connections end with their allocation ----

test('a TCP allocation\'s connection closes when the allocation ends: Refresh 0, revocation, expiry', async t => {
  const server = await turnServer(t);
  const c = await client(t, tcpOf(server), { transport: 'tcp', username: 'alice', password: USERS.alice });
  ok(await c.allocate());
  const closed = closesWithin(c.socket, 3000);
  // Refresh 0 with an Allocate pipelined behind it: the deletion is answered, nothing after it runs.
  const del = c.build(METHOD.REFRESH, [{ type: ATTR.LIFETIME, value: u32(0) }]), again = c.build(METHOD.ALLOCATE, [{ type: ATTR.REQUESTED_TRANSPORT, value: UDP_TRANSPORT }]);
  const answered = c.answer(del);
  c.send(Buffer.concat([del, again]));
  const res = await answered;
  ok(res); assert.equal(getAttr(res, ATTR.LIFETIME).readUInt32BE(0), 0);
  await closed;
  assert.equal(c.responses.some(r => r.transactionId.equals(again.subarray(8, 20))), false);
  await waitFor(() => server.stats().tcpConnections === 0 && server.stats().allocations === 0, 'connection and allocation gone');

  const r = await client(t, tcpOf(server), { transport: 'tcp', username: 'bob', password: USERS.bob });
  ok(await r.allocate());
  const revoked = closesWithin(r.socket, 3000);
  assert.equal(server.revoke(u => u === 'bob'), 1);
  await revoked;

  const short = await turnServer(t, { limits: { defaultLifetime: 1, maxLifetime: 1 } });
  const e = await client(t, tcpOf(short), { transport: 'tcp', username: 'carol', password: USERS.carol });
  ok(await e.allocate());
  await closesWithin(e.socket, 4000);
  await waitFor(() => short.stats().tcpConnections === 0 && short.stats().allocations === 0, 'expired allocation and its connection gone');
});

// ---- 5. router mappings for relay ports ----

function fakeMapper() {
  let next = 40000;
  const f = { maps: [], unmapped: [], held: [], inflight: 0, peak: 0, holding: false };
  f.map = async ({ protocol, internalPort }) => {
    const m = { method: 'fake', protocol, internalPort, externalPort: next++, externalAddress: '203.0.113.7', externalAddressIsPrivate: false, at: Date.now() };
    f.maps.push(m); f.inflight++; f.peak = Math.max(f.peak, f.inflight);
    try { if (f.holding && internalPort !== 0) await new Promise(resolve => f.held.push(resolve)); } finally { f.inflight--; }
    return m;
  };
  f.unmap = async m => { f.unmapped.push(m); return true; };
  f.close = async () => {};
  f.release = () => { for (const resolve of f.held.splice(0)) resolve(); };
  return f;
}
const mapped = (t, options) => gateway(t, { portMapping: undefined, externalAddress: undefined, ...options });

test('mapRelayPort gets a signal that aborts once the mapping is no longer needed', async t => {
  const signals = [];
  let mode = 'ok';
  const server = await turnServer(t, { externalAddress: '203.0.113.10', limits: { hookTimeoutMs: 100 },
    mapRelayPort: (port, family, signal) => { signals.push(signal); return mode === 'ok' ? 41000 + signals.length : mode === 'bad' ? 'nope' : new Promise(() => {}); } });
  const a = await client(t, udpOf(server), { username: 'alice', password: USERS.alice });
  ok(await a.allocate());
  assert.equal(a.relayed.port, 41001);
  assert.equal(signals[0].aborted, false, 'held while the allocation lives');
  ok(await a.refresh(0));
  assert.equal(signals[0].aborted, true, 'allocation ended');
  mode = 'bad'; ok(await a.allocate());
  assert.equal(signals[1].aborted, true, 'unusable answer');
  mode = 'hang'; ok(await (await client(t, udpOf(server), { username: 'bob', password: USERS.bob })).allocate());
  assert.equal(signals[2].aborted, true, 'hook timed out');
});

test('internal scope needs no router mapping per allocation', async t => {
  const tag = 'NoMapAAA' + 'x'.repeat(35), mapper = fakeMapper();
  const gw = await mapped(t, { rooms: [tag], mapper });
  assert.equal(gw.info().external[0], '203.0.113.7');
  const a = await client(t, udpOf(gw.turn), as(gw.credentialsFor(tag, 'self'))), b = await client(t, udpOf(gw.turn), as(gw.credentialsFor(tag, 'member')));
  ok(await a.allocate()); ok(await b.allocate());
  assert.equal(mapper.maps.length, 2, 'listener ports only');
  ok(await a.permit(b.relayed)); ok(await b.permit(a.relayed));
  a.sendTo(b.relayed, 'internal');
  await waitFor(() => b.received.length === 1, 'relay without a relay-port mapping');
});

test('public scope: at most four router exchanges at a time, and each mapping lives exactly as long as its allocation', async t => {
  const tag = 'MapAAAAA' + 'x'.repeat(35), mapper = fakeMapper();
  const gw = await mapped(t, { rooms: [tag], mapper, relayScope: 'public' });
  const clients = [];
  for (let i = 0; i < 6; i++) clients.push(await client(t, udpOf(gw.turn), as(gw.credentialsFor(tag, `peer-${i}`))));
  mapper.holding = true;
  const results = Promise.all(clients.map(c => c.allocate()));
  await waitFor(() => mapper.held.length === 4, 'four exchanges in flight');
  await sleep(50);
  assert.equal(mapper.held.length, 4, 'the others wait');
  mapper.holding = false; mapper.release();
  for (const res of await results) ok(res);
  assert.equal(mapper.peak, 4);
  assert.ok(clients.every(c => c.relayed.port >= 40000 && c.relayed.address === '203.0.113.7'), 'mapped ports advertised');
  assert.equal(gw.stats().mappings.length, 8);
  for (const c of clients) ok(await c.refresh(0));
  await waitFor(() => mapper.unmapped.length === 6, 'released with their allocations');
  assert.equal(gw.stats().mappings.length, 2);

  // An Allocate aborted while its mapping is in flight releases the mapping when the router answers.
  mapper.holding = true;
  const leaver = await client(t, tcpOf(gw.turn), { transport: 'tcp', ...as(gw.credentialsFor(tag, 'leaver')) });
  leaver.allocate().catch(() => {});
  await waitFor(() => mapper.held.length === 1, 'mapping in flight');
  leaver.close();
  await waitFor(() => gw.turn.stats().tcpConnections === 0, 'connection gone');
  mapper.holding = false; mapper.release();
  await waitFor(() => mapper.unmapped.length === 7, 'aborted allocation released its mapping');
  assert.equal(gw.stats().mappings.length, 2);
  assert.equal(gw.turn.stats().allocations, 0);
});

test('public scope: relay-port router exchanges are rate limited as well (burst 16, then 8 per second)', async t => {
  const tag = 'RateAAAA' + 'x'.repeat(35), mapper = fakeMapper();
  const gw = await mapped(t, { rooms: [tag], mapper, relayScope: 'public' });
  const clients = [];
  for (let i = 0; i < 20; i++) clients.push(await client(t, udpOf(gw.turn), as(gw.credentialsFor(tag, `peer-${i}`))));
  for (const res of await Promise.all(clients.map(c => c.allocate()))) ok(res);
  const relays = mapper.maps.filter(m => m.internalPort !== 0);
  assert.equal(relays.length, 20);
  assert.ok(relays[19].at - relays[0].at >= 400, `the last four waited for tokens (${relays[19].at - relays[0].at} ms)`);
});

test('public scope: a mapping that arrives after the hook timed out is released at once', async t => {
  const tag = 'LateAAAA' + 'x'.repeat(35), mapper = fakeMapper();
  const gw = await mapped(t, { rooms: [tag], mapper, relayScope: 'public', limits: { hookTimeoutMs: 150 } });
  const c = await client(t, udpOf(gw.turn), as(gw.credentialsFor(tag, 'peer')));
  mapper.holding = true;
  ok(await c.allocate(), 'falls back to the local port');
  assert.equal(c.relayed.port, gw.turn.relayedAddresses()[0].internal.port);
  mapper.holding = false; mapper.release();
  await waitFor(() => mapper.unmapped.length === 1, 'late mapping released');
  assert.equal(gw.stats().mappings.length, 2);
});

// ---- 6. address classification ----

test('special-purpose IPv4, IPv4-translated and site-local IPv6 are classified; isPublicAddress agrees', () => {
  const expected = {
    '192.0.0.2': 'deny', '192.0.0.9': 'deny', '192.0.0.255': 'deny', '192.0.1.1': 'public',
    '198.18.0.1': 'private', '198.19.255.255': 'private', '198.17.255.255': 'public', '198.20.113.1': 'public',
    '::ffff:0:7f00:1': 'deny', '::ffff:0:a00:1': 'private', '::ffff:0:c000:2': 'deny', '::ffff:0:c612:1': 'private', '::ffff:0:808:808': 'public',
    '::ffff:192.0.0.2': 'deny', '64:ff9b::c000:9': 'deny', '64:ff9b::c612:1': 'private',
    'fec0::1': 'deny', 'feff::1': 'deny', 'fe80::1': 'deny', 'fc00::1': 'private', '2001:db8::1': 'public', '8.8.8.8': 'public', '0:0:0:0:0:0:0:1': 'deny'
  };
  for (const [address, kind] of Object.entries(expected)) {
    assert.equal(classifyPeerAddress(address), kind, address);
    assert.equal(isPublicAddress(address), kind === 'public', `isPublicAddress(${address})`);
  }
  for (const value of [Buffer.alloc(5), null, undefined, 'garbage']) { assert.equal(classifyPeerAddress(value), 'deny'); assert.equal(isPublicAddress(value), false); }
});
