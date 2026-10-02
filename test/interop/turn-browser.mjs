// SPDX-License-Identifier: Apache-2.0
// Real-browser TURN interop: relay-only RTCPeerConnections (Chromium, Firefox, WebKit; two separate browser
// instances per trial) through Freehop's TURN server over UDP and TCP, checked with getStats (selected local
// candidate type 'relay') and the server's own counters. Same machine, LAN IPv4: not a WAN/NAT qualification.
// Usage: node test/interop/turn-browser.mjs [--quick] [--only=chromium-firefox] [--transport=udp|tcp] [--ip=A.B.C.D]
// Modes: 'shared' = both browsers on one TURN server (relay↔relay delivered inside the server);
//        'split'  = one TURN server per browser (relay↔relay crosses real UDP sockets).
// WebKit 26.5 (Playwright 1.62) rejects every TURN URL with a query string (WebKit regression c31c11bbbd, fixed upstream
// by d1dca194fe, bugs.webkit.org/320931). The bug is detected at runtime: such a browser then gets the bare `turn:host:port`
// for UDP (RFC 7065 default transport, equivalent to ?transport=udp), and TCP trials are reported BLOCKED with the thrown
// error. Exit code 1 on any FAIL; BLOCKED trials are listed but do not fail the run.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { createTurnServer } from '../../src/relay/turn-server.mjs';

if (process.env.NODE_TEST_CONTEXT) { // swept up by a bare `node --test` (matches **/test/**/*.mjs): never launch browsers there
  console.log('skipped: standalone interop run, use `node test/interop/turn-browser.mjs`');
  process.exit(0);
}
const args = process.argv.slice(2);
const option = name => { const a = args.find(x => x === `--${name}` || x.startsWith(`--${name}=`)); return a === undefined ? undefined : (a.split('=')[1] ?? true); };
const require = createRequire(import.meta.url);
const playwrightPath = process.env.FREEHOP_PLAYWRIGHT ?? require.resolve('playwright');
const playwright = require(playwrightPath), playwrightVersion = require(path.join(path.dirname(playwrightPath), 'package.json')).version;
const MEDIA_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function pickIp() {
  const explicit = option('ip') ?? process.env.FREEHOP_INTEROP_IP;
  if (typeof explicit === 'string') return explicit;
  const v4 = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list ?? []).map(i => ({ name, ...i })))
    .filter(i => i.family === 'IPv4' && !i.internal);
  return (v4.find(i => i.name === 'en0') ?? v4[0])?.address;
}
const ip = pickIp();
if (!ip) { console.error('No non-loopback IPv4 address found (browsers ignore loopback ICE); pass --ip='); process.exit(2); }

