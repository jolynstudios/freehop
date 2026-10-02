// SPDX-License-Identifier: Apache-2.0
// Many gates, no single point: A only knows gate 1, C only knows gate 2, B knows both.
// A and C never share a gate, yet must find each other through B's introduction and
// negotiate through the mesh. Then every gate is shut down: calls must keep running.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createGate } from '../../src/gate/gate.mjs';
import { startServices, launchPeer, openAndJoin, waitUntil, summarize, writeEvidence, sleep } from './lab.mjs';

const report = { schema: 1, test: 'multi-gate-introduction-and-gate-outage', passed: false };
let services, gate2; const peers = [];
try {
  services = await startServices({ host: '127.0.0.1' });
  gate2 = await createGate({ host: '127.0.0.1', port: 0 });
  const g1 = services.gateUrl, g2 = gate2.url();
  const secret = randomBytes(32).toString('base64url');
  const plan = [['A', [g1]], ['B', [g1, g2]], ['C', [g2]]];
  for (const [name, gates] of plan) {
    const p = await launchPeer('chromium', { origin: services.origin }); p.name = name; peers.push(p);
    await openAndJoin(p, services.origin, { gates, secret, app: 'multigate', media: { audio: true, video: true } });
  }
  const names = Object.fromEntries(peers.map(p => [p.id, p.name]));
  const all = () => Promise.all(peers.map(p => p.page.evaluate(() => window.peerlaneTest.stats())));
  const meshUp = s => s.every(x => x.links.filter(l => l.connected && (l.media.inbound.audio?.packets ?? 0) > 30 && (l.media.inbound.video?.frames ?? 0) > 20).length === 2);
  const up = await waitUntil(async () => { const s = await all(); return meshUp(s) && s; }, { timeoutMs: 45000 });
  const before = up || await all();
  report.before = before.map((s, i) => ({ peer: peers[i].name, links: summarize(s).map(l => ({ ...l, peer: names[l.peer] })), counters: s.counters }));
  assert.ok(up, 'full mesh must form although A and C share no gate');
  const a = before[0].counters, c = before[2].counters;
  assert.ok(a.viaIntroducer + c.viaIntroducer > 0, 'A<->C signalling must have been introduced through B');
  report.gateStats = { gate1: services.gate.stats(), gate2: gate2.stats() };
  // Shut down every gate. Established calls do not depend on any gate.
  await services.gate.close(); await gate2.close(); gate2 = null;
  const packets = s => s.map(x => x.links.reduce((n, l) => n + (l.media.inbound.audio?.packets ?? 0), 0));
  const p0 = packets(await all());
  await sleep(6000);
  const after = await all();
  const p1 = packets(after);
  report.afterGateOutage = after.map((s, i) => ({ peer: peers[i].name, connected: s.links.filter(l => l.connected).length, audioPacketsGained: p1[i] - p0[i] }));
  assert.ok(report.afterGateOutage.every(x => x.connected === 2 && x.audioPacketsGained > 150), 'media must keep flowing with all gates down');
  report.passed = true;
} catch (error) { report.error = error.message; }
finally {
  for (const p of peers) await p.browser.close().catch(() => {});
  await gate2?.close().catch(() => {});
  await services?.close().catch(() => {});
  report.evidence = await writeEvidence('multigate', report);
  for (const b of report.before ?? []) console.log(b.peer, b.links.map(l => `${l.peer}:${l.path} a=${l.audioPackets} v=${l.videoFrames}`).join(' | '), 'introducer=', b.counters.viaIntroducer, 'meshForwarded=', b.counters.meshForwarded);
  console.log('after all gates closed:', JSON.stringify(report.afterGateOutage));
  console.log(report.passed ? 'PASS' : 'FAIL: ' + report.error, report.evidence);
  process.exitCode = report.passed ? 0 : 1;
}
