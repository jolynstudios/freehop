// SPDX-License-Identifier: Apache-2.0
// An application's own TURN relay in the lab (the opt-in `turn` rung): Freehop's TURN server on a
// public namespace, UDP and TCP on port 3478, one static credential. Prints one JSON line when ready;
// SIGTERM prints final stats and closes it.
import { randomBytes } from 'node:crypto';
import { createTurnServer } from '../src/relay/turn-server.mjs';

const [host] = process.argv.slice(2);
const username = `app-${randomBytes(4).toString('hex')}`, credential = randomBytes(12).toString('base64url');
const server = await createTurnServer({ listen: [{ transport: 'udp', host, port: 3478 }, { transport: 'tcp', host, port: 3478 }], realm: 'freehop-lab-app',
  authenticate: async name => (name === username ? credential : null), log: (event, details) => console.error(JSON.stringify({ event, ...details })) });
console.log(JSON.stringify({ type: 'ready', turn: [{ urls: [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`], username, credential }] }));
process.stdin.on('data', chunk => { if (String(chunk).includes('stats')) console.log(JSON.stringify({ type: 'stats', stats: { turn: server.stats() } })); });
let closing = false;
process.on('SIGTERM', async () => {
  if (closing) return; closing = true;
  const stats = server.stats();
  await server.close?.();
  console.log(JSON.stringify({ type: 'final', stats }));
  process.exit(0);
});
