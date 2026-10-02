// SPDX-License-Identifier: Apache-2.0
// Regressions for the client, SDK, host-member and Electron findings of claude-security-review.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Room, join} from '../src/client/room.mjs';
import {deriveRoom, randomId, seal} from '../src/client/crypto.mjs';
import {validIceUrl} from '../src/client/ice-urls.mjs';
import {createAuthority} from '../src/sdk/authority.mjs';
import {connect} from '../src/sdk/client.mjs';
import {joinAsGateway} from '../src/relay/member.mjs';
import {installFreehopGateway} from '../src/electron/main.mjs';

const gate = 'wss://operator.example/gate';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 2000) {for (let i = 0; i < ms / 5; i++) {if (await fn()) return; await wait(5);} assert.ok(await fn(), 'condition timed out');}
class Socket {
  static all = [];
  readyState = 1; sent = [];
  constructor(url) {this.url = url; Socket.all.push(this);}
  send(text) {this.sent.push(JSON.parse(text));}
  close() {if (this.readyState === 3) return; this.readyState = 3; this.onclose?.();}
  receive(value) {this.onmessage({data: JSON.stringify(value)});}
}
const fakeGateway = () => {
  const calls = {allow: [], revokeRoom: [], revokePeer: []};
  return {calls, info: () => ({urls: ['turn:relay.example:3478'], ttlSeconds: 7200}),
    allowRoom(tag) {calls.allow.push(tag);}, revokeRoom(tag) {calls.revokeRoom.push(tag);}, revokePeer(tag, peer) {calls.revokePeer.push(peer); return 0;},
    credentialsFor: (tag, peer) => ({username: `${Math.floor(Date.now() / 1000) + 7200}:${tag.slice(0, 8)}:${peer}`, credential: 'test'})};
};

test('a departure from an id that never received credentials revokes nothing on the gateway', async t => {
  const secret = randomId(32), crypto = await deriveRoom(secret, 'review'), gateway = fakeGateway();
  const m = await joinAsGateway({gates: [gate], secret, app: 'review', gateway, departGraceMs: 20, WebSocketImpl: Socket});
  t.after(() => m.close());
  const socket = Socket.all.at(-1);
  socket.receive({t: 'peers', room: crypto.tag, peers: []});
  for (let i = 0; i < 50; i++) {
    const alias = randomId();
    socket.receive({t: 'recv', room: crypto.tag, from: alias, box: await seal(crypto, alias, m.id, {kind: 'bye', n: 1})});
  }
  await wait(30);
  assert.equal(gateway.calls.revokePeer.length, 0, 'made-up ids must not fill the revocation table');
  const member = randomId();
  socket.receive({t: 'recv', room: crypto.tag, from: member, box: await seal(crypto, member, m.id, {kind: 'caps', n: 1})});
  await until(() => socket.sent.some(f => f.t === 'send' && f.to === member));
  socket.receive({t: 'recv', room: crypto.tag, from: member, box: await seal(crypto, member, m.id, {kind: 'bye', n: 2})});
  await until(() => gateway.calls.revokePeer.includes(member));
  assert.deepEqual(gateway.calls.revokePeer, [member]);
});

test('a refused new room keeps the old epoch serving, and the same rotation can be retried', async t => {
  const secret = randomId(32), next = randomId(32), gateway = fakeGateway();
  const oldTag = (await deriveRoom(secret, 'review')).tag, newTag = (await deriveRoom(next, 'review')).tag;
  let refuse = 1;
  const allow = gateway.allowRoom;
  gateway.allowRoom = tag => {if (tag === newTag && refuse-- > 0) throw new Error('transient refusal'); allow.call(gateway, tag);};
  const m = await joinAsGateway({gates: [gate], secret, app: 'review', gateway, WebSocketImpl: Socket});
  t.after(() => m.close());
  const before = Socket.all.at(-1);
  await assert.rejects(m.rekey(next, {}), /transient refusal/);
  assert.equal(before.readyState, 1, 'the old gate connection stays up');
  assert.deepEqual(gateway.calls.revokeRoom, [], 'nothing is revoked when the new room is refused');
  await m.rekey(next, {});
  assert.deepEqual(gateway.calls.revokeRoom, [oldTag]);
  assert.equal(before.readyState, 3);
  assert.ok(gateway.calls.allow.includes(newTag));
  assert.notEqual(Socket.all.at(-1), before, 'a new gate connection serves the new room');

  // At room capacity the old epoch's slot is released first, then the new room is admitted.
  const third = randomId(32), thirdTag = (await deriveRoom(third, 'review')).tag;
  let full = true;
  gateway.allowRoom = tag => {if (tag === thirdTag && full) {full = false; throw new Error('Gateway room capacity reached');} allow.call(gateway, tag);};
  await m.rekey(third, {});
  assert.ok(gateway.calls.revokeRoom.includes(newTag) && gateway.calls.allow.includes(thirdTag));
});

