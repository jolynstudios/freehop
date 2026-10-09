// SPDX-License-Identifier: Apache-2.0
// gate-lib — helpers shared by Freehop's gates. Mirrors the steelseed gate-lib: one TOOL name per
// gate, one final "<tool>: PASS — …" or "<tool>: FAIL — …" line, exit 1 on a red gate and 2 on bad
// usage, baselines checked into git and rewritten only by an explicit flag.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function read(path) { return readFileSync(resolve(root, path), 'utf8'); }

export function walk(dir, excluded = new Set()) {
  const files = [];
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded.has(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path); else if (entry.isFile()) files.push(path);
    }
  };
  visit(dir);
  return files;
}

export function slashRelative(from, path) { return relative(from, path).split(sep).join('/'); }

export function fail(tool, message) { throw new Error(`${tool}: ${message}`); }

// Sorted keys at every depth, so a baseline diff shows only real changes.
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function canonicalJson(value) { return `${JSON.stringify(canonical(value), null, 2)}\n`; }

// The first path at which two JSON values differ, for a readable FAIL line.
export function firstDifference(expected, actual, path = '$') {
  if (Object.is(expected, actual)) return null;
  if (typeof expected !== typeof actual || Array.isArray(expected) !== Array.isArray(actual) || !expected || !actual || typeof expected !== 'object')
    return `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  const keys = Array.isArray(expected) ? [...Array(Math.max(expected.length, actual.length)).keys()] : [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const key of keys) {
    const difference = firstDifference(expected[key], actual[key], `${path}${Array.isArray(expected) ? `[${key}]` : `.${key}`}`);
    if (difference) return difference;
  }
  return null;
}

// Labels must appear in this order (each after the previous one).
export function ordered(text, labels) {
  let at = -1;
  for (const label of labels) {
    const index = text.indexOf(label, at + 1);
    if (index < 0) throw new Error(`missing or out of order: ${label}`);
    at = index;
  }
  return true;
}

export function isMain(url) { return !!process.argv[1] && url === pathToFileURL(resolve(process.argv[1])).href; }

// --falsify=<name>: inject a known drift that must turn the gate red. Unknown names are bad usage (exit 2).
export function falsifier(tool, known, argv = process.argv) {
  const arg = argv.find(value => value.startsWith('--falsify='));
  if (!arg) return null;
  const name = arg.slice('--falsify='.length);
  if (!known.includes(name)) { console.error(`${tool}: FAIL — unknown falsifier '${name}' (known: ${known.join(', ')})`); process.exit(2); }
  return name;
}

export function listArg(name, argv = process.argv) {
  const arg = argv.find(value => value === `--${name}` || value.startsWith(`--${name}=`));
  if (!arg) return null;
  return arg.includes('=') ? arg.slice(arg.indexOf('=') + 1).split(',').filter(Boolean) : [];
}
