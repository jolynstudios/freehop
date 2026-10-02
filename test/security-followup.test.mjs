// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {Room} from '../src/client/room.mjs';
import {GateClient} from '../src/client/gate-client.mjs';
import {deriveRoom, randomId, seal} from '../src/client/crypto.mjs';
import {validIceUrl} from '../src/client/ice-urls.mjs';
import {createAuthority} from '../src/sdk/authority.mjs';
import {connect} from '../src/sdk/client.mjs';
import {verifyGateToken} from '../src/shared/tokens.mjs';
import {joinAsGateway} from '../src/relay/member.mjs';
import {installFreehopGateway} from '../src/electron/main.mjs';

const gates = ['wss://operator.example/gate', 'wss://community.example/gate'];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {for (let i = 0; i < 200; i++) {if (fn()) return; await wait(5);} assert.ok(fn(), 'condition timed out');}
class Socket {
  static all = [];
  readyState = 1; sent = [];
  constructor() {Socket.all.push(this);}
  send(text) {this.sent.push(JSON.parse(text));}
  close() {this.readyState = 3; this.onclose?.();}
  receive(value) {this.onmessage({data: JSON.stringify(value)});}
}
const keyFor = (a, b) => [a, b].sort().join('|');

test('tickets and gate clients disclose admission tokens only to their intended gate; STUN is pinned', async () => {
  const key = randomId(32), configured = [...gates, 'bt+wss://tracker.example'];
  const a = createAuthority({app: 'audit', gates: configured, gateTokenSecrets: {[gates[0]]: key}, stun: ['stun:stun.example:3478']});
  await a.openRoom('room'); const ticket = await a.ticket('room', 'member');
  assert.deepEqual(Object.keys(ticket.auth), [gates[0]]);
  assert.equal(verifyGateToken(key, ticket.auth[gates[0]]).aud, gates[0]);
  assert.deepEqual(ticket.stun, ['stun:stun.example:3478']);
  for (const url of gates) {
    const gate = new GateClient(url, {room: 'room', peer: randomId(), auth: ticket.auth, WebSocketImpl: Socket});
    gate.connect(); await gate.ws.onopen();
    assert.equal(gate.ws.sent[0].auth, ticket.auth[url]);
    gate.ws.receive({t: 'welcome', stun: ['stun:attacker.example:1']});
    assert.deepEqual(gate.stun, []); gate.close();
  }
  const gate = new GateClient(gates[0], {auth: async () => {throw Error('provider failed');}, WebSocketImpl: Socket});
  gate.connect(); await gate.ws.onopen(); assert.equal(gate.counters.errors, 1); gate.close();
  assert.throws(() => new Room({gates, auth: 'shared-token'}), /per-gate/);
});

test('ICE URL validation rejects embedded lists, invalid ports and credentials', () => {
  for (const value of ['turn:a:3478,turn:b:3478', 'turn:a:0', 'turn:a:65536', 'turn:user@host', 'turn:a/path', 'turn:a?transport=udp&x=1']) assert.equal(validIceUrl(value, 'turn'), false, value);
  for (const value of ['turn:host:3478?transport=tcp', 'turns:[2001:db8::1]:5349']) assert.equal(validIceUrl(value, 'turn'), true, value);
  assert.throws(() => new Room({gates, stun: ['stun:a?transport=udp']}), /STUN/);
});