test('the host greets authenticated peers again after its own gate reconnects', async t => {
  const secret = randomId(32), crypto = await deriveRoom(secret, 'review'), gateway = fakeGateway();
  const m = await joinAsGateway({gates: [gate], secret, app: 'review', gateway, departGraceMs: 20, WebSocketImpl: Socket});
  t.after(() => m.close());
  const first = Socket.all.at(-1);
  first.receive({t: 'peers', room: crypto.tag, peers: []});
  const peer = randomId();
  first.receive({t: 'recv', room: crypto.tag, from: peer, box: await seal(crypto, peer, m.id, {kind: 'caps', n: 1})});
  await until(() => first.sent.some(f => f.t === 'send' && f.to === peer));
  first.close();                                   // our own gate drops; the client stays on it
  await until(() => Socket.all.at(-1) !== first);  // reconnect (backoff)
  await until(() => m.stats().peers === 0);        // the sweep forgot the peer meanwhile
  const second = Socket.all.at(-1);
  second.receive({t: 'peers', room: crypto.tag, peers: [peer, randomId()]});
  await until(() => second.sent.some(f => f.t === 'send' && f.to === peer));
  assert.equal(m.stats().peers, 1, 'only the previously authenticated peer is restored');
});

test('leaving releases the room on the desktop gateway; a failed revocation never blocks a rotation', async () => {
  const authority = createAuthority({app: 'review', gates: [gate]}); await authority.openRoom('room');
  const ticket = await authority.ticket('room', 'alice'); await authority.ticket('room', 'bob');
  const revoked = []; let failNext = true;
  const desktop = {
    info: async () => ({urls: ['turn:203.0.113.9:3478?transport=udp'], ttlSeconds: 7200, external: ['203.0.113.9'], internal: '10.0.0.2'}),
    credentialsFor: async (tag, peer) => ({username: `${Math.floor(Date.now() / 1000) + 7200}:${tag.slice(0, 8)}:${peer}`, credential: 'c'}),
    allowRoom: async () => {}, revokePeer: async () => {},
    revokeRoom: async tag => {if (failNext) {failNext = false; throw new Error('ipc failed');} revoked.push(tag);}
  };
  const session = await connect(ticket, {WebSocket: Socket, media: {getTracks: () => []}, desktopGateway: desktop});
  const oldTag = session.tag;
  const {tickets} = await authority.kick('room', 'bob');
  assert.equal(await session.update(tickets.get('alice')), true, 'the rotation proceeds although the IPC failed');
  assert.notEqual(session.tag, oldTag);
  const newTag = session.tag;
  await session.leave();
  assert.ok(revoked.includes(newTag), 'leave releases the current room');
  assert.ok(revoked.includes(oldTag), 'leave retries the old room whose revocation failed');
});

test('an explicit gateway option never sends grants to the desktop gateway', async () => {
  const authority = createAuthority({app: 'review', gates: [gate]}); await authority.openRoom('room');
  const ticket = await authority.ticket('room', 'alice');
  let touched = 0;
  const desktop = {info: async () => { touched++; return null; }, credentialsFor: async () => null, allowRoom: async () => { touched++; }, revokeRoom: async () => { touched++; }};
  const own = {info: () => ({urls: ['turn:203.0.113.10:3478'], ttlSeconds: 7200}), credentialsFor: () => ({username: 'u', credential: 'c'})};
  const session = await connect(ticket, {WebSocket: Socket, media: {getTracks: () => []}, gateway: own, desktopGateway: desktop});
  await session.leave();
  assert.equal(touched, 0);
});

