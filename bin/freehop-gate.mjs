#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Freehop gate service. Configuration by environment:
//   FREEHOP_GATE_HOST=127.0.0.1   FREEHOP_GATE_PORT=8787   FREEHOP_GATE_PATH=/freehop
//   FREEHOP_GATE_PUBLIC_HOST=gate.example.com   (advertised in stun: URLs)
//   FREEHOP_GATE_STUN=0.0.0.0:3478[,[::]:3478]  (optional STUN Binding responders)
//   FREEHOP_GATE_TOKEN_SECRET=...               (32+ characters: only clients with valid tokens)
//   FREEHOP_GATE_TOKEN_AUDIENCE=wss://gate.example.com/freehop   (required with a token secret)
//   FREEHOP_GATE_TRUST_PROXY=1                  (behind a local reverse proxy: use X-Forwarded-For)
//   FREEHOP_GATE_ALLOW_ANONYMOUS=1              (or FREEHOP_GATE_ANONYMOUS=1: open gate beyond loopback)
// TLS is terminated by the reverse proxy (Caddy) in front of it.
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { createGate } from '../src/gate/gate.mjs';

const env = process.env;
const log = (event, details) => console.error(JSON.stringify({ at: new Date().toISOString(), event, ...details }));
const fail = message => { console.error(`freehop-gate: ${message}`); process.exit(1); };
const flag = name => { const v = env[name] ?? ''; if (!['', '0', '1'].includes(v)) fail(`${name} must be 0 or 1`); return v === '1'; };
const portNumber = (value, name) => { const n = Number(value); if (!/^\d+$/.test(String(value)) || !Number.isInteger(n) || n < 1 || n > 65535) fail(`${name} must be a port from 1 to 65535`); return n; };

const host = env.FREEHOP_GATE_HOST ?? '127.0.0.1';
if (!host) fail('FREEHOP_GATE_HOST is empty; set 0.0.0.0 or :: to listen on every interface');
const port = portNumber(env.FREEHOP_GATE_PORT ?? 8787, 'FREEHOP_GATE_PORT');
const tokenSecret = env.FREEHOP_GATE_TOKEN_SECRET || undefined;
if (tokenSecret && tokenSecret.length < 32) fail('FREEHOP_GATE_TOKEN_SECRET must be at least 32 characters, for example from: openssl rand -base64 32');
if (tokenSecret && !/^wss?:\/\//.test(env.FREEHOP_GATE_TOKEN_AUDIENCE ?? '')) fail('Set FREEHOP_GATE_TOKEN_AUDIENCE to the exact public WebSocket gate URL');
const trustProxy = flag('FREEHOP_GATE_TRUST_PROXY');
const anonymous = [flag('FREEHOP_GATE_ALLOW_ANONYMOUS'), flag('FREEHOP_GATE_ANONYMOUS')].includes(true);
// Reachable beyond loopback: the listen address is (or resolves to) anything but loopback, or a
// proxy or public host name is configured. Such a gate needs tokens or an explicit anonymous mode.
const loopback = address => /^(127\.|::1$|::ffff:127\.)/i.test(address);
const addresses = isIP(host) ? [host] : await lookup(host, { all: true }).then(list => list.map(a => a.address), () => fail(`FREEHOP_GATE_HOST ${host} does not resolve`));
if ((trustProxy || env.FREEHOP_GATE_PUBLIC_HOST || !addresses.every(loopback)) && !tokenSecret && !anonymous)
  fail('A gate reachable beyond loopback needs FREEHOP_GATE_TOKEN_SECRET, or FREEHOP_GATE_ALLOW_ANONYMOUS=1 for an open gate');
const stun = (env.FREEHOP_GATE_STUN ?? '').split(',').filter(Boolean).map(spec => {
  const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(spec.trim());
  if (!m) fail(`Bad FREEHOP_GATE_STUN entry: ${spec}`);
  return { host: m[1], port: portNumber(m[2], 'FREEHOP_GATE_STUN') };
});
if (!tokenSecret) log('warning', { message: 'anonymous gate: no FREEHOP_GATE_TOKEN_SECRET, so any client can use it' });
const gate = await createGate({
  host, port, path: env.FREEHOP_GATE_PATH ?? '/freehop',
  publicHost: env.FREEHOP_GATE_PUBLIC_HOST, stun, tokenSecret,
  tokenAudience: env.FREEHOP_GATE_TOKEN_AUDIENCE,
  trustProxy,
  log
});
console.log(JSON.stringify({ event: 'listening', url: gate.url(), stun: gate.stunUrls }));
const report = setInterval(() => console.log(JSON.stringify({ event: 'stats', ...gate.stats() })), 300000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { clearInterval(report); await gate.close(); process.exit(0); });
