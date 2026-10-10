// SPDX-License-Identifier: Apache-2.0
// Leaving the application TURN relay: a pair it carries keeps checking for a cheaper route with the
// relay still configured, moves when one works and then releases the relay; afterwards TURN is still
// the last rung of the ladder. Pairs that never used the relay, and applications without one, are
// never restarted for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_TURN, FEATURE_SCENARIOS, SCENARIOS, runScenario } from './fakes/ladder-harness.mjs';

const paths = run => run.trace.filter(e => e.event === 'path').map(e => `${e.t}:${e.kind}${e.via ? `@${e.via}` : ''}`);
const restarts = run => run.trace.filter(e => e.call === 'restartIce').map(e => e.t);
const servers = run => run.trace.filter(e => e.call === 'new' || e.call === 'setConfiguration')
  .map(e => `${e.t}:${e.iceServers.some(s => s.username === 'u-app') ? 'turn' : '-'}${e.iceServers.some(s => s.username === 'u-b') ? '+gwB' : ''}`);
const turnCounters = run => Object.fromEntries(Object.entries(run.final.counters).filter(([name]) => name.startsWith('turn')));

test('a pair on the TURN relay checks for a cheaper route with the relay still configured, and stays when none exists', async () => {
  const run = await runScenario(FEATURE_SCENARIOS['turn-stays']);
  assert.deepEqual(paths(run), ['5270:relay@turn']);
  assert.deepEqual(restarts(run), [5000, 65270, 190000], 'the rung, then checks 60 s after connecting and 120 s after that');
  assert.deepEqual(servers(run), ['0:-', '5000:turn', '65270:turn', '190000:turn'], 'the relay stays configured while it carries the call');
  assert.deepEqual(turnCounters(run), { turnAttempts: 1, turnProbes: 2 });
});

test('a check that finds a direct route moves the pair off the relay, which is released two media checks later', async () => {
  const run = await runScenario(FEATURE_SCENARIOS['turn-upgrade-direct']);
  assert.deepEqual(paths(run).slice(0, 2), ['5270:relay@turn', '70000:direct']);
  assert.deepEqual(servers(run).slice(0, 4), ['0:-', '5000:turn', '65270:turn', '80000:-']);
  assert.deepEqual(restarts(run).slice(0, 3), [5000, 65270, 80000], 'the release starts a fresh ICE generation without the relay');
});

test('after a release, TURN is again the last rung when the cheaper route breaks', async () => {
  const run = await runScenario(FEATURE_SCENARIOS['turn-upgrade-direct']);
  // The direct route fails at 120 s: first a restart without the relay, then the ladder, with TURN last.
  assert.deepEqual(restarts(run).slice(3), [120000, 127000]);
  assert.deepEqual(servers(run).slice(4), ['127000:turn']);
  assert.equal(paths(run).at(-1), '127270:relay@turn');
  assert.deepEqual(turnCounters(run), { turnAttempts: 2, turnProbes: 1, turnReleases: 1 });
});

test('a gateway that appears mid-call is tried within seconds, and the relay is released once the gateway carries the pair', async () => {
  const run = await runScenario(FEATURE_SCENARIOS['turn-upgrade-gateway']);
  assert.deepEqual(paths(run), ['5270:relay@turn', '25000:gateway@B']);
  assert.deepEqual(servers(run), ['0:-', '5000:turn', '21000:turn+gwB', '35000:-+gwB']);
  assert.deepEqual(restarts(run), [5000, 21000, 35000]);
  assert.deepEqual(turnCounters(run), { turnAttempts: 1, turnProbes: 1, turnReleases: 1 });
});

test('the polite side never restarts to leave the relay: it drops it from the servers it answers with', async () => {
  const run = await runScenario(FEATURE_SCENARIOS['turn-upgrade-polite']);
  assert.deepEqual(paths(run), ['7970:relay@turn', '35000:direct']);
  assert.deepEqual(restarts(run), [7700], 'only the polite fallback restart of the TURN rung itself');
  assert.deepEqual(servers(run), ['200:-', '5200:turn', '35000:-']);
  assert.deepEqual(turnCounters(run), { turnAttempts: 1, turnReleases: 1 });
});

test('removing the application TURN servers mid-call never restarts the pair for it', async () => {
  const stays = FEATURE_SCENARIOS['turn-stays'];
  const run = await runScenario({ ...stays, setup(context) { stays.setup(context); setTimeout(() => context.room.setTurn(null), 30000); } });
  assert.deepEqual(restarts(run), [5000]);
  assert.deepEqual(servers(run), ['0:-', '5000:turn', '30000:-']);
  assert.deepEqual(turnCounters(run), { turnAttempts: 1 });
});

test('pairs that never used the relay are never restarted for it, whether or not the application configured one', async () => {
  for (const name of ['direct-impolite', 'direct-polite', 'own-gateway', 'peer-gateway', 'session-gateway', 'bridged', 'recovery', 'failed']) {
    const scenario = { ...SCENARIOS[name], mediaWatch: true, runMs: 200000 };
    const withTurn = await runScenario({ ...scenario, options: { ...scenario.options, turn: APP_TURN } });
    const without = await runScenario(scenario);
    assert.deepEqual(restarts(withTurn), restarts(without), name);
    assert.deepEqual(paths(withTurn), paths(without), name);
    assert.deepEqual(turnCounters(withTurn), {}, name);
  }
});
