import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/client/room.mjs';
import { randomId } from '../src/client/crypto.mjs';

function fixture() {
  const room = new Room({ gates: ['wss://gate.example/freehop'], secret: randomId(32) });
  room.crypto = {};
  const track = { kind: 'audio', enabled: true, readyState: 'live' }, calls = [];
  const sender = { track, async replaceTrack(next) { calls.push(next); this.track = next; } };
  const link = { id: 'peer', connected: true, closed: false, senders: new Map([['audio', sender]]),
    pc: { signalingState: 'stable', getStats: async () => new Map([['audio', { type: 'outbound-rtp', kind: 'audio', packetsSent: 10 }]]) },
    classify: async () => null, restarts: 0, restart() { this.restarts++; } };
  room.links.set(link.id, link);
  room.localStream = { getTracks: () => [track] };
  return { room, link, track, sender, calls };
}

test('a stalled audio sender rebinds its live track without new capture or ICE restart', async () => {
  const { room, link, track, calls } = fixture();
  room.getUserMedia = () => assert.fail('recovery must not open a device');
  await room.checkSending(); await room.checkSending(); await room.checkSending();
  assert.deepEqual(calls, [null, track]);
  assert.equal(link.restarts, 0);
  assert.equal(room.counters.mediaStalls, 1);
});

test('muted audio does not trigger sender recovery', async () => {
  const { room, link, track, calls } = fixture(); track.enabled = false;
  await room.checkSending(); await room.checkSending(); await room.checkSending();
  assert.deepEqual(calls, []); assert.equal(link.restarts, 0);
  assert.equal(room.counters.mediaStalls, 0);
});

test('a device switch while recovery awaits cannot restore the old microphone', async () => {
  const { room, link, track, sender } = fixture();
  const replacement = { kind: 'audio', readyState: 'live' };
  sender.replaceTrack = async next => { assert.equal(next, null); sender.track = replacement; };
  assert.equal(await room.refreshAudioSender(link, sender, track, room.crypto), true);
  assert.equal(sender.track, replacement);
});

test('departure or rotation while recovery awaits cannot restore a sender', async () => {
  for (const change of ['leave', 'rekey']) {
    const { room, link, track, sender } = fixture();
    sender.replaceTrack = async next => { assert.equal(next, null); sender.track = null;
      if (change === 'leave') room.closed = true; else room.crypto = {}; };
    assert.equal(await room.refreshAudioSender(link, sender, track, room.crypto), true);
    assert.equal(sender.track, null);
  }
});

test('negotiating audio and a failed rebind use the existing ICE recovery', async () => {
  for (const failure of ['negotiating', 'rebind-error']) {
    const { room, link, sender } = fixture();
    if (failure === 'negotiating') link.pc.signalingState = 'have-local-offer';
    else sender.replaceTrack = async () => { throw new Error('sender refused'); };
    await room.checkSending(); await room.checkSending(); await room.checkSending();
    assert.equal(link.restarts, 1);
  }
});

test('failed restoration is retried after detachment, without losing the microphone', async () => {
  const { room, link, sender, track, calls } = fixture();
  let refused = false;
  sender.replaceTrack = async next => {
    calls.push(next);
    if (next === track && !refused) { refused = true; throw new Error('restore refused'); }
    sender.track = next;
  };
  await room.checkSending(); await room.checkSending(); await room.checkSending();
  assert.equal(sender.track, null);
  assert.equal(link.restarts, 1);
  await room.checkSending();
  assert.equal(sender.track, track);
  assert.deepEqual(calls, [null, track, track]);
  assert.equal(room.audioRestores.has(sender), false);
});

test('a refreshed sender still needs packet progress, otherwise ICE is tried once', async () => {
  const { room, link, calls } = fixture();
  for (let i = 0; i < 9; i++) await room.checkSending();
  assert.equal(calls.length, 2);
  assert.equal(link.restarts, 1);
  assert.equal(room.sendProgress.get(link.id).audio.fallback, true);
});

test('resumed audio resets recovery and a later stall can refresh again', async () => {
  const { room, link, calls } = fixture();
  for (let i = 0; i < 3; i++) await room.checkSending();
  link.pc.getStats = async () => new Map([['audio', { type: 'outbound-rtp', kind: 'audio', packetsSent: 20 }]]);
  await room.checkSending();
  assert.equal(room.sendProgress.get(link.id).audio.stalls, 0);
  assert.equal(link.restarts, 0);
  await room.checkSending(); await room.checkSending();
  assert.equal(calls.length, 4);
});

test('persistent restoration failures back off, retaining restoration ownership', async () => {
  const { room, sender, track, link } = fixture();
  let attempts = 0;
  sender.replaceTrack = async next => {
    if (next === track) { attempts++; throw new Error('restore refused'); }
    sender.track = next;
  };
  for (let i = 0; i < 12; i++) await room.checkSending();
  assert.equal(sender.track, null);
  assert.ok(attempts >= 3 && attempts < 10, `bounded attempts: ${attempts}`);
  assert.equal(room.audioRestores.has(sender), true);
  assert.equal(link.restarts, 1);
});

test('pending restoration cannot resurrect an old track after rotation or a device switch', async () => {
  for (const change of ['rekey', 'device', 'link']) {
    const { room, sender, track, link } = fixture();
    sender.replaceTrack = async next => {
      if (next === track) throw new Error('restore refused');
      sender.track = next;
    };
    for (let i = 0; i < 3; i++) await room.checkSending();
    if (change === 'rekey') room.crypto = {};
    if (change === 'device') sender.track = { kind: 'audio', enabled: true, readyState: 'live' };
    if (change === 'link') room.links.set(link.id, { ...link, connected: false });
    await room.restoreAudioSender(link, sender, room.audioRestores.get(sender));
    assert.equal(room.audioRestores.has(sender), false);
    assert.notEqual(sender.track, track);
  }
});

test('overlapping media watches cannot detach the same sender twice', async () => {
  const { room, link, calls } = fixture();
  await room.checkSending(); await room.checkSending();
  let release;
  link.pc.getStats = () => new Promise(resolve => { release = resolve; });
  const running = room.checkSending();
  await room.checkSending();
  release(new Map([['audio', { type: 'outbound-rtp', kind: 'audio', packetsSent: 10 }]]));
  await running;
  assert.equal(calls.length, 2);
  assert.equal(room.checkingSending, false);
});
