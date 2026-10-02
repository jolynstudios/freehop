// SPDX-License-Identifier: Apache-2.0
// Magnet-style operation: peers meet through a public WebTorrent tracker only — no gate of
// our own at all. Usage: node test/browser/tracker.mjs [wss://tracker.openwebtorrent.com]
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startServices, launchPeer, openAndJoin, waitUntil, summarize, writeEvidence } from './lab.mjs';

const tracker = process.argv[2] ?? 'wss://tracker.openwebtorrent.com';
const report = { schema: 1, test: 'public-webtorrent-tracker-as-only-gate', tracker, passed: false };
let services; const peers = [];
try {
  services = await startServices({ host: '127.0.0.1' });   // serves the page only; its gate is unused
  const secret = randomBytes(32).toString('base64url');
  for (let i = 0; i < 3; i++) {
    const p = await launchPeer('chromium', { origin: services.origin }); peers.push(p);
    await openAndJoin(p, services.origin, { gates: ['bt+' + tracker], secret, app: 'tracker-test', media: { audio: true, video: true } });
  }
  const up = await waitUntil(async () => {
    const all = await Promise.all(peers.map(p => p.page.evaluate(() => window.peerlaneTest.stats())));
    return all.every(s => s.links.filter(l => l.connected && (l.media.inbound.audio?.packets ?? 0) > 30 && (l.media.inbound.video?.frames ?? 0) > 20).length === 2) && all;
  }, { timeoutMs: 90000, intervalMs: 1000 });
  const final = up || await Promise.all(peers.map(p => p.page.evaluate(() => window.peerlaneTest.stats())));
  report.peers = final.map(s => ({ links: summarize(s), gates: s.gates, counters: s.counters }));
  report.ownGateEnvelopes = services.gate.stats().envelopes;
  assert.ok(up, 'mesh must form through the public tracker alone');
  assert.equal(report.ownGateEnvelopes, 0, 'our own gate must not have been used');
  report.passed = true;
} catch (error) { report.error = error.message; }
finally {
  for (const p of peers) { await p.page.evaluate(() => window.peerlaneTest?.leave()).catch(() => {}); await p.browser.close().catch(() => {}); }
  await services?.close();
  report.evidence = await writeEvidence('tracker', report);
  for (const p of report.peers ?? []) console.log(p.links.map(l => `${l.peer.slice(0, 6)}:${l.path} a=${l.audioPackets} v=${l.videoFrames}`).join(' | '), '| tracker msgs in/out', p.gates[0]?.received, p.gates[0]?.sent);
  console.log(report.passed ? 'PASS' : 'FAIL: ' + report.error, report.evidence);
  process.exitCode = report.passed ? 0 : 1;
}
