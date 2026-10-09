// SPDX-License-Identifier: Apache-2.0
// Opt-in ladder rungs (classifyNat, portPrediction, an application TURN relay): what they change,
// what they leave alone, and that a failing rung can never stall a link.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/client/room.mjs';
import { APP_TURN, FEATURE_SCENARIOS, IDS, SCENARIOS, runScenario } from './fakes/ladder-harness.mjs';

const gates = ['wss://gate.invalid/rungs'];
const paths = run => run.trace.filter(e => e.event === 'path').map(e => `${e.t}:${e.kind}${e.via ? `@${e.via}` : ''}`);

test('options set explicitly off leave every ladder scenario exactly as with them unset', async () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    const unset = await runScenario(scenario);
    const off = await runScenario({ ...scenario, options: { ...scenario.options, classifyNat: false, portPrediction: false, turn: null } });
    assert.deepEqual(off, unset, name);
  }
});

test('port prediction connects a home router to a sequential NAT directly, and only when enabled', async () => {
  const on = await runScenario(FEATURE_SCENARIOS['predict-eim-to-sequential']);
  assert.deepEqual(paths(on), ['5270:direct']);
  assert.equal(on.final.counters.predictAttempts, 1);
  assert.ok(on.final.counters.predictCandidates > 0 && on.final.counters.predictCandidates <= 16);
  const off = await runScenario({ ...FEATURE_SCENARIOS['predict-eim-to-sequential'], options: {} });
  assert.deepEqual(paths(off).slice(0, 2), ['5000:unreachable', '35000:unreachable']);
  assert.equal(off.final.counters.predictAttempts, undefined);
});

test('a random NAT is never predicted: the pair is reported unreachable on the usual schedule', async () => {
  const run = await runScenario(FEATURE_SCENARIOS['predict-random-peer']);
  assert.deepEqual(paths(run).slice(0, 2), ['5000:unreachable', '35000:unreachable']);
  assert.equal(run.final.counters.predictAttempts, undefined);
  assert.equal(run.final.counters.predictCandidates, undefined);
});

test('the application TURN relay is added only after every in-session route failed', async () => {
  const run = await runScenario(FEATURE_SCENARIOS['turn-rung']);
  const configs = run.trace.filter(e => e.call === 'new' || e.call === 'setConfiguration');
  assert.ok(configs.filter(e => e.t < 5000).every(e => !e.iceServers.some(s => s.username === 'u-app')), 'no TURN before the rung');
  assert.ok(configs.some(e => e.t === 5000 && e.iceServers.some(s => s.username === 'u-app')));
  assert.deepEqual(paths(run), ['5270:relay@turn']);
  assert.equal(run.final.counters.turnAttempts, 1);
  const polite = await runScenario(FEATURE_SCENARIOS['turn-rung-polite']);
  assert.deepEqual(paths(polite), ['7970:relay@turn'], 'the polite side restarts after restartFallbackMs, as for every other restart');
});

test('prediction is tried before the TURN relay', async () => {
  const run = await runScenario(FEATURE_SCENARIOS['predict-then-turn']);
  const restarts = run.trace.filter(e => e.call === 'restartIce').map(e => e.t);
  assert.deepEqual(restarts, [5000, 15000]);
  assert.ok(run.trace.some(e => e.t === 15000 && e.call === 'setConfiguration' && e.iceServers.some(s => s.username === 'u-app')));
  assert.deepEqual(paths(run), ['15270:relay@turn']);
  assert.equal(run.final.counters.predictAttempts, 1);
  assert.equal(run.final.counters.turnAttempts, 1);
});

test('a refused TURN configuration falls through to unreachable in the same escalation and keeps retrying', async () => {
  const run = await runScenario(FEATURE_SCENARIOS['turn-configuration-refused']);
  assert.deepEqual(paths(run).slice(0, 2), ['5000:unreachable', '35000:unreachable']);
  assert.equal(run.final.counters.turnErrors, 1);
  assert.equal(run.final.counters.linkErrors, 0);
});

test('an exception inside an opt-in rung never stalls the link: it is counted and the ladder carries on', async () => {
  const run = await runScenario({ ...FEATURE_SCENARIOS['turn-rung'], options: { portPrediction: true, turn: APP_TURN } },
    { mutate: room => { room.predictionPair = () => { throw new Error('boom'); }; } });
  assert.deepEqual(paths(run).slice(0, 2), ['5000:unreachable', '35000:unreachable']);
  assert.equal(run.final.counters.rungErrors, 2);
  assert.equal(run.final.counters.linkErrors, 0);
});

