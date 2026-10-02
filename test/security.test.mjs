// SPDX-License-Identifier: Apache-2.0
// Regression checks for the protocol audit: epoch isolation, tickets and authority races.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthority} from '../src/sdk/authority.mjs';
import {connect} from '../src/sdk/client.mjs';
import {validTicket, decodeTicket, encodeTicket} from 'freehop/ticket';
import {deriveRoom, seal, randomId} from '../src/client/crypto.mjs';
import {verifyGateToken} from '../src/shared/tokens.mjs';
import {Room} from '../src/client/room.mjs';
import {GateClient} from '../src/client/gate-client.mjs';

const gates = ['ws://127.0.0.1:9/freehop'];
class FakeSocket {readyState = 0; close() {} send() {}}
const stream = {getTracks: () => []};
const options = {WebSocket: FakeSocket, media: stream};
const authority = extra => createAuthority({app: 'audit', gates, ...extra});
const pair = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;

test('expired tickets are rejected before capturing media or opening a gate', async () => {
  const a = authority(); await a.openRoom('room');
  const ticket = await a.ticket('room', 'member');
  for (const expires of [1, Math.floor(Date.now() / 1000), Infinity, NaN, 1.5]) {
    const bad = {...ticket, expires};
    assert.equal(validTicket(bad), false);
    assert.throws(() => decodeTicket(encodeTicket(bad)), TypeError);
    await assert.rejects(connect(bad, {...options, getUserMedia() {throw new Error('must not capture');}}), TypeError);
  }
});

test('concurrent room creation yields one key and reserves the room capacity', async () => {
  const a = authority({maxRooms: 1});
  const rooms = await Promise.all(Array.from({length: 8}, () => a.openRoom('same')));
  assert.equal(new Set(rooms.map(r => r.tag)).size, 1);
  assert.equal((await deriveRoom((await a.ticket('same')).secret, 'audit')).tag, rooms[0].tag);
  const b = authority({maxRooms: 1});
  const attempts = await Promise.allSettled([b.openRoom('one'), b.openRoom('two')]);
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(attempts.find(r => r.status === 'rejected').reason.message, /Too many/);
});

test('concurrent kicks each return a consistent, distinct epoch and room-bound token', async () => {
  const key = randomId(32), a = authority({gateTokenSecret: key});
  await a.openRoom('room');
  for (const member of ['one', 'two', 'three']) await a.ticket('room', member);
  const changes = await Promise.all([a.kick('room', 'one'), a.kick('room', 'two')]);
  assert.deepEqual(changes.map(r => r.epoch), [2, 3]);
  for (const change of changes) {
    const ticket = change.hostTicket;
    assert.equal(ticket.epoch, change.epoch);
    assert.equal((await deriveRoom(ticket.secret, ticket.app)).tag, verifyGateToken(key, ticket.auth[gates[0]]).room);
  }
  assert.deepEqual(a.describe('room').members, ['three']);
  const current = await a.ticket('room');
  assert.equal(current.epoch, 3);
  assert.equal((await deriveRoom(current.secret, current.app)).tag, a.describe('room').tag);
});

test('voluntary leave rotates the bearer secret and returns replacement tickets', async () => {
  const a = authority(); await a.openRoom('room');
  const before = await a.ticket('room', 'leaving');
  await a.ticket('room', 'remaining');
  const {leave} = a;
  const left = await leave('room', 'leaving');
  assert.equal(left.epoch, 2);
  assert.equal(left.tickets.has('leaving'), false);
  assert.notEqual(left.tickets.get('remaining').secret, before.secret);
});

test('closing a room is ordered after any in-flight creation or rotation', async () => {
  const a = authority();
  const opening = a.openRoom('room'), closing = a.closeRoom('room');
  await opening;
  assert.equal(await closing, true);
  assert.equal(a.describe('room'), null);
  await assert.rejects(a.ticket('room'), /not open/);
});

test('SDK update rejects another app or room and does not advance on a failed rotation', async () => {
  const a = authority(); await a.openRoom('room');
  const old = await a.ticket('room', 'member'), next = (await a.kick('room', 'other')).tickets.get('member');
  const s = await connect(old, options);
  try {
    assert.equal(await s.update({...next, app: 'another-app'}), false);
    assert.equal(await s.update({...next, roomId: 'another-room'}), false);
    assert.equal(await s.update({...next, secret: old.secret}), false, 'higher epoch must rotate the key');
    const rekey = s.rekey.bind(s);
    s.rekey = async () => {throw new Error('rotation failed');};
    await assert.rejects(s.update(next), /rotation failed/);
    assert.equal(s.ticket().epoch, 1);
    s.rekey = rekey;
    assert.equal(await s.update(next), true);
    assert.equal(s.ticket().epoch, 2);
  } finally {await s.leave();}
});

test('rekey closes every old-key link, including an unreported identity', async () => {
  const r = new Room({gates, secret: randomId(32), ...options});
  r.crypto = await deriveRoom(r.options.secret, r.app); r.tag = r.crypto.tag;
  const old = r.crypto, alias = randomId();
  let closed = false;
  r.known.add(alias); r.links.set(alias, {close() {closed = true;}});
  try {
    await r.rekey(randomId(32));
    assert.equal(closed, true);
    assert.equal(r.links.size, 0);
    const box = await seal(old, alias, r.id, {kind: 'caps', caps: {peers: []}, n: 1});
    await r.receiveBox(alias, box, 'mesh');
    assert.equal(r.known.has(alias), false);
  } finally {await r.leave();}
});

