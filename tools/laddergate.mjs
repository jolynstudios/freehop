// SPDX-License-Identifier: Apache-2.0
// laddergate — the path ladder must decide exactly what it decided when its baseline was stamped.
// WHY THIS EXISTS: new rungs (NAT classification, port prediction, an application TURN relay) are
// opt-in layers on a ladder that real calls depend on. Every scripted situation below runs one real
// Room and its real PeerLinks on a fake peer connection and a virtual clock, and the canonical trace
// of every decision (outgoing signalling before sealing, events, peer-connection calls, final link
// state) must equal tools/baselines/ladder.json byte for byte. Scenarios with the new options unset
// were stamped before any of those features existed.
// It does NOT prove: real ICE, NAT or media behaviour (browser suites and the NAT lab do), gate
// transport, or sealing; the remote members are scripts, not Rooms.
//
// Usage: node tools/laddergate.mjs [--stamp-new] [--restamp=<scenario,...>] [--falsify=<name>]
//   --stamp-new           record scenarios that have no baseline yet; never touches existing ones
//   --restamp=a,b         overwrite the named scenarios (you reviewed the diff they print first)
// Negative controls:
//   every run re-runs "grace" with endpointMs + 1 ms and requires the comparison to go red
//   --falsify=timer|server-order|path-kind|caps-shape   inject that drift; the gate must exit 1
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FEATURE_SCENARIOS, SCENARIOS, runScenario } from '../test/fakes/ladder-harness.mjs';
import { canonicalJson, falsifier, firstDifference, isMain, listArg, read, root, sha256 } from './gate-lib.mjs';

const TOOL = 'laddergate';
export const BASELINE = 'tools/baselines/ladder.json';

export const FALSIFIERS = {
  timer: room => { room.timing.endpointMs += 1; },
  'server-order': room => { const iceServersFor = room.iceServersFor.bind(room); room.iceServersFor = link => [...iceServersFor(link)].reverse(); },
  'path-kind': room => { const emit = room.emit.bind(room); room.emit = (type, detail) => emit(type, type === 'path' && detail?.kind === 'unreachable' ? { ...detail, kind: 'no-route' } : detail); },
  'caps-shape': room => { const capsFor = room.capsFor.bind(room); room.capsFor = async peer => ({ ...await capsFor(peer), extra: true }); },
};

export async function runAll(scenarios = SCENARIOS, mutate) {
  const out = {};
  for (const [name, scenario] of Object.entries(scenarios)) out[name] = await runScenario(scenario, { mutate });
  return out;
}

export function compare(baseline, actual) {
  const expected = baseline.scenarios ?? {};
  const missing = Object.keys(expected).filter(name => !(name in actual));
  const added = Object.keys(actual).filter(name => !(name in expected));
  const changed = Object.keys(actual).filter(name => name in expected)
    .map(name => ({ name, difference: firstDifference(JSON.parse(canonicalJson(expected[name])), JSON.parse(canonicalJson(actual[name]))) }))
    .filter(entry => entry.difference);
  return { missing, added, changed };
}

const loadBaseline = () => existsSync(resolve(root, BASELINE)) ? JSON.parse(read(BASELINE)) : { schema: 1, scenarios: {} };

if (isMain(import.meta.url)) {
  const falsify = falsifier(TOOL, Object.keys(FALSIFIERS));
  const stampNew = process.argv.includes('--stamp-new'), restamp = listArg('restamp');
  if (falsify && (stampNew || restamp)) { console.error(`${TOOL}: FAIL — --falsify cannot be combined with stamping`); process.exit(2); }
  const baseline = loadBaseline();
  const actual = await runAll({ ...SCENARIOS, ...FEATURE_SCENARIOS }, falsify ? FALSIFIERS[falsify] : undefined);
  const result = compare(baseline, actual);

  if (stampNew || restamp) {
    const unknown = (restamp ?? []).filter(name => !(name in actual));
    if (unknown.length) { console.error(`${TOOL}: FAIL — --restamp names unknown scenarios: ${unknown.join(', ')}`); process.exit(2); }
    const stamped = [];
    for (const name of result.added) if (stampNew) { baseline.scenarios[name] = actual[name]; stamped.push(`${name} (new)`); }
    for (const name of restamp ?? []) {
      const change = result.changed.find(entry => entry.name === name);
      if (change) console.log(`  restamp ${name}: ${change.difference}`);
      baseline.scenarios[name] = actual[name]; stamped.push(name);
    }
    writeFileSync(resolve(root, BASELINE), canonicalJson({ schema: 1, scenarios: baseline.scenarios }));
    console.log(`${TOOL}: stamped ${stamped.length ? stamped.join(', ') : 'nothing'} — review the baseline diff before committing`);
    process.exit(0);
  }

  // Witnessed red: the comparison must notice a 1 ms change to the first watchdog.
  const control = await runScenario(SCENARIOS.grace, { mutate: FALSIFIERS.timer });
  const witnessed = !!baseline.scenarios.grace && !!firstDifference(JSON.parse(canonicalJson(baseline.scenarios.grace)), JSON.parse(canonicalJson(control)));

  const problems = [
    ...result.missing.map(name => `scenario ${name} disappeared`),
    ...result.added.map(name => `scenario ${name} has no baseline (run --stamp-new after review)`),
    ...result.changed.map(({ name, difference }) => `${name} ${difference}`),
    ...Object.entries(actual).filter(([, run]) => run.errors.length).map(([name, run]) => `${name} raised: ${run.errors.join('; ')}`),
    ...(witnessed ? [] : ['negative control (grace, endpointMs + 1) was not witnessed red']),
  ];
  const entries = Object.values(actual).reduce((sum, run) => sum + run.trace.length, 0);
  const report = process.env.FREEHOP_LADDER_REPORT;
  if (report) {
    const pkg = JSON.parse(read('package.json'));
    writeFileSync(resolve(report), `${JSON.stringify({ schema: 1, status: problems.length ? 'failed' : 'passed', completedAt: new Date().toISOString(),
      scope: 'in-process fake peer connection and virtual clock: ladder decisions only, not ICE, NAT, media or gate transport',
      sdk: { version: pkg.version, roomSha256: sha256(read('src/client/room.mjs')), peerSha256: sha256(read('src/client/peer.mjs')) },
      falsifier: falsify, scenarios: Object.keys(actual), traceEntries: entries, problems }, null, 2)}\n`, { flag: 'wx' });
  }
  if (problems.length) {
    for (const problem of problems) console.error(`  FAIL ${problem}`);
    console.error(`${TOOL}: FAIL — ${problems.length} problem${problems.length === 1 ? '' : 's'}${falsify ? ` (falsifier ${falsify})` : ''}`);
    process.exit(1);
  }
  console.log(`${TOOL}: PASS — ${Object.keys(actual).length} scenarios, ${entries} trace entries equal the baseline; endpointMs + 1 ms witnessed red`);
}
