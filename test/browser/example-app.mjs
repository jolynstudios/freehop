// SPDX-License-Identifier: Apache-2.0
// The SDK as a third-party app sees it: three browsers use the minimal example's UI and API
// only (join, tickets, kick). Asserts media flows in the full mesh, the kick rotates the
// room for the remaining members without interrupting them, and the kicked member is out.
import assert from 'node:assert/strict';
import { startExample } from '../../examples/minimal/server.mjs';
import { launchPeer, waitUntil, writeEvidence } from './lab.mjs';

const report = { schema: 1, test: 'sdk-example-app', passed: false };
let example; const peers = [];
const state = p => p.page.evaluate(async () => {
  const s = window.demo.session; if (!s) return { state: window.demo.state };
  const st = await s.stats();
  return { state: window.demo.state, id: s.id, epoch: window.demo.epoch ?? 1, member: window.demo.member,
    links: st.links.map(l => ({ peer: l.peer, connected: l.connected, path: l.path.kind, a: l.media.inbound.audio?.packets ?? 0, v: l.media.inbound.video?.frames ?? 0 })) };
});
try {
  example = await startExample();
  for (let i = 0; i < 3; i++) {
    const p = await launchPeer('chromium', { origin: example.origin }); peers.push(p);
    await p.page.goto(example.origin + '/');
    await p.page.click('#join button');
    await p.page.waitForFunction(() => window.demo.state === 'joined');
  }
  const mesh = await waitUntil(async () => { const all = await Promise.all(peers.map(state));
    return all.every(s => s.links.filter(l => l.connected && l.a > 30 && l.v > 20).length === 2) && all; }, { timeoutMs: 45000 });
  report.mesh = mesh;
  assert.ok(mesh, 'full audio/video mesh through the example app');
  // Kick the third member through the app API.
  const [a, b, c] = mesh;
  const kicked = await (await fetch(example.origin + '/api/kick', { method: 'POST', body: JSON.stringify({ member: c.member }) })).json();
  assert.equal(kicked.epoch, 2);
  const after = await waitUntil(async () => { const all = await Promise.all(peers.map(state));
    return all[0].epoch === 2 && all[1].epoch === 2 && all[2].state === 'kicked' &&
      !all[0].links.some(l => l.peer === c.id && l.connected) && !all[1].links.some(l => l.peer === c.id && l.connected) && all; }, { timeoutMs: 20000 });
  report.after = after;
  assert.ok(after, 'remaining members rotated to epoch 2, dropped the kicked peer, kicked member left');
  const ab = after[0].links.find(l => l.peer === b.id), before = a.links.find(l => l.peer === b.id);
  assert.ok(ab?.connected && ab.a > before.a + 50, 'A<->B media continued through the rotation');
  report.passed = true;
} catch (error) { report.error = error.message; }
finally {
  for (const p of peers) await p.browser.close().catch(() => {});
  await example?.close();
  report.evidence = await writeEvidence('sdk-example', report);
  console.log(report.passed ? 'PASS' : 'FAIL: ' + report.error, report.evidence);
  process.exitCode = report.passed ? 0 : 1;
}
