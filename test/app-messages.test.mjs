// SPDX-License-Identifier: Apache-2.0
// Application messages: session.send() / 'message' events, bounded and rate-limited.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Room, APP_MESSAGE_BYTES} from '../src/client/room.mjs';
import {deriveRoom, randomId} from '../src/client/crypto.mjs';

class Socket { readyState = 1; send() {} close() {} }
async function room() {
  const r = new Room({gates: ['wss://operator.example/gate'], secret: randomId(32), app: 'apps', WebSocket: Socket});
  r.crypto = await deriveRoom(randomId(32), 'apps'); r.tag = r.crypto.tag;
  r.ensureLink = () => null;   // no WebRTC in unit tests
  return r;
}

test('application messages reach members as untrusted data and are bounded', async () => {
  const r = await room(), from = randomId(), got = [];
  r.known.add(from);
  r.on('message', m => got.push(m));
  r.dispatch(from, {kind: 'app', data: {type: 'chat', text: 'hello'}, n: 1});
  assert.deepEqual(got, [{from, data: {type: 'chat', text: 'hello'}}]);
  r.dispatch(from, {kind: 'app', data: 'x'.repeat(APP_MESSAGE_BYTES + 1), n: 2});
  r.dispatch(from, {kind: 'app', n: 3});
  assert.equal(got.length, 1, 'oversized or empty messages are dropped');
  assert.equal(r.counters.appDropped, 2);
});

test('each receiver rate-limits application messages per sender', async () => {
  const r = await room(), a = randomId(), b = randomId(); let count = 0;
  r.known.add(a); r.known.add(b);
  r.on('message', () => count++);
  for (let i = 0; i < 100; i++) r.dispatch(a, {kind: 'app', data: i, n: i + 1});
  assert.ok(count >= 40 && count <= 42, `burst bounded, got ${count}`);
  r.dispatch(b, {kind: 'app', data: 'other sender', n: 1});
  assert.ok(count >= 41, 'another sender keeps its own budget');
});

test('send() validates data and reaches one member or every member', async () => {
  const r = await room(), a = randomId(), b = randomId(), sent = [];
  r.known.add(a); r.known.add(b);
  r.signalTo = async (to, payload) => { sent.push({to, ...payload}); return true; };
  assert.equal(await r.send({hi: 1}), 2);
  assert.equal(await r.send('one', {to: a}), 1);
  assert.equal(await r.send('nobody', {to: randomId()}), 0);
  await assert.rejects(r.send('x'.repeat(APP_MESSAGE_BYTES + 1)), RangeError);
  await assert.rejects(r.send(undefined), RangeError);
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(r.send(cyclic), TypeError);
  assert.deepEqual(sent.map(m => [m.to, m.kind, m.data]), [[a, 'app', {hi: 1}], [b, 'app', {hi: 1}], [a, 'app', 'one']]);
});

test('switchDevice replaces a running track on every link and keeps its mute state', async () => {
  class Track { constructor(kind, id) {this.kind = kind; this.id = id; this.enabled = true; this.stopped = false;} stop() {this.stopped = true;} }
  class Stream { constructor(tracks = []) {this.tracks = [...tracks];} getTracks() {return [...this.tracks];} addTrack(t) {this.tracks.push(t);} removeTrack(t) {this.tracks = this.tracks.filter(x => x !== t);} }
  const asked = [];
  const getUserMedia = async c => { asked.push(c); const kind = c.audio ? 'audio' : 'video'; return new Stream([new Track(kind, `${kind}-${asked.length}`)]); };
  const r = new Room({gates: ['wss://operator.example/gate'], secret: randomId(32), app: 'apps', WebSocket: Socket, getUserMedia, devices: {audio: 'mic-a'}});
  r.localStream = new Stream(); r.ownsMedia = true;
  await r.setMicrophone(true);
  assert.deepEqual(asked[0].audio.deviceId, {exact: 'mic-a'}, 'the preferred device is used for the first capture');
  const replaced = [];
  r.links.set('peer', {senders: new Map([['audio', {replaceTrack: async t => replaced.push(t.id)}]]), pc: {addTrack: () => ({replaceTrack: async () => {}})}});
  const old = r.localStream.getTracks()[0];
  await r.setMicrophone(false);                       // muted: the track stays, disabled
  assert.equal(await r.switchDevice('audio', 'mic-b'), true);
  const now = r.localStream.getTracks()[0];
  assert.notEqual(now, old); assert.equal(old.stopped, true); assert.equal(now.enabled, false, 'mute state is kept');
  assert.deepEqual(replaced, [now.id]);
  assert.equal(await r.switchDevice('video', 'cam-b'), true, 'no camera running: stored for later');
  await r.setCamera(true);
  assert.deepEqual(asked.at(-1).video.deviceId, {exact: 'cam-b'});
  await assert.rejects(r.switchDevice('screen', 'x'), TypeError);
  assert.throws(() => new Room({gates: ['wss://g.example/x'], secret: randomId(32), WebSocket: Socket, devices: {audio: 42}}), TypeError);
});
