import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/client/room.mjs';
import { randomId } from '../src/client/crypto.mjs';

const gates = ['wss://gate.example/freehop'];

function videoSender() {
  const track = {kind: 'video', readyState: 'live'};
  const sender = {
    track,
    parameters: {encodings: [{active: true, maxBitrate: 300000, maxFramerate: 24, scaleResolutionDownBy: 1}]},
    getParameters() { return structuredClone(this.parameters); },
    async setParameters(parameters) { this.parameters = structuredClone(parameters); },
  };
  return sender;
}

function report({packets = 100, lost = 0, frames = 100, dropped = 0, bytes = 10000, limitation = 'none', available = 500000} = {}) {
  return new Map([
    ['out', {type: 'outbound-rtp', kind: 'video', packetsSent: packets, bytesSent: bytes, qualityLimitationReason: limitation}],
    ['in', {type: 'inbound-rtp', kind: 'video', packetsReceived: packets, packetsLost: lost, framesDecoded: frames, framesDropped: dropped, totalDecodeTime: frames * 0.01, bytesReceived: bytes}],
    ['pair', {type: 'candidate-pair', state: 'succeeded', selected: true, availableOutgoingBitrate: available}],
  ]);
}

function fakeLink(sender = videoSender()) {
  return {id: randomId(16), connected: true, closed: false, forwardSenders: new Map(),
    pc: {getSenders: () => [sender]}, senders: new Map([['video', sender]]), sender, restarts: 0, classify: async () => null, restart() { this.restarts++; }};
}

test('adaptive video stays opt-in and validates its option', () => {
  const room = new Room({gates, secret: randomId(32)});
  assert.equal(room.adaptiveVideoEnabled, false);
  assert.throws(() => new Room({gates, adaptiveVideo: 'yes'}), /adaptiveVideo must be a boolean/);
});

test('reduced quality changes only video sender parameters', async () => {
  const room = new Room({gates, secret: randomId(32), adaptiveVideo: true});
  const video = videoSender();
  const audio = {...videoSender(), track: {kind: 'audio', readyState: 'live'}};
  const link = fakeLink(video);
  link.pc.getSenders = () => [video, audio];
  room.videoQuality.set(link.id, {sendLevel: 'reduced', remoteLevel: 'normal'});

  await room.applyEncodingLimits(link);

  assert.equal(video.parameters.encodings[0].maxBitrate, 180000);
  assert.equal(video.parameters.encodings[0].maxFramerate, 15);
  assert.equal(video.parameters.encodings[0].scaleResolutionDownBy, 1.5);
  assert.equal(audio.parameters.encodings[0].maxBitrate, room.limits.audioBitrate);
  assert.equal(audio.parameters.encodings[0].active, true);
});

test('sustained receive loss requests a lower video level per peer', async () => {
  const room = new Room({gates, secret: randomId(32), adaptiveVideo: true});
  const link = fakeLink();
  room.links.set(link.id, link);
  const requests = [];
  room.signalTo = async (peer, message) => { requests.push({peer, message}); };
  const events = [];
  room.on('video-quality', event => events.push(event));

  await room.checkAdaptiveVideo(link, report());
  await room.checkAdaptiveVideo(link, report({packets: 110, lost: 2, frames: 110, bytes: 11000}));
  await room.checkAdaptiveVideo(link, report({packets: 120, lost: 4, frames: 120, bytes: 12000}));

  assert.equal(room.videoQuality.get(link.id).receiveLevel, 'reduced');
  assert.deepEqual(requests.at(-1), {peer: link.id, message: {kind: 'video-quality', level: 'reduced'}});
  assert.ok(events.some(event => event.direction === 'receive' && event.level === 'reduced'));
});

test('a peer request is bounded, ordered, and clamped to the supported ladder', async () => {
  const room = new Room({gates, secret: randomId(32), adaptiveVideo: true});
  const link = fakeLink(); room.links.set(link.id, link);
  room.receiveVideoQuality(link.id, {n: 4, level: 'minimal'});
  assert.equal(room.videoQuality.get(link.id).remoteLevel, 'minimal');
  room.videoQuality.get(link.id).lastControlAt = Date.now();
  room.receiveVideoQuality(link.id, {n: 5, level: 'normal'});
  assert.equal(room.videoQuality.get(link.id).remoteLevel, 'minimal', 'rapid changes are rate limited');
  room.videoQuality.get(link.id).lastControlAt = Date.now() - 1001;
  room.receiveVideoQuality(link.id, {n: 3, level: 'paused'});
  assert.equal(room.videoQuality.get(link.id).remoteLevel, 'minimal', 'older requests cannot override newer state');
  room.videoQuality.get(link.id).lastControlAt = Date.now() - 1001;
  room.receiveVideoQuality(link.id, {n: 6, level: 'unlimited'});
  assert.equal(room.videoQuality.get(link.id).remoteLevel, 'minimal', 'unknown levels are ignored');
});

test('a deliberately paused video sender is excluded from stall-triggered ICE recovery', async () => {
  const room = new Room({gates, secret: randomId(32), adaptiveVideo: true});
  room.crypto = {};
  const link = fakeLink(); room.links.set(link.id, link);
  link.pc.getStats = async () => report({packets: 10, frames: 10, bytes: 1000});
  room.localStream = {getTracks: () => [link.sender.track]};
  room.videoQuality.set(link.id, {sendLevel: 'paused', reportedSendLevel: 'paused', remoteLevel: 'normal', receiveLevel: 'normal'});

  await room.checkSending(); await room.checkSending(); await room.checkSending();

  assert.equal(link.restarts, 0);
  assert.equal(room.counters.mediaStalls, 0);
});
