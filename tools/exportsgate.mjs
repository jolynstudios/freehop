// SPDX-License-Identifier: Apache-2.0
// exportsgate — every package.json export and bin must resolve to a real file that parses.
// Catches a rename that leaves a dead entry in the public module map: an import that
// would only fail for users after publish.
// Usage: node tools/exportsgate.mjs
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  PASS ${name}`);
  else { fail++; console.error(`  FAIL ${name} ${detail}`); }
};

const targets = [];
function exportTargets(name, target) {
  if (typeof target === 'object' && target !== null) {
    for (const [condition, file] of Object.entries(target)) exportTargets(`${name}.${condition}`, file);
    return;
  }
  const path = resolve(root, target);
  check(`exports["${name}"] -> ${target}`, existsSync(path) && statSync(path).isFile());
  targets.push(path);
}
for (const [name, target] of Object.entries(pkg.exports ?? {})) exportTargets(name, target);
for (const [name, file] of Object.entries(pkg.bin ?? {})) {
  const path = resolve(root, file);
  check(`bin["${name}"] -> ${file}`, existsSync(path) && statSync(path).isFile());
  targets.push(path);
}
for (const path of new Set(targets)) {
  if (/\.d\.[cm]ts$/.test(path)) continue; // checked by typesgate with skipLibCheck:false
  const run = spawnSync(process.execPath, ['--check', path]);
  check(`syntax ${relative(root, path)}`, run.status === 0, run.stderr?.toString());
}

if (fail) {
  console.error(`exportsgate: FAIL — ${fail} red`);
  process.exit(1);
}
console.log(`exportsgate: PASS — ${targets.length} files`);
