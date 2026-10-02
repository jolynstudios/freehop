#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Freehop gate service. Configuration by environment:
//   FREEHOP_GATE_HOST=127.0.0.1   FREEHOP_GATE_PORT=8787   FREEHOP_GATE_PATH=/freehop
//   FREEHOP_GATE_PUBLIC_HOST=gate.example.com   (advertised in stun: URLs)
//   FREEHOP_GATE_STUN=0.0.0.0:3478[,[::]:3478]  (optional STUN Binding responders)
//   FREEHOP_GATE_TOKEN_SECRET=...               (optional: only rooms with valid tokens)
//   FREEHOP_GATE_TRUST_PROXY=1                   (behind a local reverse proxy: use X-Forwarded-For)
// TLS is terminated by the reverse proxy (Caddy) in front of it.
import { createGate } from '../src/gate/gate.mjs';

const env = process.env;
const stun = (env.FREEHOP_GATE_STUN ?? '').split(',').filter(Boolean).map(spec => {
  const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(spec.trim());
  if (!m) throw new Error(`Bad FREEHOP_GATE_STUN entry: ${spec}`);
  return { host: m[1], port: Number(m[2]) };
});
const gate = await createGate({
  host: env.FREEHOP_GATE_HOST ?? '127.0.0.1', port: Number(env.FREEHOP_GATE_PORT ?? 8787), path: env.FREEHOP_GATE_PATH ?? '/freehop',
  publicHost: env.FREEHOP_GATE_PUBLIC_HOST, stun, tokenSecret: env.FREEHOP_GATE_TOKEN_SECRET || undefined,
  trustProxy: env.FREEHOP_GATE_TRUST_PROXY === '1',
  log: (event, details) => console.error(JSON.stringify({ at: new Date().toISOString(), event, ...details }))
});
console.log(JSON.stringify({ event: 'listening', url: gate.url(), stun: gate.stunUrls }));
const report = setInterval(() => console.log(JSON.stringify({ event: 'stats', ...gate.stats() })), 300000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { clearInterval(report); await gate.close(); process.exit(0); });