test('opt-in options are validated', () => {
  assert.throws(() => new Room({ gates, classifyNat: 'yes' }), /classifyNat must be a boolean/);
  assert.throws(() => new Room({ gates, portPrediction: 1 }), /portPrediction must be a boolean/);
  assert.throws(() => new Room({ gates, portPrediction: true, classifyNat: false }), /portPrediction needs classifyNat/);
  for (const turn of [[{ urls: 'stun:stun.invalid:3478', username: 'u', credential: 'c' }], [{ urls: ['turn:t.invalid'], username: '', credential: 'c' }],
    [{ urls: [], username: 'u', credential: 'c' }], [{ urls: Array(9).fill('turn:t.invalid'), username: 'u', credential: 'c' }],
    Array(3).fill({ urls: 'turn:t.invalid', username: 'u', credential: 'c' }), [{ urls: 'turn:t.invalid', username: 'u', credential: 'c'.repeat(257) }], 'turn:t.invalid'])
    assert.throws(() => new Room({ gates, turn }), /Invalid application TURN servers/, JSON.stringify(turn).slice(0, 60));
  const room = new Room({ gates, turn: [{ urls: 'turns:t.invalid:5349?transport=tcp', username: 'u', credential: 'c' }] });
  assert.deepEqual(room.turnServers, [{ urls: ['turns:t.invalid:5349?transport=tcp'], username: 'u', credential: 'c' }]);
  assert.equal(new Room({ gates }).turnServers, null);
  assert.equal(new Room({ gates, turn: [] }).turnServers, null);
  assert.throws(() => room.setTurn([{ urls: 'http://t.invalid', username: 'u', credential: 'c' }]), /Invalid application TURN servers/);
  room.setTurn(null);
  assert.equal(room.turnServers, null);
  const plain = new Room({ gates });
  assert.equal(plain.classifyNatEnabled, false); assert.equal(plain.portPredictionEnabled, false);
  assert.equal(new Room({ gates, portPrediction: true }).classifyNatEnabled, true);
});

test('NAT classification is shared only when enabled, and a peer\'s claim is validated', async () => {
  const on = await runScenario(FEATURE_SCENARIOS['classify-sequential']);
  assert.ok(on.trace.some(e => e.out === 'caps' && e.caps.nat?.type === 'sequential' && e.caps.nat.delta === 1));
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    const off = await runScenario(scenario);
    assert.ok(off.trace.every(e => !(e.out === 'caps' || e.out === 'description') || !('nat' in (e.caps ?? {}))), name);
  }
  const room = new Room({ gates, classifyNat: true });
  room.updateCaps(IDS.B, { forward: true, peers: [], nat: { type: 'sequential', delta: 2 } });
  assert.deepEqual(room.caps.get(IDS.B).nat, { type: 'sequential', delta: 2 });
  room.updateCaps(IDS.C, { forward: true, peers: [], nat: { type: 'sequential', delta: 99 } });
  assert.equal('nat' in room.caps.get(IDS.C), false);
  const plain = new Room({ gates });
  plain.updateCaps(IDS.B, { forward: true, peers: [], nat: { type: 'eim', delta: 0 } });
  assert.deepEqual(Object.keys(plain.caps.get(IDS.B)), ['role', 'forward', 'peers', 'gateway']);
});

test('stats() reports the classification only when it is enabled', async () => {
  const plain = new Room({ gates });
  assert.equal('nat' in await plain.stats(), false);
  const room = new Room({ gates, classifyNat: true, stun: ['stun:a.invalid:3478', 'stun:b.invalid:3478'] });
  room.scheduleCapsBroadcast = () => {};
  assert.deepEqual((await room.stats()).nat, { type: 'unknown', delta: 0 });
  room.observeNat({ samples: [{ address: '203.0.113.10', port: 40001, base: '' }, { address: '203.0.113.10', port: 40002, base: '' }], errors: 0 }, true);
  assert.deepEqual((await room.stats()).nat, { type: 'sequential', delta: 1 });
  room.observeNat({ samples: [], errors: 0 }, true);
  assert.deepEqual(room.nat, { type: 'sequential', delta: 1 }, 'an inconclusive generation keeps the last verdict');
});

test('relay paths through the application TURN servers are attributed to "turn"', () => {
  const room = new Room({ gates, turn: [{ urls: ['turn:198.18.9.9:3478?transport=udp', 'turns:relay.invalid:5349?transport=tcp'], username: 'u', credential: 'c' }] });
  assert.equal(room.gatewayOwner({ local: 'relay', relayProtocol: 'udp', relayUrl: 'turn:198.18.9.9:3478', localAddress: '198.18.9.9' }), 'turn');
  assert.equal(room.gatewayOwner({ local: 'relay', relayProtocol: 'tls', relayUrl: 'turns:relay.invalid:5349?transport=tcp' }), 'turn');
  assert.equal(room.gatewayOwner({ local: 'srflx', remote: 'relay', remoteAddress: '198.18.9.9' }), 'turn');
  assert.equal(room.gatewayOwner({ local: 'relay', relayProtocol: 'udp', relayUrl: 'turn:other.invalid:3478' }), 'unknown');
  assert.equal(new Room({ gates }).gatewayOwner({ local: 'relay', relayProtocol: 'udp', relayUrl: 'turn:198.18.9.9:3478' }), 'unknown');
});
