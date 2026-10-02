// SPDX-License-Identifier: Apache-2.0
// Local mesh smoke test: N real browsers join one room through a gate and exchange fake
// camera/microphone media. Usage: node test/browser/smoke.mjs [chromium,firefox,webkit,...]
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startServices, launchPeer, openAndJoin, waitUntil, summarize, writeEvidence, sleep, selfSignedCert } from './lab.mjs';

const kinds = (process.argv[2] ?? 'chromium,chromium,chromium').split(',');
const lan = Object.values(networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)?.address;
const report = { schema: 1, test: 'local-mesh-smoke', kinds, startedAt: new Date().toISOString(), peers: [], passed: false };
let services; const peers = [];
try {
  const tls = process.argv.includes('--tls') ? selfSignedCert(mkdtempSync(tmpdir() + '/peerlane-tls-'), '127.0.0.1') : undefined;
  services = await startServices({ host: '127.0.0.1', tls });
  report.origin = services.origin;
  const secret = randomBytes(32).toString('base64url');
  for (const kind of kinds) peers.push(await launchPeer(kind, { origin: services.origin }));
  for (const peer of peers) await openAndJoin(peer, services.origin, { gates: [services.gateUrl], secret, app: 'smoke', media: { audio: true, video: true } });
  const expected = peers.length - 1;
  const ready = await waitUntil(async () => {
    const all = await Promise.all(peers.map(p => p.page.evaluate(() => window.peerlaneTest.stats())));
    return all.every(s => s.links.filter(l => l.connected && (l.media.inbound.audio?.packets ?? 0) > 50 && (l.media.inbound.video?.frames ?? 0) > 30).length === expected) && all;
  }, { timeoutMs: 45000 });
  const final = ready || await Promise.all(peers.map(p => p.page.evaluate(() => window.peerlaneTest.stats())));
  report.peers = peers.map((p, i) => ({ kind: p.kind, version: p.version, id: p.id, links: summarize(final[i]), counters: final[i].counters, errors: p.errors.slice(0, 10) }));
  report.gate = services.gate.stats();
  report.events = await Promise.all(peers.map(p => p.page.evaluate(() => window.peerlaneTest.events.filter(e => e.t !== 'track').slice(0, 60))));
  assert.ok(ready, 'every peer must receive audio and video from every other peer');
  for (const p of report.peers) for (const l of p.links) assert.equal(l.path, 'direct', `${p.kind} -> ${l.peer} path ${l.path}`);
  await Promise.all(peers.map(p => p.page.evaluate(() => window.peerlaneTest.leave())));
  await sleep(500);
  report.gateAfterLeave = services.gate.stats();
  assert.equal(services.gate.rooms(), 0);
  report.passed = true;
} catch (error) {
  report.error = error.message;
} finally {
  for (const p of peers) await p.browser.close().catch(() => {});
  await services?.close();
  report.evidence = await writeEvidence('smoke-' + kinds.join('-'), report);
  for (const p of report.peers) console.log(p.kind.padEnd(9), p.id?.slice(0, 6), p.links.map(l => `${l.peer.slice(0, 6)}:${l.path}/${l.local}->${l.remote} a=${l.audioPackets} v=${l.videoFrames} ${l.videoSize ?? ''} ${l.connectMs}ms`).join(' | '));
  console.log('gate bytes in/out:', report.gate?.bytesIn, report.gate?.bytesOut, 'envelopes:', report.gate?.envelopes);
  console.log(report.passed ? 'PASS' : 'FAIL: ' + report.error, report.evidence);
  if (lan) void lan;
  process.exitCode = report.passed ? 0 : 1;
}
