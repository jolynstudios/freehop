// SPDX-License-Identifier: Apache-2.0
// Shared browser-test plumbing: a static server for the client + test page, a gate, and
// Playwright launch helpers usable on the host and inside network namespaces.
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createGate } from '../../src/gate/gate.mjs';

const root = new URL('../../', import.meta.url);
export const playwright = createRequire(import.meta.url)('playwright');

const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html; charset=utf-8' };

// A throwaway self-signed certificate for lab origins that are not localhost: browsers need a
// secure context for getUserMedia, and Playwright contexts ignore the certificate error.
export function selfSignedCert(dir, address) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
    '-subj', '/CN=peerlane-lab', '-addext', `subjectAltName=IP:${address}`, '-keyout', `${dir}/lab-key.pem`, '-out', `${dir}/lab-cert.pem`], { stdio: 'ignore' });
  return { key: execFileSync('cat', [`${dir}/lab-key.pem`]), cert: execFileSync('cat', [`${dir}/lab-cert.pem`]) };
}

export async function startServices({ host = '127.0.0.1', port = 0, gateHost, gatePort = 0, gate = {}, publicHost, tls } = {}) {
  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://lab');
    let file = null;
    if (url.pathname === '/' || url.pathname === '/page.html') file = new URL('test/browser/page.html', root);
    else if (/^\/client\/[a-z-]+\.mjs$/.test(url.pathname)) file = new URL('src' + url.pathname, root);
    if (!file) { res.writeHead(404); res.end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[file.pathname.slice(file.pathname.lastIndexOf('.'))], 'cache-control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  };
  const server = tls ? https.createServer({ key: tls.key, cert: tls.cert }, handler) : http.createServer(handler);
  await new Promise(resolve => server.listen(port, host, resolve));
  // With TLS the gate shares the page's HTTPS server (wss on the same origin).
  const g = tls ? await createGate({ server, ...gate }) : await createGate({ host: gateHost ?? host, port: gatePort, ...gate });
  const a = server.address();
  return {
    origin: `${tls ? 'https' : 'http'}://${publicHost ?? host}:${a.port}`,
    gateUrl: tls ? `wss://${publicHost ?? host}:${a.port}${g.path}` : g.url(publicHost ?? gateHost ?? host),
    gate: g,
    async close() { await g.close(); await new Promise(resolve => server.close(resolve)); server.closeAllConnections?.(); }
  };
}

export const CHROMIUM_MEDIA_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required', '--disable-background-networking', '--no-proxy-server'];

export const FIREFOX_MEDIA_PREFS = { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true,
  'media.autoplay.default': 0, 'media.peerconnection.ice.loopback': false };

export async function launchPeer(kind, { origin, executablePath, extraArgs = [], headless = true, firefoxUserPrefs = {} } = {}) {
  const type = playwright[kind];
  const insecure = origin && /^http:/.test(origin) && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(origin);
  const args = kind === 'chromium' ? [...CHROMIUM_MEDIA_ARGS, ...(insecure ? ['--unsafely-treat-insecure-origin-as-secure=' + origin] : []), ...extraArgs] : extraArgs;
  const browser = await type.launch({ headless, executablePath, args,
    firefoxUserPrefs: kind === 'firefox' ? { ...FIREFOX_MEDIA_PREFS, ...firefoxUserPrefs, ...(insecure ? { 'media.devices.insecure.enabled': true, 'media.getusermedia.insecure.enabled': true } : {}) } : undefined });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, ...(kind === 'firefox' ? {} : { permissions: ['camera', 'microphone'] }) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return { kind, browser, context, page, errors, version: browser.version() };
}

export async function openAndJoin(peer, origin, options) {
  for (let attempt = 1; ; attempt++) {
    try { await peer.page.goto(origin + '/page.html'); break; }
    catch (error) {
      if (attempt >= 4 || !/ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET/.test(error.message)) throw error;
      await sleep(500 * attempt);
    }
  }
  await peer.page.waitForFunction(() => window.peerlaneTest);
  peer.id = await peer.page.evaluate(o => window.peerlaneTest.join(o), options);
  return peer.id;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function waitUntil(fn, { timeoutMs = 30000, intervalMs = 250 } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(intervalMs); }
  return last;
}

export async function writeEvidence(name, data) {
  const dir = new URL('test/evidence/', root);
  await mkdir(dir, { recursive: true });
  const file = new URL(`${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, dir);
  await writeFile(file, JSON.stringify(data, null, 2) + '\n');
  return file.pathname;
}

// Summarise one peer's stats into the facts every gate asserts on.
export function summarize(stats) {
  return stats.links.map(l => ({ peer: l.peer, connected: l.connected, phase: l.phase, path: l.path.kind, via: l.path.via ?? null,
    local: l.path.local ?? null, remote: l.path.remote ?? null, protocol: l.path.protocol ?? null, relayProtocol: l.path.relayProtocol ?? null,
    connectMs: l.connectMs, restarts: l.restarts, forwardedOrigins: l.forwardedOrigins, forwarding: l.forwarding,
    audioIn: l.media.inbound.audio?.samples ?? 0, audioPackets: l.media.inbound.audio?.packets ?? 0,
    videoFrames: l.media.inbound.video?.frames ?? 0, videoSize: l.media.inbound.video?.width ? `${l.media.inbound.video.width}x${l.media.inbound.video.height}` : null,
    inStreams: (l.media.inbound.audio?.streams ?? 0) + (l.media.inbound.video?.streams ?? 0) }));
}
