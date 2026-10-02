// SPDX-License-Identifier: Apache-2.0
// The session's host node in the lab: runs a gateway (TURN + optional port mapping) and joins
// the room as a gateway member. Lab-only: the gate uses a throwaway self-signed certificate.
import { startGateway } from '../src/relay/agent.mjs';
import { joinAsGateway } from '../src/relay/member.mjs';

const [host, gateUrl, secret, app] = process.argv.slice(2);
const log = (event, details) => console.error(JSON.stringify({ event, ...details }));
const gw = await startGateway({ host, port: 3478, log });
const info = gw.info();
if (!info) { console.log(JSON.stringify({ type: 'ready', info: null })); process.exit(1); }
const member = await joinAsGateway({ gates: [gateUrl], secret, app, gateway: gw, log });
console.log(JSON.stringify({ type: 'ready', info: { urls: info.urls, external: info.external, internal: info.internal }, stats: gw.stats(), member: member.id }));
process.stdin.on('data', chunk => { if (String(chunk).includes('stats')) console.log(JSON.stringify({ type: 'stats', stats: gw.stats(), member: member.stats() })); });
let closing = false;
process.on('SIGTERM', async () => {
  if (closing) return; closing = true;
  const stats = gw.stats();
  await member.close().catch(() => {}); await gw.close().catch(() => {});
  console.log(JSON.stringify({ type: 'final', stats }));
  process.exit(0);
});