test('an old-key decryption already in flight cannot admit a peer after rotation', async () => {
  const r = new Room({gates, secret: randomId(32), ...options});
  r.crypto = await deriveRoom(r.options.secret, r.app); r.tag = r.crypto.tag;
  const next = await deriveRoom(randomId(32), r.app), alias = randomId();
  const box = await seal(r.crypto, alias, r.id, {kind: 'caps', caps: {peers: []}, n: 1});
  const receiving = r.receiveBox(alias, box, 'mesh');
  r.crypto = next; r.tag = next.tag;
  await receiving;
  assert.equal(r.known.size, 0);
  r.crypto = await deriveRoom(r.options.secret, r.app); r.tag = r.crypto.tag;
  r.options.gates = ['bt+wss://tracker.example.com']; r.openGates();
  const hello = await seal(r.crypto, alias, '*', {kind: 'hello', n: 2});
  r.gates[0].emit('hello', {gate: r.gates[0], from: alias, box: hello, route: 'x'.repeat(20)});
  r.crypto = next; r.tag = next.tag;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(r.presence.size, 0, 'in-flight tracker hello cannot add an old-epoch hint');
  await r.leave();
});

test('forwarding maps require an active bridge owned by the sender', async () => {
  const r = new Room({gates, secret: randomId(32)}), origin = randomId(), via = randomId(), other = randomId();
  r.links.set(origin, {id: origin, connected: false});
  for (const id of [via, other]) r.links.set(id, {id, connected: true, forwardMap: new Map()});
  const map = {kind: 'forward-map', a: origin, b: r.id, origin, stream: 'stream-one'};
  await r.onBridgeMessage(via, map);
  assert.equal(r.links.get(via).forwardMap.size, 0);
  r.bridges.set(pair(r.id, origin), {peer: origin, via, state: 'active'});
  await r.onBridgeMessage(other, map);
  assert.equal(r.links.get(other).forwardMap.size, 0);
  await r.onBridgeMessage(via, map);
  assert.equal(r.links.get(via).forwardMap.get('stream-one'), origin);
});

test('forwarding accepts must refer to a live offer younger than thirty seconds', async () => {
  const r = new Room({gates, secret: randomId(32)}), a = randomId(), b = randomId();
  r.links.set(a, {connected: true}); r.links.set(b, {connected: true});
  r.bridgeOffers.set(pair(a, b), {a, b, at: Date.now() - 30001});
  r.startRelayBridge = async () => {throw new Error('expired offer must not start');};
  await r.onBridgeMessage(a, {kind: 'bridge-accept', a, b});
  assert.equal(r.relaying.size, 0);
});

test('hostile gate rosters and oversized frames do not crash the client', () => {
  const client = new GateClient(gates[0], {room: randomId(32), peer: randomId(), WebSocketImpl: FakeSocket});
  client.connect();
  for (const peers of [null, 'not an array', {}, Array(65).fill('a')]) {
    assert.doesNotThrow(() => client.ws.onmessage({data: JSON.stringify({t: 'peers', room: client.room, peers})}));
    assert.notEqual(client.state, 'joined');
  }
  assert.doesNotThrow(() => client.ws.onmessage({data: 'x'.repeat(65537)}));
  client.close();
});

test('Electron gateway IPC rejects foreign origins, subframes and missing sender identity', async () => {
  const {installFreehopGateway} = await import('../src/electron/main.mjs');
  const handlers = new Map(), ipcMain = {handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name)};
  assert.throws(() => installFreehopGateway({ipcMain}), /allowedOrigins/);
  const helper = installFreehopGateway({ipcMain, allowedOrigins: ['https://play.example.com'], options: {host: '127.0.0.1', port: 0, portMapping: false, externalAddress: '198.51.100.10'}});
  try {
    const frame = {url: 'https://evil.example.com/'}, sender = {mainFrame: frame};
    for (const event of [{}, {senderFrame: frame, sender}, {senderFrame: {url: 'https://play.example.com/'}, sender}]) {
      assert.equal(await handlers.get('freehop:gateway-info')(event), null);
      await handlers.get('freehop:allow-room')(event, randomId(32));
      assert.equal(helper.gateway, null, 'untrusted IPC must not even start the gateway');
    }
    frame.url = 'https://play.example.com/call';
    const event = {senderFrame: frame, sender};
    assert.equal((await handlers.get('freehop:gateway-info')(event)).secret, undefined, 'the signing key never crosses IPC');
    frame.url = 'https://evil.example.com/';
    assert.equal(await handlers.get('freehop:gateway-info')(event), null, 'navigation revokes IPC access');
  } finally {await helper.close();}
});


test('media capture completing after leave immediately releases every acquired device', async () => {
  let release;
  const captured = new Promise(resolve => {release = resolve;});
  const r = new Room({gates, secret: randomId(32), getUserMedia: () => captured});
  r.localStream = {getTracks: () => [], addTrack() {throw new Error('closed room must not attach a late track');}};
  const acquiring = r.setCamera(true);
  await r.leave();
  const tracks = ['video', 'audio'].map(kind => ({kind, stopped: false, stop() {this.stopped = true;}}));
  release({getTracks: () => tracks}); await acquiring;
  assert.equal(tracks.every(t => t.stopped), true);
});
