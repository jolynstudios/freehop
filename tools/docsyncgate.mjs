// SPDX-License-Identifier: Apache-2.0
// docsyncgate — the docs may only reference APIs that exist.
// Extracts every session-table row (`name(...)`) and every `session.x` / `room.x`
// mention from SDK.md and website/docs/sdk/client.mdx, then checks each name against
// the real surface: Room prototype methods, Room instance fields, the members connect()
// layers on top (Object.assign in src/sdk/client.mjs), top-level module exports, and
// the EventEmitter base. Catches a renamed or removed method leaving stale docs behind.
// Usage: node tools/docsyncgate.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(resolve(root, p), 'utf8');

const room = read('src/client/room.mjs');
const sdk = read('src/sdk/client.mjs');

const emitter = new Set(['on', 'off', 'once', 'emit', 'addListener', 'removeListener',
  'removeAllListeners', 'listeners', 'listenerCount', 'eventNames', 'setMaxListeners', 'getMaxListeners']);

const surface = new Set([
  ...emitter,
  // Room prototype methods (two-space indent; #private members are not public API).
  ...[...room.matchAll(/^  (?:async )?(?:get |set )?([A-Za-z]\w*)\(/gm)].map(m => m[1]),
  // Room instance fields (this.x = ...), e.g. id, tag, closed, localStream.
  ...[...room.matchAll(/\bthis\.(\w+)\s*=/g)].map(m => m[1]),
  // Module-level exports of the client entry (join and friends).
  ...[...room.matchAll(/^export (?:async )?(?:function|class|const) (\w+)/gm)].map(m => m[1]),
  // Members connect() layers onto the room.
  ...(() => {
    const start = sdk.indexOf('return Object.assign(room, {');
    const end = sdk.indexOf('\n  });', start);
    const block = start >= 0 && end > start ? sdk.slice(start, end) : '';
    return [...block.matchAll(/^    (?:async )?(\w+)(?:\(|:)/gm)].map(m => m[1]);
  })(),
]);

const offenders = [];
for (const doc of ['SDK.md', 'website/docs/sdk/client.mdx']) {
  const text = read(doc);
  const names = new Set();
  for (const m of text.matchAll(/^\| `(\w+)\(/gm)) names.add(m[1]);            // table method rows
  for (const m of text.matchAll(/\b(?:session|room)\.(\w+)/g)) names.add(m[1]); // member mentions
  for (const name of names) if (!surface.has(name)) offenders.push(`${doc}: ${name}`);
}

if (offenders.length) {
  for (const o of offenders) console.error(`  FAIL unknown API reference: ${o}`);
  console.error('docsyncgate: FAIL');
  process.exit(1);
}
console.log(`docsyncgate: PASS — ${surface.size} known members, docs in sync`);
