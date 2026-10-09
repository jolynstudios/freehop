// SPDX-License-Identifier: Apache-2.0
// contractgate — what applications already built on Freehop rely on must not move.
// WHY THIS EXISTS: consumers depend on more than the typed API. The website copies src/client
// verbatim; Redline Wars' asset gate fingerprints the bundled client (exactly two gate/tracker
// WebSocket constructions, the ICE URL validator texts, no other network primitive, no remote URL)
// and string-patches the Electron preload; the ladder, signalling and ticket formats are wire
// contracts between versions. This gate freezes them against tools/baselines/contract.json plus
// hard rules mirrored from Redline's engine/steelseed-host/tools/assetgate.mjs.
// It does NOT prove: behaviour (laddergate, unit and browser suites do) or TypeScript types
// (typesgate does).
//
// Usage: node tools/contractgate.mjs [--restamp=<exports|client|tickets|all>] [--falsify=<name>]
//   --restamp=x       rewrite those baseline sections after reviewing the diff this gate printed
// Negative controls:
//   every run feeds each detector a mutated copy (added WebSocket, remote URL, removed export,
//   patched preload line, cross-directory client import) and requires it to be caught
//   --falsify=network-primitive|remote-url|export-removed|preload-line|client-import   must exit 1
import { readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, falsifier, firstDifference, isMain, listArg, read, root } from './gate-lib.mjs';

const TOOL = 'contractgate';
export const BASELINE = 'tools/baselines/contract.json';
export const PRELOAD_LINE = "const { contextBridge, ipcRenderer } = require('electron');";
// Mirrored from Redline's assetgate placeholderHosts; anything else in a client URL is an origin.
const PLACEHOLDER_HOSTS = new Set(['host', 'host:port', 'ip', 'ip:port', 'hostname', 'example.com', 'example.org', '192.168.x.x', '127.0.0.1', 'localhost', '[::1]']);

export function clientSources() {
  const dir = resolve(root, 'src/client');
  return readdirSync(dir).filter(name => name.endsWith('.mjs')).sort().map(name => ({ name, text: read(`src/client/${name}`) }));
}

