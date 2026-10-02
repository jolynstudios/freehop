// SPDX-License-Identifier: Apache-2.0
// NAT-lab scenario runner. Executed by run-scenario.sh inside topology.sh in the disposable
// lab container: real browsers run in separate router/client namespaces, the gate runs on the
// simulated internet, and desktop "gateway" peers run their TURN + port mapping next to their
// browser. Every scenario asserts the PATH each pair used and that audio + video actually flow.
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { startServices, launchPeer, openAndJoin, summarize, writeEvidence, sleep, playwright, selfSignedCert } from '../test/browser/lab.mjs';
import { deriveRoom } from '../src/client/crypto.mjs';

// expect: pair -> accepted path kinds (as reported by BOTH endpoints), or 'none' for no media.
export const SCENARIOS = {
  'direct-eim': { peers: 'a=eim b=eim', expect: { 'a-b': ['direct'] } },
  'hard-pair': { peers: 'a=random b=random', expect: { 'a-b': 'none' }, observeMs: 25000 },
  'hard-pair-bridge': { peers: 'a=random b=random c=public', expect: { 'a-c': ['direct'], 'b-c': ['direct'], 'a-b': ['bridged'] } },
  'hard-pair-gateway': { peers: 'a=random b=random g=upnp', gateways: ['g'], expect: { 'a-g': ['gateway', 'direct'], 'b-g': ['gateway', 'direct'], 'a-b': ['relay'] } },
  'two-peer-desktop-host': { peers: 'a=random g=upnp', gateways: ['g'], expect: { 'a-g': ['gateway', 'direct'] } },
  'udpblock-gateway': { peers: 'a=udpblock g=upnp', gateways: ['g'], expect: { 'a-g': ['gateway'] } },
  'udpblock-pair-gateway': { peers: 'a=udpblock b=udpblock g=upnp', gateways: ['g'], expect: { 'a-g': ['gateway'], 'b-g': ['gateway'], 'a-b': ['relay'] } },
  'hard-pair-host-node': { peers: 'a=random b=random h=public', members: ['h'], expect: { 'a-b': ['relay'] } },
  'udpblock-pair-host-node': { peers: 'a=udpblock b=udpblock h=public', members: ['h'], expect: { 'a-b': ['relay'] } },
  'ipv6-direct': { peers: 'a=v6 b=v6', expect: { 'a-b': ['direct'] }, requireIpv6: true },
  'gate-only': { peers: 'a=gateonly b=eim c=public', expect: { 'a-b': 'none', 'a-c': 'none', 'b-c': ['direct'] }, observeMs: 25000 }
};

if (process.argv[2] === '--topology') { console.log(SCENARIOS[process.argv[3]]?.peers ?? ''); process.exit(SCENARIOS[process.argv[3]] ? 0 : 2); }
const scenarioName = process.argv[2];
const scenario = SCENARIOS[scenarioName];
assert(scenario, 'unknown scenario');
// FREEHOP_BROWSER=firefox for every peer, or FREEHOP_BROWSERS=a:firefox,b:webkit per peer.
const kindFor = name => (process.env.FREEHOP_BROWSERS ?? '').split(',').map(x => x.split(':')).find(([n]) => n === name)?.[1] ?? process.env.FREEHOP_BROWSER ?? 'chromium';
const kind = process.env.FREEHOP_BROWSERS ? 'mixed' : process.env.FREEHOP_BROWSER ?? 'chromium';
assert(process.platform === 'linux' && process.getuid() === 0 && process.env.FREEHOP_DISPOSABLE_LAB === 'yes' && process.env.FREEHOP_LAB_DIR);
const labDir = process.env.FREEHOP_LAB_DIR;
const peerLines = (await readFile(labDir + '/peers', 'utf8')).trim().split('\n').map(l => l.split(' '));
const peers = peerLines.map(([name, profile, wan, lan]) => ({ name, profile, wan, lan: profile === 'public' ? wan : lan }));

const report = { schema: 1, scenario: scenarioName, topology: scenario.peers, browser: kind, scope: 'isolated Linux network namespaces with kernel NAT/firewall and miniupnpd; NOT physical ISP/CGNAT qualification',
  startedAt: new Date().toISOString(), sourceSha256: {}, peers: {}, pairs: {}, passed: false };
for (const dir of ['src/client', 'src/gate', 'src/relay', 'src/shared', 'lab']) {
  for (const f of (await readdir(new URL(`../${dir}/`, import.meta.url))).filter(f => /\.(mjs|sh)$/.test(f)).sort())
    report.sourceSha256[`${dir}/${f}`] = createHash('sha256').update(await readFile(new URL(`../${dir}/${f}`, import.meta.url))).digest('hex');
}

