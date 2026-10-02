// SPDX-License-Identifier: Apache-2.0
// Kick flow: A, B and C share a room. The application kicks C by handing A and B a new
// secret (rekey) and dropping C. A<->B media must continue without interruption, C must lose
// both links and stay out, and a newcomer D with the new secret must join A and B.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startServices, launchPeer, openAndJoin, waitUntil, writeEvidence, sleep } from './lab.mjs';

const report = { schema: 1, test: 'kick-rekey-drop', passed: false };
let services; const peers = {};
const stats = p => p.page.evaluate(() => window.peerlaneTest.stats());
const connectedTo = (s, id) => s.links.some(l => l.peer === id && l.connected);
const audioFrom = (s, id) => s.links.find(l => l.peer === id)?.media.inbound.audio?.packets ?? 0;
try {
  services = await startServices({ host: '127.0.0.1' });
  const oldSecret = randomBytes(32).toString('base64url'), newSecret = randomBytes(32).toString('base64url');
  for (const name of ['A', 'B', 'C']) {
    peers[name] = await launchPeer('chromium', { origin: services.origin });
    await openAndJoin(peers[name], services.origin, { gates: [services.gateUrl], secret: oldSecret, app: 'kick', media: { audio: true, video: false } });
  }
  const { A, B, C } = peers;
  assert.ok(await waitUntil(async () => { const [a, b, c] = await Promise.all([stats(A), stats(B), stats(C)]);
    return connectedTo(a, B.id) && connectedTo(a, C.id) && connectedTo(b, C.id); }, { timeoutMs: 30000 }), 'initial mesh');
  const before = audioFrom(await stats(A), B.id);
  // Kick C: A and B rotate the secret and drop C.
  for (const p of [A, B]) await p.page.evaluate(({ secret, kicked }) => { window.room.rekey(secret); window.room.drop(kicked); }, { secret: newSecret, kicked: C.id });
  await sleep(4000);
  const [a1, b1, c1] = await Promise.all([stats(A), stats(B), stats(C)]);
  report.afterKick = { abConnected: connectedTo(a1, B.id), aHasC: connectedTo(a1, C.id), bHasC: connectedTo(b1, C.id),
    cLinks: c1.links.filter(l => l.connected).length, abAudioGained: audioFrom(a1, B.id) - before };
  assert.ok(report.afterKick.abConnected && report.afterKick.abAudioGained > 100, 'A<->B continue through the kick');
  assert.ok(!report.afterKick.aHasC && !report.afterKick.bHasC, 'A and B dropped C');
  // A newcomer with the new secret joins the remaining members; C (old secret) cannot.
  peers.D = await launchPeer('chromium', { origin: services.origin });
  await openAndJoin(peers.D, services.origin, { gates: [services.gateUrl], secret: newSecret, app: 'kick', media: { audio: true, video: false } });
  const joined = await waitUntil(async () => { const d = await stats(peers.D); return connectedTo(d, A.id) && connectedTo(d, B.id) && d; }, { timeoutMs: 30000 });
  assert.ok(joined, 'D joins A and B under the new secret');
  // C's side notices within ICE consent freshness once A and B have closed their links.
  const c2 = await waitUntil(async () => { const c = await stats(C); return c.links.every(l => !l.connected) && c; }, { timeoutMs: 30000 }) || await stats(C);
  report.kickedPeer = { links: c2.links.filter(l => l.connected).map(l => l.peer), seesD: c2.links.some(l => l.peer === peers.D.id) };
  assert.ok(!report.kickedPeer.seesD && report.kickedPeer.links.length === 0, 'C stays out');
  report.passed = true;
} catch (error) { report.error = error.message; }
finally {
  for (const p of Object.values(peers)) await p.browser.close().catch(() => {});
  await services?.close();
  report.evidence = await writeEvidence('kick-rekey', report);
  console.log(JSON.stringify({ afterKick: report.afterKick, kickedPeer: report.kickedPeer }));
  console.log(report.passed ? 'PASS' : 'FAIL: ' + report.error, report.evidence);
  process.exitCode = report.passed ? 0 : 1;
}