test('Electron brokers bounded credentials only for rooms granted to that renderer and origin', async t => {
  const handlers = new Map(), ipcMain = {handle: (k, v) => handlers.set(k, v), removeHandler: k => handlers.delete(k)};
  assert.throws(() => installFreehopGateway({ipcMain, allowedOrigins: ['http://public.example']}), /HTTPS/);
  const helper = installFreehopGateway({ipcMain, allowedOrigins: ['https://a.example', 'https://b.example'], options: {host: '127.0.0.1', port: 0, portMapping: false, externalAddress: '198.51.100.1'}});
  t.after(() => helper.close());
  const frame = {url: 'https://a.example/'}, sender = {mainFrame: frame}, event = {senderFrame: frame, sender};
  const tag = randomId(32), peer = randomId();
  const grant = handlers.get('freehop:allow-room')(event, tag);
  frame.url = 'https://b.example/'; await grant;
  assert.equal(await handlers.get('freehop:credentials')(event, tag, peer), null, 'navigation during startup must not transfer a grant');
  await handlers.get('freehop:allow-room')(event, tag);
  const info = await handlers.get('freehop:gateway-info')(event);
  assert.equal(info.secret, undefined);
  const creds = await handlers.get('freehop:credentials')(event, tag, peer);
  assert.ok(creds.credential); assert.ok(Number(creds.username.split(':')[0]) <= Date.now() / 1000 + info.ttlSeconds);
  assert.equal(await handlers.get('freehop:credentials')(event, randomId(32), peer), null);
  assert.equal(await handlers.get('freehop:credentials')(event, tag, 'bad:label'), null);
  const otherFrame = {url: frame.url};
  assert.equal(await handlers.get('freehop:credentials')({senderFrame: otherFrame, sender: {mainFrame: otherFrame}}, tag, peer), null);
  await handlers.get('freehop:revoke-peer')(event, tag, peer);
  assert.equal(await handlers.get('freehop:credentials')(event, tag, peer), null);
  frame.url = 'https://a.example/';
  assert.equal(await handlers.get('freehop:credentials')(event, tag, randomId()), null);
});

test('one malicious gate cannot occupy the entire hint pool and expired hints release their state', () => {
  const r = new Room({gates, limits: {maxHints: 4}, timing: {greetMs: 20}}), a = {}, b = {};
  r.sendCaps = () => {}; r.flushOutbox = () => {};
  for (let i = 0; i < 64; i++) r.hint(randomId(), a);
  assert.equal(r.presence.size, 2);
  const honest = randomId(); r.hint(honest, b); assert.ok(r.presence.has(honest));
  for (const id of r.hintedAt.keys()) r.hintedAt.set(id, Date.now() - 21);
  r.hint(honest, b); r.sweep();
  assert.equal(r.presence.size, 0); assert.equal(r.hintedAt.size, 0);
  r.hint(randomId(), b); assert.equal(r.presence.size, 1);
});

test('gateway member ignores unauthenticated rosters and recycles departed membership without accepting recent replays', async t => {
  const secret = randomId(32), crypto = await deriveRoom(secret, 'audit');
  let revoked = 0;
  const gateway = {info: () => ({urls: ['turn:relay.example:3478'], ttlSeconds: 7200}), allowRoom() {}, revokeRoom() {}, revokePeer() {revoked++;}, credentialsFor: (tag, peer) => ({username: `${Math.floor(Date.now()/1000)+7200}:${tag.slice(0,8)}:${peer}`, credential: 'test'})};
  const m = await joinAsGateway({gates: [gates[0]], secret, app: 'audit', gateway, departGraceMs: 20, WebSocketImpl: Socket});
  t.after(() => m.close());
  const socket = Socket.all.at(-1);
  socket.receive({t: 'peers', room: crypto.tag, peers: Array.from({length: 64}, () => randomId())});
  assert.equal(m.stats().peers, 0);
  let replay, finalPeer;
  for (let i = 0; i < 80; i++) {
    const peer = randomId(), box = await seal(crypto, peer, m.id, {kind: 'caps', n: 1});
    socket.receive({t: 'recv', room: crypto.tag, from: peer, box});
    await until(() => m.stats().peers === 1);
    socket.receive({t: 'recv', room: crypto.tag, from: peer, box: await seal(crypto, peer, m.id, {kind: 'bye', n: 2})});
    await until(() => m.stats().peers === 0); replay = box; finalPeer = peer;
  }
  socket.receive({t: 'recv', room: crypto.tag, from: finalPeer, box: replay});
  await wait(20); assert.equal(m.stats().peers, 0);
  const peer = randomId();
  socket.receive({t: 'recv', room: crypto.tag, from: peer, box: await seal(crypto, peer, m.id, {kind: 'caps', n: 1})});
  await until(() => m.stats().peers === 1);
  socket.receive({t: 'peer', room: crypto.tag, peer, on: false});
  await until(() => m.stats().peers === 0);
  assert.equal(revoked, 80, 'unauthenticated departure hints must not revoke live TURN media');
});