const gatewayProcs = new Map();
let services; const launched = [];
try {
  services = await startServices({ host: '198.20.113.1', port: 8443, tls: selfSignedCert(labDir, '198.20.113.1'), gate: { stun: [{ host: '198.20.113.1', port: 3478 }, { host: '2001:db8:113::1', port: 3478 }] } });
  report.stunUrls = services.gate.stunUrls;
  const secret = randomBytes(32).toString('base64url');
  // Desktop peers run the gateway next to their browser; host nodes (members) run a gateway
  // and join the room as a gateway member without any browser.
  const { tag: roomTag } = await deriveRoom(secret, 'lab');
  const nodeProcs = [...(scenario.gateways ?? []).map(name => [name, 'gateway-proc.mjs', [roomTag]]),
    ...(scenario.members ?? []).map(name => [name, 'member-proc.mjs', [services.gateUrl, secret, 'lab']])];
  for (const [name, script, extra] of nodeProcs) {
    const peer = peers.find(p => p.name === name);
    const child = spawn('ip', ['netns', 'exec', 'pl-' + name, process.execPath, new URL(script, import.meta.url).pathname, peer.lan, ...extra],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
    const lines = createInterface({ input: child.stdout });
    const logs = []; createInterface({ input: child.stderr }).on('line', l => { if (logs.length < 200) logs.push(l); });
    const messages = [];
    lines.on('line', l => { try { messages.push(JSON.parse(l)); } catch {} });
    const ready = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('gateway did not start: ' + logs.join(' | '))), 20000);
      lines.on('line', l => { try { const m = JSON.parse(l); if (m.type === 'ready') { clearTimeout(t); resolve(m); } } catch {} });
      child.on('exit', code => { clearTimeout(t); reject(new Error('gateway exited ' + code + ': ' + logs.join(' | '))); });
    });
    gatewayProcs.set(name, { child, messages, logs, info: ready.info, startStats: ready.stats, member: ready.member ?? null });
    report.peers[name] = { gateway: { info: ready.info ? { urls: ready.info.urls, external: ready.info.external, internal: ready.info.internal } : null, mappings: ready.stats?.mappings ?? [] } };
    assert(ready.info, `gateway ${name} must obtain a public mapping`);
  }
  for (const peer of peers.filter(p => !(scenario.members ?? []).includes(p.name))) {
    const peerKind = kindFor(peer.name), exe = playwright[peerKind].executablePath();
    const wrapper = `${labDir}/browser-${peer.name}.sh`;
    await writeFile(wrapper, `#!/bin/sh\nexec ip netns exec pl-${peer.name} '${exe.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
    const p = await launchPeer(peerKind, { origin: services.origin, executablePath: wrapper });
    p.name = peer.name; launched.push(p);
  }
  report.versions = [...new Set(launched.map(p => `${p.kind} ${p.version}`))];
  report.phase = 'join';
  const t0 = Date.now();
  for (const p of launched) {
    await openAndJoin(p, services.origin, { gates: [services.gateUrl], secret, app: 'lab', media: { audio: true, video: true },
      gateway: (scenario.gateways ?? []).includes(p.name) ? gatewayProcs.get(p.name).info : undefined });
  }
  const idName = Object.fromEntries([...launched.map(p => [p.id, p.name]), ...[...gatewayProcs].filter(([, g]) => g.member).map(([n, g]) => [g.member, n])]);
  const pairs = Object.keys(scenario.expect);
  const sample = async () => Promise.all(launched.map(async p => ({ p, stats: await p.page.evaluate(() => window.peerlaneTest.stats()), media: await p.page.evaluate(() => window.peerlaneTest.mediaByOrigin()) })));
  const evaluate = all => {
    const result = {};
    for (const pair of pairs) {
      const [x, y] = pair.split('-');
      const side = (from, to) => {
        const s = all.find(e => e.p.name === from), toId = launched.find(p => p.name === to).id;
        const link = s.stats.links.find(l => l.peer === toId);
        const media = s.media[toId] ?? { audioPackets: 0, videoFrames: 0, via: [] };
        return { path: link?.path.kind ?? 'none', via: link?.path.via ? idName[link.path.via] ?? link.path.via : null, local: link?.path.local ?? null,
          remote: link?.path.remote ?? null, relayProtocol: link?.path.relayProtocol ?? null, connected: !!link?.connected,
          audioPackets: media.audioPackets, audioSamples: media.audioSamples ?? 0, videoFrames: media.videoFrames,
          mediaVia: (media.via ?? []).map(v => v === 'direct' ? 'direct' : idName[v] ?? v), connectMs: link?.connectMs ?? null };
      };
      result[pair] = { [x]: side(x, y), [y]: side(y, x) };
    }
    return result;
  };
  const flowing = r => r.audioPackets > 50 && r.videoFrames > 30;
  const satisfied = result => pairs.every(pair => {
    const want = scenario.expect[pair], sides = Object.values(result[pair]);
    if (want === 'none') return false;
    return sides.every(s => flowing(s) && want.includes(s.path));
  });
  let result;
  if (Object.values(scenario.expect).includes('none')) {
    await sleep(scenario.observeMs);
    result = evaluate(await sample());
  } else {
    const end = Date.now() + 75000;
    while (Date.now() < end) { result = evaluate(await sample()); if (satisfied(result)) break; await sleep(1000); }
  }
  report.elapsedMs = Date.now() - t0;
  report.pairs = result;
  const final = await sample();
  for (const { p, stats } of final) {
    report.peers[p.name] = { ...report.peers[p.name], id: p.id, profile: peers.find(x => x.name === p.name).profile, counters: stats.counters,
      links: summarize(stats).map(l => ({ ...l, peer: idName[l.peer] ?? l.peer, via: idName[l.via] ?? l.via })),
      bridges: stats.bridges.map(b => ({ ...b, peer: idName[b.peer], via: idName[b.via] ?? null })),
      relaying: stats.relaying.map(b => ({ a: idName[b.a], b: idName[b.b] })), errors: p.errors.slice(0, 10) };
  }
  report.events = Object.fromEntries(await Promise.all(launched.map(async p => [p.name, (await p.page.evaluate(() => window.peerlaneTest.events)).filter(e => e.t !== 'track').slice(0, 80)
    .map(e => ({ ...e, peer: idName[e.peer] ?? e.peer, via: idName[e.via] ?? e.via, id: idName[e.id] ?? e.id }))])));
  report.negotiation = Object.fromEntries(await Promise.all(launched.map(async p => [p.name, Object.fromEntries(Object.entries(await p.page.evaluate(() => window.peerlaneTest.debug())).map(([id, d]) => [idName[id] ?? id, d]))])));
  report.gate = services.gate.stats();
  for (const [name, g] of gatewayProcs) { g.child.stdin.write('stats\n'); }
  await sleep(300);
  for (const [name, g] of gatewayProcs) report.peers[name].gateway.turn = g.messages.filter(m => m.type === 'stats').at(-1)?.stats?.turn ?? null;
  report.natCounters = {};
  for (const peer of peers.filter(p => p.profile !== 'public')) {
    if ((scenario.members ?? []).includes(peer.name)) continue;
    report.natCounters[peer.name] = execFileSync('ip', ['netns', 'exec', 'pl-r' + peer.name, 'iptables', '-L', 'FORWARD', '-v', '-n', '-x'], { encoding: 'utf8' })
      .split('\n').filter(l => /DROP|ACCEPT/.test(l)).map(l => l.trim().replace(/\s+/g, ' ')).slice(0, 6);
  }
  // Assertions.
  for (const pair of pairs) {
    const want = scenario.expect[pair];
    for (const [name, side] of Object.entries(result[pair])) {
      if (want === 'none') assert.ok(!flowing(side) && !side.connected, `${pair}: ${name} must not receive media (boundary case)`);
      else {
        assert.ok(want.includes(side.path), `${pair}: ${name} path ${side.path} not in ${want}`);
        assert.ok(flowing(side), `${pair}: ${name} audio/video must flow (a=${side.audioPackets} v=${side.videoFrames})`);
      }
    }
  }
  if (scenario.requireIpv6) for (const pair of pairs) for (const [n, side] of Object.entries(result[pair]))
    assert.ok(Object.values(report.peers).length && /:/.test(String(final.find(e => e.p.name === n).stats.links[0]?.path.remoteAddress ?? '')), `${pair}: ${n} must use an IPv6 route`);
  // The gate is signalling-only: its total traffic stays tiny and no gate ever relays media.
  report.gateTotals = { bytesIn: report.gate.bytesIn, bytesOut: report.gate.bytesOut, envelopes: report.gate.envelopes,
    stunBytes: report.gate.stun.reduce((n, s) => n + s.bytesIn + s.bytesOut, 0) };
  assert.ok(report.gate.bytesIn + report.gate.bytesOut < 1_500_000, 'gate traffic must stay signalling-sized');
  report.passed = true;
} catch (error) {
  report.error = error.message; report.errorPhase = report.phase;
} finally {
  for (const p of launched) await p.page.evaluate(() => window.peerlaneTest?.leave()).catch(() => {});
  await sleep(300);
  for (const p of launched) await p.browser.close().catch(() => {});
  for (const [, g] of gatewayProcs) { g.child.kill('SIGTERM'); await new Promise(r => { g.child.once('exit', r); setTimeout(r, 3000); }); }
  if (services) { report.gateAfter = { rooms: services.gate.rooms() }; await services.close(); }
  report.finishedAt = new Date().toISOString();
  const file = await writeEvidence(`nat-${scenarioName}-${kind}`, report);
  for (const [pair, sides] of Object.entries(report.pairs ?? {})) console.log(pair.padEnd(5), Object.entries(sides).map(([n, s]) => `${n}: ${s.path}${s.via ? '@' + s.via : ''} ${s.local ?? ''}>${s.remote ?? ''}${s.relayProtocol ? '/' + s.relayProtocol : ''} a=${s.audioPackets} v=${s.videoFrames}${s.mediaVia?.length ? ' via ' + s.mediaVia.join('+') : ''}`).join(' | '));
  if (report.gateTotals) console.log('gate bytes', report.gateTotals);
  console.log(`${scenarioName}: ${report.passed ? 'PASS' : 'FAIL: ' + report.error} ${file}`);
  process.exitCode = report.passed ? 0 : 1;
}
