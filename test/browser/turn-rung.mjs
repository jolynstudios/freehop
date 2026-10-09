// SPDX-License-Identifier: Apache-2.0
// The opt-in application TURN rung in real browsers: two Chromium peers whose pages accept only relayed
// remote candidates (so no direct or in-session route can exist) first stay unreachable without the
// option, then connect through Freehop's own TURN server once the application configures it, with the
// path reported as relay via "turn". Same machine, LAN IPv4: not a WAN or NAT qualification.
// Usage: node test/browser/turn-rung.mjs [--ip=A.B.C.D]
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { createTurnServer } from '../../src/relay/turn-server.mjs';
import { startServices, launchPeer, openAndJoin, waitUntil, summarize, writeEvidence, sleep } from './lab.mjs';

const explicit = process.argv.find(a => a.startsWith('--ip='))?.slice(5);
const ip = explicit ?? Object.entries(networkInterfaces()).flatMap(([name, list]) => (list ?? []).map(i => ({ name, ...i })))
  .filter(i => i.family === 'IPv4' && !i.internal).sort((a, b) => (b.name === 'en0') - (a.name === 'en0'))[0]?.address;
if (!ip) { console.log('turn-rung: SKIP — no LAN IPv4 address (browsers ignore loopback for ICE); pass --ip='); process.exit(0); }

// Pages drop every non-relayed remote candidate: the only possible route is through a TURN relay.
const RELAY_ONLY = `(() => {
  const add = RTCPeerConnection.prototype.addIceCandidate;
  RTCPeerConnection.prototype.addIceCandidate = function (candidate, ...rest) {
    const text = candidate?.candidate ?? '';
    if (text && !/ typ relay( |$)/.test(text)) return Promise.resolve();
    return add.call(this, candidate, ...rest);
  };
})();`;

const report = { schema: 1, test: 'turn-rung', ip, startedAt: new Date().toISOString(), scope: 'same machine, LAN IPv4, Chromium; relayed remote candidates only', passed: false };
let services, turn; const peers = [];
const paths = async peer => (await peer.page.evaluate(() => window.peerlaneTest.events.filter(e => e.t === 'path'))).map(e => `${e.kind}${e.via ? `@${e.via}` : ''}`);
try {
  const credentials = { username: `u-${randomBytes(4).toString('hex')}`, password: randomBytes(12).toString('base64url') };
  turn = await createTurnServer({ listen: [{ transport: 'udp', host: ip, port: 0 }], realm: 'freehop-turn-rung',
    authenticate: async u => (u === credentials.username ? credentials.password : null), allowPeer: () => true });
  const relay = turn.addresses().find(a => a.transport === 'udp');
  const servers = [{ urls: [`turn:${relay.address}:${relay.port}?transport=udp`], username: credentials.username, credential: credentials.password }];
  services = await startServices({ host: '127.0.0.1' });
  const timing = { endpointMs: 3000, sessionMs: 4000, turnMs: 8000 };
  for (const kind of ['chromium', 'chromium']) {
    const peer = await launchPeer(kind, { origin: services.origin });
    await peer.page.addInitScript(RELAY_ONLY);
    peers.push(peer);
  }

  // Control: without the option the pair has no route at all.
  const control = randomBytes(32).toString('base64url');
  for (const peer of peers) await openAndJoin(peer, services.origin, { gates: [services.gateUrl], secret: control, app: 'turn-rung', media: { audio: true, video: false }, timing });
  const unreachable = await waitUntil(async () => (await Promise.all(peers.map(paths))).every(list => list.includes('unreachable')), { timeoutMs: 20000 });
  report.control = await Promise.all(peers.map(paths));
  assert.ok(unreachable, 'without a TURN relay the relay-only pair must report unreachable');
  await Promise.all(peers.map(p => p.page.evaluate(() => window.peerlaneTest.leave())));
  await sleep(500);

  // With the application's TURN servers the same pair connects through the relay rung.
  const secret = randomBytes(32).toString('base64url');
  for (const peer of peers) await openAndJoin(peer, services.origin, { gates: [services.gateUrl], secret, app: 'turn-rung', media: { audio: true, video: false }, timing, turn: servers });
  const ready = await waitUntil(async () => {
    const all = await Promise.all(peers.map(p => p.page.evaluate(() => window.peerlaneTest.stats())));
    return all.every(s => s.links.length === 1 && s.links[0].connected && s.links[0].path.kind === 'relay' && s.links[0].path.via === 'turn' &&
      (s.links[0].media.inbound.audio?.packets ?? 0) > 50) && all;
  }, { timeoutMs: 45000 });
  const final = ready || await Promise.all(peers.map(p => p.page.evaluate(() => window.peerlaneTest.stats())));
  report.peers = peers.map((p, i) => ({ kind: p.kind, version: p.version, id: p.id, links: summarize(final[i]), counters: final[i].counters, errors: p.errors.slice(0, 10) }));
  report.paths = await Promise.all(peers.map(paths));
  report.turn = turn.stats();
  assert.ok(ready, 'both peers must connect through the application TURN relay and receive audio');
  for (const list of report.paths) assert.ok(!list.includes('unreachable'), `no unreachable before the relay rung: ${list.join(', ')}`);
  report.passed = true;
} catch (error) {
  report.error = error.message;
} finally {
  for (const p of peers) await p.browser.close().catch(() => {});
  await services?.close();
  await turn?.close?.();
  report.evidence = await writeEvidence('turn-rung-chromium', report);
  for (const p of report.peers ?? []) console.log(p.kind.padEnd(9), p.id?.slice(0, 6), p.links.map(l => `${l.peer.slice(0, 6)}:${l.path}@${l.via}/${l.local}->${l.remote} a=${l.audioPackets} ${l.connectMs}ms`).join(' | '));
  console.log('control paths:', JSON.stringify(report.control), 'relay paths:', JSON.stringify(report.paths));
  console.log(report.passed ? 'turn-rung: PASS' : 'turn-rung: FAIL — ' + report.error, report.evidence);
  process.exitCode = report.passed ? 0 : 1;
}