const page = await readFile(new URL('./turn-browser.html', import.meta.url));
const web = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page); });
await new Promise(r => web.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${web.address().port}`;

async function startTurn(credentials, tag) {
  const events = [];
  const server = await createTurnServer({
    listen: [{ transport: 'udp', host: ip, port: 0 }, { transport: 'tcp', host: ip, port: 0 }],
    realm: 'peerlane-interop', authenticate: async u => (u === credentials.username ? credentials.password : null),
    allowPeer: () => true, // every candidate lives on this machine's private address
    log: (event, details) => { if (event !== 'listening') events.push({ event, ...details }); },
  });
  return { tag, server, events };
}
const serverEvidence = turns => turns.map(({ tag, server, events }) => ({ tag, stats: server.stats(),
  allocations: events.filter(e => e.event === 'allocation').map(e => ({ transport: e.transport, lifetime: e.lifetime })),
  notable: events.filter(e => !['allocation', 'allocation-deleted', 'permission', 'channel-bind', 'closed'].includes(e.event)).slice(0, 20) }));

async function poll(fn, until, timeout, interval = 500) {
  const end = Date.now() + timeout;
  for (;;) { const v = await fn(); if (until(v)) return v; if (Date.now() > end) throw new Error(`poll timed out; last: ${JSON.stringify(v).slice(0, 300)}`); await sleep(interval); }
}

const WEBKIT_QUERY_BUG = 'WebKit regression c31c11bbbd rejects every TURN URL query string (fixed upstream by d1dca194fe, https://bugs.webkit.org/show_bug.cgi?id=320931); '
  + 'turn:host:port?transport=tcp cannot be configured in this browser build';

async function runTrial({ pair, transport, mode, media = false }) {
  const trial = { pair: pair.join('-'), transport, mode, media, status: 'fail', phase: 'setup', problems: [] };
  const started = performance.now(), credentials = { username: `u-${randomBytes(4).toString('hex')}`, password: randomBytes(12).toString('base64url') };
  const turns = [], browsers = [], pages = [];
  let queryBug = [null, null];
  try {
    turns.push(await startTurn(credentials, 'A'));
    if (mode === 'split') turns.push(await startTurn(credentials, 'B'));
    const config = i => {
      const l = turns[Math.min(i, turns.length - 1)].server.addresses().find(a => a.transport === transport);
      const url = queryBug[i] && transport === 'udp' ? `turn:${l.address}:${l.port}` : `turn:${l.address}:${l.port}?transport=${transport}`;
      return { iceServers: [{ urls: url, username: credentials.username, credential: credentials.password }], iceTransportPolicy: 'relay' };
    };
    trial.phase = 'launch';
    for (const name of pair) {
      const browser = await playwright[name].launch({ headless: true, args: media ? MEDIA_ARGS : [] });
      browsers.push(browser);
      const context = await browser.newContext();
      if (media) await context.grantPermissions(['camera', 'microphone'], { origin });
      const p = await context.newPage();
      p.on('pageerror', e => trial.problems.push(`${name} pageerror: ${e.message}`));
      pages.push(p);
    }
    trial.versions = browsers.map((b, i) => `${pair[i]} ${b.version()}`);
    const chains = [Promise.resolve(), Promise.resolve()]; // ordered signalling per direction
    for (const [i, p] of pages.entries()) {
      await p.exposeFunction('peerlaneSignal', msg => {
        chains[i] = chains[i].then(() => pages[1 - i].evaluate(m => window.peerlane.signal(m), msg)).catch(e => trial.problems.push(`signal: ${e.message.split('\n')[0]}`));
      });
      await p.goto(origin);
    }
    trial.phase = 'probe';
    queryBug = await Promise.all(pages.map(p => p.evaluate(() => {
      try { new RTCPeerConnection({ iceServers: [{ urls: 'turn:192.0.2.1:3478?transport=udp', username: 'u', credential: 'c' }] }).close(); return null; }
      catch (e) { return `${e.name}: ${e.message}`; }
    })));
    trial.urls = [0, 1].map(i => config(i).iceServers[0].urls);
    if (queryBug.some(Boolean)) trial.urlQueryRejected = queryBug;
    trial.phase = 'connect';
    const connectStarted = performance.now(); // ICE gathering + TURN allocation + checks + DTLS/SCTP, excluding browser launch
    try {
      await pages[1].evaluate(o => window.peerlane.start(o), { config: config(1), initiator: false, media });
      await pages[0].evaluate(o => window.peerlane.start(o), { config: config(0), initiator: true, media });
    } catch (e) {
      const thrown = e.message.split('\n')[0];
      if (transport === 'tcp' && queryBug.some(Boolean) && thrown.includes('Invalid TURN URL query string')) {
        trial.status = 'blocked'; trial.blocked = { browsers: pair.filter((_, i) => queryBug[i]), thrown, reason: WEBKIT_QUERY_BUG };
        return trial;
      }
      throw e;
    }
    await Promise.all(pages.map(p => p.waitForFunction(() => window.peerlane.dc?.readyState === 'open', null, { timeout: 30000 })));
    trial.connectMs = Math.round(performance.now() - connectStarted);
    trial.phase = 'messages';
    await pages[0].evaluate(() => { for (let i = 0; i < 5; i++) window.peerlane.dc.send(`ping-${i}`); });
    await pages[1].evaluate(() => { for (let i = 0; i < 3; i++) window.peerlane.dc.send(`hello-${i}`); });
    await pages[0].waitForFunction(() => window.peerlane.received.length >= 8, null, { timeout: 10000 });
    await pages[1].waitForFunction(() => window.peerlane.received.length >= 5, null, { timeout: 10000 });
    if (media) {
      trial.phase = 'media';
      const report = i => pages[i].evaluate(() => window.peerlane.report());
      const enough = r => (r.media.video?.framesDecoded ?? 0) > 30 && (r.media.audio?.totalSamplesReceived ?? 0) > 0;
      const first = await Promise.all([0, 1].map(i => poll(() => report(i), enough, 30000)));
      await sleep(2000);
      const second = await Promise.all([0, 1].map(report));
      trial.mediaStats = pair.map((name, i) => ({ side: name, first: first[i].media, second: second[i].media }));
      for (const [i, m] of trial.mediaStats.entries()) {
        if (!(m.second.video?.framesDecoded > 30)) trial.problems.push(`side ${i}: video framesDecoded ${m.second.video?.framesDecoded}`);
        if (!(m.second.audio?.totalSamplesReceived > m.first.audio?.totalSamplesReceived)) trial.problems.push(`side ${i}: audio totalSamplesReceived not increasing`);
      }
    }
    trial.phase = 'verify';
    trial.reports = await Promise.all(pages.map(p => p.evaluate(() => window.peerlane.report())));
    const [a, b] = trial.reports.map(r => r.received);
    for (let i = 0; i < 5; i++) if (!a.includes(`pong-${i}`) || !b.includes(`ping-${i}`)) trial.problems.push(`ping/pong ${i} missing`);
    for (let i = 0; i < 3; i++) if (!a.includes(`hello-${i}`)) trial.problems.push(`hello-${i} missing`);
    for (const [i, r] of trial.reports.entries()) {
      const local = r.selected?.local;
      if (local?.type !== 'relay') trial.problems.push(`${pair[i]}: selected local candidate type ${local?.type ?? 'none'}`);
      if (local?.relayProtocol && local.relayProtocol !== transport) trial.problems.push(`${pair[i]}: relayProtocol ${local.relayProtocol}`);
      if (r.localCandidates.some(c => c.type !== 'relay')) trial.problems.push(`${pair[i]}: gathered a non-relay candidate`);
      if (r.errors.length) trial.problems.push(`${pair[i]}: ${r.errors[0]}`);
    }
    trial.server = serverEvidence(turns);
    const allocations = trial.server.flatMap(s => s.allocations), stats = trial.server.map(s => s.stats);
    if (allocations.length < 2 || allocations.some(x => x.transport !== transport)) trial.problems.push(`server allocations: ${JSON.stringify(allocations)}`);
    if (stats.some(s => !(s.bytesToPeers > 0 && s.bytesFromPeers > 0))) trial.problems.push('server relayed no bytes');
    if (stats.some(s => s.authFailures || s.errors)) trial.problems.push(`server authFailures/errors: ${stats.map(s => `${s.authFailures}/${s.errors}`)}`);
    const internal = stats.reduce((n, s) => n + s.relayedInternally, 0);
    if (mode === 'shared' ? internal === 0 : internal !== 0) trial.problems.push(`relayedInternally ${internal} in ${mode} mode`);
    trial.status = trial.problems.length ? 'fail' : 'pass';
    trial.phase = 'done';
  } catch (e) {
    trial.problems.push(`${trial.phase}: ${e.message.split('\n')[0]}`);
    trial.reports ??= await Promise.all(pages.map(p => p.evaluate(() => window.peerlane.report()).catch(err => ({ error: err.message.split('\n')[0] }))));
    trial.server ??= serverEvidence(turns);
  } finally {
    trial.server ??= serverEvidence(turns);
    for (const p of pages) await p.evaluate(() => window.peerlane.close()).catch(() => {});
    for (const b of browsers) await b.close().catch(() => {});
    for (const t of turns) await t.server.close();
    trial.elapsedMs = Math.round(performance.now() - started);
  }
  return trial;
}

const pairs = [['chromium', 'chromium'], ['firefox', 'firefox'], ['webkit', 'webkit'], ['chromium', 'firefox'], ['chromium', 'webkit'], ['firefox', 'webkit']]
  .filter(p => !option('only') || option('only').split(',').includes(p.join('-')));
const transports = ['udp', 'tcp'].filter(t => !option('transport') || option('transport') === t);
const modes = option('quick') ? ['shared'] : ['shared', 'split'];
const plan = [];
for (const mode of modes) for (const transport of transports) for (const pair of pairs) plan.push({ pair, transport, mode });
if (!option('only') || option('only').split(',').includes('chromium-chromium'))
  for (const transport of transports) plan.push({ pair: ['chromium', 'chromium'], transport, mode: 'shared', media: true });

const startedAt = new Date().toISOString(), trials = [];
console.log(`peerlane TURN interop: ${plan.length} trials, TURN on ${ip}, Playwright ${playwrightVersion}`);
try {
  for (const item of plan) {
    const trial = await runTrial(item);
    trials.push(trial);
    const sel = trial.reports?.map(r => r?.selected ? `${r.selected.local?.type}/${r.selected.remote?.type}:${r.selected.local?.relayProtocol ?? '?'}` : '-').join(' ') ?? '-';
    console.log(`${trial.status.toUpperCase().padEnd(7)} ${(trial.pair + (trial.media ? '+media' : '')).padEnd(24)} ${trial.transport.padEnd(4)} ${trial.mode.padEnd(7)}`
      + ` connect ${String(trial.connectMs ?? '-').padStart(5)} ms  local/remote:proto ${sel}${trial.status === 'pass' ? '' : `  <- ${trial.blocked ? `${trial.blocked.browsers} threw "${trial.blocked.thrown}"` : trial.problems.join('; ')}`}`);
  }
} finally { await new Promise(r => web.close(r)); }

const count = status => trials.filter(t => t.status === status).length, passed = count('pass'), blocked = count('blocked'), failed = count('fail');
console.log(`\n${'pair'.padEnd(18)} ${['udp', 'tcp'].flatMap(t => modes.map(m => `${t}/${m}`)).map(h => h.padEnd(12)).join('')}`);
for (const pair of pairs.map(p => p.join('-'))) {
  const cell = (t, m) => { const x = trials.find(r => r.pair === pair && r.transport === t && r.mode === m && !r.media); return x ? x.status.toUpperCase() : '-'; };
  console.log(`${pair.padEnd(18)} ${['udp', 'tcp'].flatMap(t => modes.map(m => cell(t, m).padEnd(12))).join('')}`);
}
for (const m of trials.filter(t => t.media)) console.log(`chromium media ${m.transport}: ${m.status.toUpperCase()} ${JSON.stringify(m.mediaStats?.map(s => ({ framesDecoded: s.second.video?.framesDecoded, samples: [s.first.audio?.totalSamplesReceived, s.second.audio?.totalSamplesReceived] })))}`);
console.log(`\n${passed} pass, ${failed} fail, ${blocked} blocked (browser bug, see header) of ${trials.length} trials`);

// Evidence: the LAN address is redacted, credentials are random per trial and never written.
const evidence = { schema: 1, tool: 'test/interop/turn-browser.mjs', startedAt, finishedAt: new Date().toISOString(), node: process.version,
  platform: `${os.platform()} ${os.release()} ${os.arch()}`, playwright: playwrightVersion, turnAddress: 'LAN IPv4 (redacted)',
  scope: 'same machine, LAN IPv4, relay-only ICE through peerlane TURN; not a WAN/NAT qualification', passed, failed, blocked, total: trials.length, browserLimitations: blocked ? [WEBKIT_QUERY_BUG] : [], trials };
const dir = new URL('./evidence/', import.meta.url);
await mkdir(dir, { recursive: true });
const file = new URL(`turn-browser-${startedAt.replace(/[:.]/g, '-')}.json`, dir);
await writeFile(file, JSON.stringify(evidence, null, 2).split(ip).join('<lan-ip>') + '\n');
console.log(`Evidence: ${file.pathname}`);
if (failed) process.exitCode = 1;