test('refresh applies reissued gate tokens for the same epoch at the next connect', async () => {
  const authority = createAuthority({app: 'review', gates: [gate]}); await authority.openRoom('room');
  const ticket = {...await authority.ticket('room', 'alice'), auth: 'old-token'};
  const session = await connect(ticket, {WebSocket: Socket, media: {getTracks: () => []}});
  try {
    assert.equal(await session.refresh({...ticket, auth: 'new-token', expires: ticket.expires}), false, 'not newer');
    assert.equal(await session.refresh({...ticket, epoch: ticket.epoch + 1, auth: 'x', expires: ticket.expires + 60}), false, 'other epoch');
    assert.equal(await session.refresh({...ticket, auth: 'new-token', expires: ticket.expires + 60}), true);
    const socket = Socket.all.findLast(s => s.url === gate);
    await socket.onopen();
    assert.equal(socket.sent.findLast(f => f.t === 'hello').auth, 'new-token');
  } finally {await session.leave();}
});

test('a rotation can replace the gates and STUN servers of the room', async () => {
  const secret = randomId(32), next = randomId(32), other = 'wss://community.example/gate';
  const room = await join({gates: [gate], secret, app: 'review', WebSocket: Socket, media: {getTracks: () => []}, stun: ['stun:stun.example.com:3478']});
  try {
    await room.rekey(next, {gates: [other], stun: ['stun:stun.example.net:3478']});
    assert.deepEqual(room.options.gates, [other]);
    assert.deepEqual([...room.stunUrls], ['stun:stun.example.net:3478']);
    assert.equal(Socket.all.at(-1).url, other);
    await assert.rejects(room.rekey(randomId(32), {gates: []}), /gate URL/);
  } finally {await room.leave();}
});

test('half-made bridges are released: a forwarder tells the other endpoint, and stale accepts expire', async () => {
  const room = new Room({gates: [gate], secret: randomId(32), app: 'review', WebSocket: Socket});
  room.crypto = await deriveRoom(randomId(32), 'review'); room.tag = room.crypto.tag;
  const sent = []; room.signalTo = async (to, payload) => {sent.push({to, ...payload});};
  const a = randomId(), b = randomId(), key = [a, b].sort().join('|');
  room.known.add(a); room.known.add(b);
  room.bridgePending.set(key, {a, b, at: Date.now()});
  room.dropPeer(a, 'bye');
  assert.ok(sent.some(m => m.to === b && m.kind === 'bridge-fail'), 'the remaining endpoint learns the bridge failed');
  const c = randomId(), endpointKey = [room.id, c].sort().join('|');
  room.bridges.set(endpointKey, {peer: c, via: b, state: 'accepted', requestedAt: Date.now() - 31000});
  room.sweep();
  assert.equal(room.bridges.has(endpointKey), false, 'a stale accepted forwarder no longer blocks others');
  clearInterval(room.sweeper); clearInterval(room.mediaWatch); room.closed = true;
});

test('ICE URL validation rejects malformed hostnames', () => {
  for (const url of ['turn:..', 'turn:-', 'turn:.', 'turn:a-.b', 'turn:host_name', 'turn:-a.example']) assert.equal(validIceUrl(url, 'turn'), false, url);
  for (const url of ['turn:relay.example.com:3478?transport=tcp', 'turn:[2001:db8::1]:3478', 'stun:stun.l.google.com:19302']) assert.equal(validIceUrl(url, url.startsWith('stun') ? 'stun' : 'turn'), true, url);
});

test('Electron releases a window\'s rooms when it navigates away or is destroyed', async t => {
  const handlers = new Map(), ipcMain = {handle: (k, v) => handlers.set(k, v), removeHandler: k => handlers.delete(k)};
  const helper = installFreehopGateway({ipcMain, allowedOrigins: ['https://a.example'], options: {host: '127.0.0.1', port: 0, portMapping: false, externalAddress: '198.51.100.2'}});
  t.after(() => helper.close());
  const frame = {url: 'https://a.example/'}, sender = Object.assign(new EventEmitter(), {mainFrame: frame}), event = {senderFrame: frame, sender};
  const tag = randomId(32), peer = randomId();
  await handlers.get('freehop:allow-room')(event, tag);
  assert.ok(helper.gateway.credentialsFor(tag, peer));
  sender.emit('did-navigate');
  assert.equal(helper.gateway.credentialsFor(tag, peer), null, 'navigation releases the room');
  const tag2 = randomId(32);
  await handlers.get('freehop:allow-room')(event, tag2);
  assert.ok(helper.gateway.credentialsFor(tag2, peer));
  sender.emit('destroyed');
  assert.equal(helper.gateway.credentialsFor(tag2, peer), null, 'a destroyed window releases its rooms');
});