// Redline fingerprints the bundled client chunk; the source must keep every marker it checks.
export function clientChunkProblems(text) {
  const problems = [];
  if (!text.includes('new URL(`http://${')) problems.push('ICE URL validation template `new URL(`http://${` missing');
  if (!text.includes('stun|stuns|turn|turns')) problems.push('ICE scheme pattern `stun|stuns|turn|turns` missing');
  const sockets = [...text.matchAll(/new this\.WebSocketImpl\(this\.url\)/g)].length;
  if (sockets !== 2) problems.push(`expected exactly 2 \`new this.WebSocketImpl(this.url)\`, found ${sockets}`);
  const primitives = [...text.matchAll(/\bnew\s+(XMLHttpRequest|WebSocket|EventSource)\s*\(|\bnavigator\s*\.\s*sendBeacon\s*\(/g)].map(m => m[0]);
  if (primitives.length) problems.push(`network primitive in client: ${primitives.join(', ')}`);
  for (const match of text.matchAll(/https?:\/\/([^/\s"'`#?()<>;,]+)/gi)) {
    const host = match[1].toLowerCase().replace(/:\d+$/, '');
    if (!host.startsWith('${') && !PLACEHOLDER_HOSTS.has(host)) problems.push(`remote URL host ${host} in client`);
  }
  return problems;
}

// website/scripts/copy-lib.mjs copies src/client/*.mjs alone, and the lab and example servers only
// serve /^[a-z-]+\.mjs$/: client modules import siblings only and keep plain names.
export function clientLayoutProblems(files) {
  const problems = [];
  for (const { name, text } of files) {
    if (!/^[a-z-]+\.mjs$/.test(name)) problems.push(`client module name ${name} does not match [a-z-]+.mjs`);
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g)) {
      if (!/^\.\/[a-z-]+\.mjs$/.test(m[1])) problems.push(`${name} imports ${m[1]} (client modules may import ./sibling.mjs only)`);
    }
  }
  return problems;
}

export function preloadProblems(text) { return text.includes(PRELOAD_LINE) ? [] : [`Electron preload no longer contains the exact line ${PRELOAD_LINE}`]; }

export async function runtimeExports() {
  const pkg = JSON.parse(read('package.json'));
  const out = {};
  for (const [name, target] of Object.entries(pkg.exports)) {
    // Electron's preload only runs inside Electron; it intentionally exports nothing.
    out[name] = name === './electron/preload' ? [] : Object.keys(await import(pathToFileURL(join(root, target.default)).href)).sort();
  }
  return { entries: out, bin: Object.keys(pkg.bin ?? {}).sort() };
}

export function exportProblems(expected, actual) {
  const problems = [];
  for (const [entry, names] of Object.entries(expected.entries ?? {})) {
    if (!(entry in actual.entries)) { problems.push(`entry point ${entry} removed`); continue; }
    for (const name of names) if (!actual.entries[entry].includes(name)) problems.push(`${entry} no longer exports ${name}`);
    for (const name of actual.entries[entry]) if (!names.includes(name)) problems.push(`${entry} exports new ${name} (restamp exports after review)`);
  }
  for (const entry of Object.keys(actual.entries)) if (!(entry in (expected.entries ?? {}))) problems.push(`new entry point ${entry} (restamp exports after review)`);
  const bin = firstDifference(expected.bin ?? [], actual.bin);
  if (bin) problems.push(`bin ${bin}`);
  return problems;
}

export async function clientContract() {
  const room = read('src/client/room.mjs'), types = read('src/client/peerlane.d.mts');
  const client = await import(pathToFileURL(join(root, 'src/client/peerlane.mjs')).href);
  const kinds = [...(/const KINDS = new Set\(\[([\s\S]*?)\]\)/.exec(room)?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map(m => m[1]);
  const pathKinds = [...(/export type PathKind = ([^;]+);/.exec(types)?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map(m => m[1]);
  const { createFakePeerConnection } = await import('../test/fakes/fake-pc.mjs');
  const fake = new client.Room({ gates: ['wss://gate.invalid/contract'], RTCPeerConnection: createFakePeerConnection({ register: () => 'pc', record() {}, evaluate() {}, candidatesFor: () => [], stats: async () => new Map() }) });
  fake.tag = 'T'.repeat(22); fake.crypto = { tag: fake.tag };
  const caps = await fake.capsFor('B'.repeat(22));
  return { kinds, pathKinds, phase: { ...client.PHASE }, defaultTiming: { ...client.DEFAULT_TIMING }, defaultLimits: { ...client.DEFAULT_LIMITS }, capsKeys: Object.keys(caps) };
}

// Issued ticket key order is part of the encoded bytes applications store and compare.
export async function ticketContract() {
  const { createAuthority } = await import(pathToFileURL(join(root, 'src/sdk/authority.mjs')).href);
  const keysOf = async options => {
    const authority = createAuthority({ app: 'contract', gates: ['wss://gate.invalid/contract'], stun: ['stun:stun.invalid:3478'], ...options });
    await authority.openRoom('room');
    return Object.keys(await authority.ticket('room', 'member'));
  };
  return { issuedKeys: await keysOf({}), issuedKeysWithAuth: await keysOf({ gateTokenSecret: 'g'.repeat(32) }) };
}

// Tickets earlier releases issued or accepted must keep their verdicts.
export const TICKET_CORPUS = [
  ['alpha.3 shape', { v: 1, app: 'game', roomId: 'r', epoch: 1, gates: ['wss://gate.invalid/g'], stun: [], secret: 's'.repeat(43) }, true],
  ['alpha.4 with stun and auth', { v: 1, app: 'game', roomId: 'r', epoch: 2, gates: ['wss://gate.invalid/g'], stun: ['stun:stun.invalid:3478'], secret: 's'.repeat(43), auth: { 'wss://gate.invalid/g': 'token' } }, true],
  ['tracker gate', { v: 1, app: 'game', roomId: 'r', epoch: 1, gates: ['bt+wss://tracker.invalid'], secret: 's'.repeat(43) }, true],
  ['unknown extra field', { v: 1, app: 'game', roomId: 'r', epoch: 1, gates: ['wss://gate.invalid/g'], secret: 's'.repeat(43), extra: { anything: true } }, true],
  ['wrong version', { v: 2, app: 'game', roomId: 'r', epoch: 1, gates: ['wss://gate.invalid/g'], secret: 's'.repeat(43) }, false],
  ['no gates', { v: 1, app: 'game', roomId: 'r', epoch: 1, gates: [], secret: 's'.repeat(43) }, false],
  ['short secret', { v: 1, app: 'game', roomId: 'r', epoch: 1, gates: ['wss://gate.invalid/g'], secret: 's'.repeat(21) }, false],
  ['bad stun', { v: 1, app: 'game', roomId: 'r', epoch: 1, gates: ['wss://gate.invalid/g'], stun: ['http://stun.invalid'], secret: 's'.repeat(43) }, false],
  ['auth for tracker gate', { v: 1, app: 'game', roomId: 'r', epoch: 1, gates: ['bt+wss://tracker.invalid'], auth: 'token', secret: 's'.repeat(43) }, false],
];

export async function ticketCorpusProblems() {
  const { validTicket } = await import(pathToFileURL(join(root, 'src/sdk/ticket.mjs')).href);
  const expires = Math.floor(Date.now() / 1000) + 3600;
  return TICKET_CORPUS.filter(([, ticket, valid]) => validTicket({ ...ticket, expires }) !== valid)
    .map(([name, , valid]) => `ticket corpus "${name}" is now ${valid ? 'rejected' : 'accepted'}`);
}

export const FALSIFIERS = ['network-primitive', 'remote-url', 'export-removed', 'preload-line', 'client-import'];

if (isMain(import.meta.url)) {
  const falsify = falsifier(TOOL, FALSIFIERS);
  const restamp = listArg('restamp');
  const sections = ['exports', 'client', 'tickets'];
  if (restamp && (falsify || !restamp.length || restamp.some(s => s !== 'all' && !sections.includes(s)))) {
    console.error(`${TOOL}: FAIL — --restamp takes ${sections.join('|')}|all and cannot be combined with --falsify`); process.exit(2);
  }
  let baseline; try { baseline = JSON.parse(read(BASELINE)); } catch { baseline = { schema: 1 }; }

  const files = clientSources();
  let clientText = files.map(f => f.text).join('\n');
  let preload = read('src/electron/preload.cjs');
  const exportsActual = await runtimeExports();
  const actual = { exports: exportsActual, client: await clientContract(), tickets: await ticketContract() };
  if (falsify === 'network-primitive') clientText += '\nconst probe = new WebSocket(url);';
  if (falsify === 'remote-url') clientText += '\n// see https://relay.invalid/docs';
  if (falsify === 'export-removed') actual.exports = { ...exportsActual, entries: { ...exportsActual.entries, '.': exportsActual.entries['.'].slice(1) } };
  if (falsify === 'preload-line') preload = preload.replace(PRELOAD_LINE, PRELOAD_LINE.replace('const {', 'const  {'));
  if (falsify === 'client-import') files.push({ name: 'nat.mjs', text: "import { mintGateToken } from '../shared/tokens.mjs';" });

  if (restamp) {
    for (const section of restamp.includes('all') ? sections : restamp) {
      const difference = baseline[section] && firstDifference(JSON.parse(canonicalJson(baseline[section])), JSON.parse(canonicalJson(actual[section])));
      if (difference) console.log(`  restamp ${section}: ${difference}`);
      baseline[section] = actual[section];
    }
    writeFileSync(resolve(root, BASELINE), canonicalJson({ schema: 1, exports: baseline.exports, client: baseline.client, tickets: baseline.tickets }));
    console.log(`${TOOL}: stamped ${restamp.join(', ')} — review the baseline diff before committing`);
    process.exit(0);
  }

  const checks = [
    ['exports', baseline.exports ? exportProblems(baseline.exports, actual.exports) : ['no exports baseline (run --restamp=exports after review)']],
    ['client constants', baseline.client ? [firstDifference(JSON.parse(canonicalJson(baseline.client)), JSON.parse(canonicalJson(actual.client)))].filter(Boolean) : ['no client baseline']],
    ['ticket format', baseline.tickets ? [firstDifference(baseline.tickets, actual.tickets)].filter(Boolean) : ['no tickets baseline']],
    ['ticket corpus', await ticketCorpusProblems()],
    ['redline client chunk', clientChunkProblems(clientText)],
    ['client layout', clientLayoutProblems(files)],
    ['redline preload', preloadProblems(preload)],
  ];

  // Witnessed red: every detector must catch a planted violation.
  const original = files.filter(f => f.name !== 'nat.mjs' || falsify !== 'client-import');
  const pristine = original.map(f => f.text).join('\n');
  const controls = [
    ['added WebSocket', clientChunkProblems(`${pristine}\nnew WebSocket(u);`).some(p => p.includes('network primitive'))],
    ['remote URL', clientChunkProblems(`${pristine}\n// https://cdn.invalid/x`).some(p => p.includes('remote URL'))],
    ['third WebSocketImpl', clientChunkProblems(`${pristine}\nnew this.WebSocketImpl(this.url)`).some(p => p.includes('exactly 2'))],
    ['removed export', exportProblems(exportsActual, { ...exportsActual, entries: { ...exportsActual.entries, '.': [] } }).length > 0],
    ['patched preload', preloadProblems(PRELOAD_LINE.replace('ipcRenderer', 'ipc')).length > 0],
    ['cross-directory import', clientLayoutProblems([{ name: 'x.mjs', text: "import a from '../sdk/ticket.mjs';" }]).length > 0],
  ];
  const missed = controls.filter(([, caught]) => !caught).map(([name]) => name);

  let red = 0;
  for (const [name, problems] of checks) {
    if (problems.length) { red += problems.length; for (const problem of problems) console.error(`  FAIL ${name}: ${problem}`); }
    else console.log(`  PASS ${name}`);
  }
  for (const name of missed) { red++; console.error(`  FAIL negative control not witnessed red: ${name}`); }
  if (red) { console.error(`${TOOL}: FAIL — ${red} problem${red === 1 ? '' : 's'}${falsify ? ` (falsifier ${falsify})` : ''}`); process.exit(1); }
  console.log(`${TOOL}: PASS — ${Object.keys(actual.exports.entries).length} entry points, ${actual.client.kinds.length} signalling kinds, ${TICKET_CORPUS.length} corpus tickets, Redline client markers intact; ${controls.length} planted violations witnessed red`);
}
