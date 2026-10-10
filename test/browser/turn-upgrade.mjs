// SPDX-License-Identifier: Apache-2.0
// Leaving the application TURN relay in real browsers: two Chromium peers whose pages first accept only
// relayed remote candidates connect through Freehop's own TURN server. A check for a cheaper route while
// nothing better exists must keep the call on the relay without interrupting it. Once the pages accept
// every candidate again, the pair must move to a direct route by itself and release the relay: its
// allocations end and it stops carrying media. Same machine, LAN IPv4: not a WAN or NAT qualification.
// Usage: node test/browser/turn-upgrade.mjs [--browser=chromium|firefox|webkit] [--ip=A.B.C.D]
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { createTurnServer } from '../../src/relay/turn-server.mjs';
import { startServices, launchPeer, openAndJoin, waitUntil, summarize, writeEvidence, sleep } from './lab.mjs';

const explicit = process.argv.find(a => a.startsWith('--ip='))?.slice(5);
const engine = process.argv.find(a => a.startsWith('--browser='))?.slice(10) ?? 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(engine)) { console.error(`turn-upgrade: unknown --browser=${engine}`); process.exit(2); }
const ip = explicit ?? Object.entries(networkInterfaces()).flatMap(([name, list]) => (list ?? []).map(i => ({ name, ...i })))
  .filter(i => i.family === 'IPv4' && !i.internal).sort((a, b) => (b.name === 'en0') - (a.name === 'en0'))[0]?.address;
if (!ip) { console.log('turn-upgrade: SKIP — no LAN IPv4 address (browsers ignore loopback for ICE); pass --ip='); process.exit(0); }

// While window.relayOnly is set, pages drop every non-relayed remote candidate: the only route is the relay.
const RELAY_ONLY = `(() => {
  window.relayOnly = true;
  const add = RTCPeerConnection.prototype.addIceCandidate;
  RTCPeerConnection.prototype.addIceCandidate = function (candidate, ...rest) {
    const text = candidate?.candidate ?? '';
    if (window.relayOnly && text && !/ typ relay( |$)/.test(text)) return Promise.resolve();
    return add.call(this, candidate, ...rest);
  };
})();`;

