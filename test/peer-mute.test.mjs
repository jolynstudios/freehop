// SPDX-License-Identifier: Apache-2.0
// Peer-level local mute: setPeerMuted() flips enabled on a member's remote audio tracks,
// applies to tracks that arrive later (direct or forwarded), and survives a soft ('gone')
// departure only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/client/room.mjs';
import { deriveRoom, randomId } from '../src/client/crypto.mjs';

class Socket { readyState = 1; send() {} close() {} }
async function room() {
  const r = new Room({ gates: ['wss://operator.example/gate'], secret: randomId(32), app: 'apps', WebSocket: Socket });
  r.crypto = await deriveRoom(randomId(32), 'apps'); r.tag = r.crypto.tag;
  r.ensureLink = () => null;   // no WebRTC in unit tests
  return r;
}

class Track {
  constructor(kind) { this.kind = kind; this.enabled = true; this.listeners = new Map(); }
  addEventListener(type, fn) { let set = this.listeners.get(type); if (!set) this.listeners.set(type, set = new Set()); set.add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  fire(type) { for (const fn of this.listeners.get(type) ?? []) fn(); }
}

test('mute before arrival silences audio from the first sample, video untouched', async () => {
  const r = await room(), a = randomId();
  r.setPeerMuted(a, true);
  const audio = new Track('audio'), video = new Track('video');
  r.onRemoteTrack({ id: a }, a, audio, {});
  r.onRemoteTrack({ id: a }, a, video, {});
  assert.equal(audio.enabled, false, 'muted peer audio arrives disabled');
  assert.equal(video.enabled, true, 'video is not affected by mute');
});

test('setPeerMuted flips live tracks in both directions', async () => {
  const r = await room(), a = randomId();
  const track = new Track('audio');
  r.onRemoteTrack({ id: a }, a, track, {});
  assert.equal(track.enabled, true);
  r.setPeerMuted(a, true);
  assert.equal(track.enabled, false);
  r.setPeerMuted(a, false);
  assert.equal(track.enabled, true);
});

test('mute keys on the origin, so forwarded audio is muted too', async () => {
  const r = await room(), a = randomId(), via = randomId();
  r.setPeerMuted(a, true);
  const track = new Track('audio');
  r.onRemoteTrack({ id: via }, a, track, {});
  assert.equal(track.enabled, false, 'bridged/forwarded audio respects the origin mute');
});

test('mute survives a soft departure (gone) but not a terminal one (dropped)', async () => {
  const r = await room(), a = randomId(), b = randomId();
  r.known.add(a); r.setPeerMuted(a, true); r.dropPeer(a, 'gone');
  const back = new Track('audio');
  r.onRemoteTrack({ id: a }, a, back, {});
  assert.equal(back.enabled, false, 'a gone peer returning stays muted');
  r.known.add(b); r.setPeerMuted(b, true); r.dropPeer(b, 'dropped');
  const fresh = new Track('audio');
  r.onRemoteTrack({ id: b }, b, fresh, {});
  assert.equal(fresh.enabled, true, 'terminal departure clears the mute');
});

test('ended tracks leave the registry: replacements are muted, dead ones untouched', async () => {
  const r = await room(), a = randomId();
  const first = new Track('audio');
  r.onRemoteTrack({ id: a }, a, first, {});
  r.setPeerMuted(a, true);
  assert.equal(first.enabled, false);
  first.fire('ended');
  const replacement = new Track('audio');
  r.onRemoteTrack({ id: a }, a, replacement, {});
  assert.equal(replacement.enabled, false, 'replacement track applies the standing mute');
  r.setPeerMuted(a, false);
  assert.equal(replacement.enabled, true);
  assert.equal(first.enabled, false, 'an ended track is not resurrected by unmute');
});

test('setPeerMuted validates its arguments', async () => {
  const r = await room();
  assert.throws(() => r.setPeerMuted('short', true), TypeError);
  assert.throws(() => r.setPeerMuted(randomId(), 'yes'), TypeError);
});
