// SPDX-License-Identifier: Apache-2.0
// Runs a peer gateway (TURN + router port mapping) inside a lab client namespace, the way the
// desktop app runs it next to its renderer. Prints one JSON line when ready; SIGTERM prints
// final stats and closes everything.
import { createInterface } from 'node:readline';
import { startGateway } from '../src/relay/agent.mjs';

const [host, roomTag] = process.argv.slice(2);
// The desktop app tells its gateway which rooms it is in (allowRoom); here: the lab room.
const gw = await startGateway({ host, port: 3478, rooms: roomTag ? [roomTag] : [], log: (event, details) => console.error(JSON.stringify({ event, ...details })) });
console.log(JSON.stringify({ type: 'ready', info: gw.info(), stats: gw.stats() }));
createInterface({input: process.stdin}).on('line', line => {
  if (line === 'stats') return console.log(JSON.stringify({type: 'stats', stats: gw.stats()}));
  try { const m = JSON.parse(line); if (m.type === 'credentials') console.log(JSON.stringify({type: 'credentials', requestId: m.requestId, credentials: m.tag === roomTag ? gw.credentialsFor(m.tag, m.peer) : null})); } catch {}
});
process.stdin.on('end', () => {});
let closing = false;
process.on('SIGTERM', async () => {
  if (closing) return; closing = true;
  const stats = gw.stats();
  await gw.close().catch(() => {});
  console.log(JSON.stringify({ type: 'final', stats }));
  process.exit(0);
});