const report = { schema: 1, test: 'turn-upgrade', ip, startedAt: new Date().toISOString(), scope: `same machine, LAN IPv4, ${engine}; relayed remote candidates only, then all`, passed: false };
let services, turn, sampler; const peers = [], samples = [];
const started = Date.now();
const link = async peer => (await peer.page.evaluate(() => window.peerlaneTest.stats())).links[0];
// Data the relay forwarded between allocations and peers: media and the ICE checks riding the relay,
// without TURN's own control messages (allocation refreshes and their answers).
const relayed = () => { const s = turn.stats(); return s.bytesToPeers + s.bytesFromPeers; };
// Longest stretch, in ms, in which a peer's inbound audio packet count did not grow.
const longestGap = (from, to) => peers.map((_, i) => {
  let gap = 0, last = null;
  for (const s of samples.filter(s => s.at >= from && s.at <= to)) {
    const packets = s.audio[i];
    if (last && packets > last.packets) last = { packets, at: s.at };
    else if (!last) last = { packets, at: s.at };
    gap = Math.max(gap, s.at - last.at);
  }
  return gap;
});
try {
  const credentials = { username: `u-${randomBytes(4).toString('hex')}`, password: randomBytes(12).toString('base64url') };
  turn = await createTurnServer({ listen: [{ transport: 'udp', host: ip, port: 0 }], realm: 'freehop-turn-upgrade',
    authenticate: async u => (u === credentials.username ? credentials.password : null), allowPeer: () => true });
  const relay = turn.addresses().find(a => a.transport === 'udp');
  const servers = [{ urls: [`turn:${relay.address}:${relay.port}?transport=udp`], username: credentials.username, credential: credentials.password }];
  services = await startServices({ host: '127.0.0.1' });
  const timing = { endpointMs: 3000, sessionMs: 4000, turnMs: 8000, turnUpgradeMs: 8000, mediaWatchMs: 2000 };
  for (const kind of [engine, engine]) {
    const peer = await launchPeer(kind, { origin: services.origin });
    await peer.page.addInitScript(RELAY_ONLY);
    peers.push(peer);
  }
  const secret = randomBytes(32).toString('base64url');
  for (const peer of peers) await openAndJoin(peer, services.origin, { gates: [services.gateUrl], secret, app: 'turn-upgrade', media: { audio: true, video: false }, timing, turn: servers });
  sampler = setInterval(async () => {
    try {
      const links = await Promise.all(peers.map(link));
      samples.push({ at: Date.now() - started, audio: links.map(l => l?.media.inbound.audio?.packets ?? 0), path: links.map(l => `${l?.path.kind}@${l?.path.via}`),
        restarts: links.map(l => l?.restarts ?? 0), allocations: turn.stats().allocations, relayed: relayed() });
    } catch {}
  }, 250);

  // 1. The relay carries the pair.
  const onRelay = await waitUntil(async () => (await Promise.all(peers.map(link))).every(l => l?.connected && l.path.kind === 'relay' && l.path.via === 'turn' &&
    (l.media.inbound.audio?.packets ?? 0) > 50), { timeoutMs: 45000 });
  assert.ok(onRelay, 'both peers must first connect through the application TURN relay and receive audio');
  report.relayAt = Date.now() - started;

  // 2. A check while nothing better exists keeps the call on the relay, without a gap in the audio.
  const before = await Promise.all(peers.map(link));
  const probed = await waitUntil(async () => (await Promise.all(peers.map(link))).some((l, i) => l.restarts > before[i].restarts), { timeoutMs: 30000 });
  assert.ok(probed, 'the impolite side must check for a cheaper route while the relay carries the pair');
  await sleep(6000);
  const after = await Promise.all(peers.map(link));
  report.checkAt = Date.now() - started;
  assert.ok(after.every(l => l.connected && l.path.kind === 'relay' && l.path.via === 'turn'), 'with nothing better the pair stays on the relay');
  report.gapDuringCheck = longestGap(report.relayAt, report.checkAt);
  assert.ok(report.gapDuringCheck.every(gap => gap < 1500), `no audio gap from the check: ${report.gapDuringCheck}`);

  // 3. A direct route opens: the pair moves to it and releases the relay.
  await Promise.all(peers.map(p => p.page.evaluate(() => { window.relayOnly = false; })));
  report.openedAt = Date.now() - started;
  const direct = await waitUntil(async () => (await Promise.all(peers.map(link))).every(l => l.connected && l.path.kind === 'direct'), { timeoutMs: 60000 });
  assert.ok(direct, 'once a direct route exists the pair must leave the relay by itself');
  report.directAt = Date.now() - started;
  await sleep(3000);
  const relayedAfterMove = relayed();
  const released = await waitUntil(() => turn.stats().allocations === 0, { timeoutMs: 150000, intervalMs: 500 });
  report.releasedAt = Date.now() - started;
  assert.ok(released, `the relay's allocations must end after the release (still ${turn.stats().allocations})`);
  // Audio alone is about 4 KB/s per direction: anything near that would mean media still rides the relay.
  report.relayedAfterMove = relayed() - relayedAfterMove;
  assert.ok(report.relayedAfterMove < 20000, `the relay must stop carrying media once the pair is direct (${report.relayedAfterMove} bytes relayed afterwards)`);
  report.gapDuringMove = longestGap(report.openedAt, Date.now() - started);
  assert.ok(report.gapDuringMove.every(gap => gap < 1500), `no audio gap from moving off the relay: ${report.gapDuringMove}`);
  const final = await Promise.all(peers.map(p => p.page.evaluate(() => window.peerlaneTest.stats())));
  report.peers = peers.map((p, i) => ({ kind: p.kind, version: p.version, id: p.id, links: summarize(final[i]), counters: final[i].counters, errors: p.errors.slice(0, 10) }));
  assert.ok(final.every(s => s.links[0].path.kind === 'direct'), 'the pair stays direct after the release');
  report.passed = true;
} catch (error) {
  report.error = error.message;
} finally {
  clearInterval(sampler);
  report.paths = await Promise.all(peers.map(async p => (await p.page.evaluate(() => window.peerlaneTest.events.filter(e => e.t === 'path')).catch(() => []))
    .map(e => `${e.ms}ms:${e.kind}${e.via ? `@${e.via}` : ''}`)));
  report.turn = turn?.stats();
  report.timeline = samples.filter((s, i) => i === 0 || s.path.join() !== samples[i - 1].path.join() || s.allocations !== samples[i - 1].allocations || s.restarts.join() !== samples[i - 1].restarts.join());
  for (const p of peers) await p.browser.close().catch(() => {});
  await services?.close();
  await turn?.close?.();
  report.evidence = await writeEvidence(`turn-upgrade-${engine}`, report);
  for (const p of report.peers ?? []) console.log(p.kind.padEnd(9), p.id?.slice(0, 6), p.links.map(l => `${l.peer.slice(0, 6)}:${l.path}@${l.via}/${l.local}->${l.remote} a=${l.audioPackets} restarts=${l.restarts}`).join(' | '));
  console.log('paths:', JSON.stringify(report.paths));
  console.log(`relay at ${report.relayAt}ms, direct allowed at ${report.openedAt}ms, direct at ${report.directAt}ms, relay released at ${report.releasedAt}ms; relayed after the move ${report.relayedAfterMove} bytes; longest audio gap during the check ${report.gapDuringCheck}ms, during the move ${report.gapDuringMove}ms`);
  console.log(report.passed ? 'turn-upgrade: PASS' : 'turn-upgrade: FAIL — ' + report.error, report.evidence);
  process.exitCode = report.passed ? 0 : 1;
}