test('forwarding requires both endpoint consents before media is forwarded', async () => {
  const [a, b, c] = Array.from({length: 3}, () => new Room({gates}));
  for (const r of [a, b, c]) for (const other of [a, b, c].filter(o => o !== r)) {
    r.links.set(other.id, {id: other.id, connected: r === c || other === c, phase: 0});
    r.caps.set(other.id, {forward: true, peers: [a.id, b.id, c.id]});
  }
  const rooms = new Map([a, b, c].map(r => [r.id, r])), key = keyFor(a.id, b.id);
  let confirm, forwarded = 0;
  for (const r of rooms.values()) r.signalTo = async (to, p) => {
    if (p.kind === 'bridge-confirm') {confirm = p; return;}
    await rooms.get(to).onBridgeMessage(r.id, p);
  };
  c.forwardTracks = async () => {forwarded++;};
  await a.onBridgeMessage(c.id, {kind: 'bridge-active', a: a.id, b: b.id});
  assert.equal(a.bridges.size, 0);
  a.bridges.set(key, {peer: b.id, via: null, state: 'requested', requestedAt: Date.now()});
  await c.onBridgeMessage(a.id, {kind: 'bridge-request', a: a.id, b: b.id});
  assert.ok(confirm); assert.equal(forwarded, 0); assert.equal(c.relaying.size, 0);
  await b.onBridgeMessage(c.id, confirm);
  assert.equal(forwarded, 2);
  for (const r of [a, b]) assert.equal(r.bridges.get(key).state, 'active');
  assert.equal(c.bridgePending.size, 0); assert.equal(c.relaying.size, 1);
});

test('local disconnection has an explicit name and the former kick API fails closed', async () => {
  const a = createAuthority({app: 'audit', gates}); await a.openRoom('room');
  const ticket = await a.ticket('room', 'member');
  const session = await connect(ticket, {WebSocket: Socket, media: {getTracks: () => []}});
  try {
    await assert.rejects(session.kick(randomId()), /authority.kick/);
    const peer = randomId(); let removed;
    session.drop = id => {removed = id;};
    await session.disconnectPeer(peer); assert.equal(removed, peer);
    assert.equal(session.ticket().epoch, ticket.epoch);
  } finally {await session.leave();}
});

test('a forwarding cancellation during activation cannot attach media afterward', async () => {
  const r = new Room({gates}), a = randomId(), b = randomId(), key = keyFor(a, b);
  for (const id of [a, b]) r.links.set(id, {id, connected: true});
  r.signalTo = async () => {r.relaying.delete(key);};
  r.forwardTracks = async () => {throw Error('cancelled bridge must not forward');};
  await r.activateRelayBridge(key, a, b);
  assert.equal(r.relaying.size, 0);
});

test('a failed or old-epoch credential broker cannot populate the room cache', async () => {
  const r = new Room({gates}); r.crypto = await deriveRoom(randomId(32)); r.tag = r.crypto.tag;
  r.ownGateway = {ttlSeconds: 7200, credentialsFor: async () => {throw Error('IPC closed');}};
  assert.equal(await r.gatewayCredsFor('self'), null);
  let release;
  r.ownGateway.credentialsFor = () => new Promise(resolve => {release = resolve;});
  const pending = r.gatewayCredsFor('self'), oldTag = r.tag;
  r.crypto = await deriveRoom(randomId(32)); r.tag = r.crypto.tag;
  release({username: `${Math.floor(Date.now()/1000)+7200}:${oldTag.slice(0,8)}:self`, credential: 'test'});
  assert.equal(await pending, null); assert.equal(r.gatewayCreds.size, 0);
});
