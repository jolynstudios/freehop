// SPDX-License-Identifier: Apache-2.0
// Compile real package consumers without skipLibCheck, separately in browser and Node.
// @ts-expect-error assertions catch APIs silently degrading to `any`.
import {mkdtempSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'freehop-types-'));
const contractDir = mkdtempSync(join(root, 'test/types/.exports-'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const compiler = process.env.FREEHOP_TSC ?? join(root, 'node_modules/typescript/bin/tsc');
try {
  const contract = [`type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;`, `type Assert<T extends true> = T;`];
  for (const [name, target] of Object.entries(pkg.exports)) {
    // Electron's preload can only execute inside Electron; it intentionally exports nothing.
    const values = name === './electron/preload' ? [] : Object.keys(await import(pathToFileURL(join(root, target.default)).href));
    const entry = name === '.' ? 'freehop' : `freehop/${name.slice(2)}`;
    contract.push(
      `type Export${contract.length} = Assert<Equal<keyof typeof import(${JSON.stringify(entry)}), ${values.map((v) => JSON.stringify(v)).join(' | ') || 'never'}>>;`,
    );
  }
  writeFileSync(join(contractDir, 'exports.mts'), contract.join('\n'));
  for (const [name, module, moduleResolution, lib, types] of [
    ['browser', 'NodeNext', 'NodeNext', ['ES2022', 'DOM', 'DOM.Iterable'], []],
    ['browser', 'ESNext', 'Bundler', ['ES2022', 'DOM', 'DOM.Iterable'], []],
    ['node', 'NodeNext', 'NodeNext', ['ES2022'], ['node']],
    ['exports', 'NodeNext', 'NodeNext', ['ES2022', 'DOM', 'DOM.Iterable'], ['node']],
  ]) {
    const config = join(temp, `${name}-${moduleResolution}.json`);
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          target: 'ES2022',
          module,
          moduleResolution,
          lib,
          types,
          typeRoots: [join(root, 'node_modules/@types')],
        },
        files: [name === 'exports' ? join(contractDir, 'exports.mts') : join(root, `test/types/${name}.mts`)],
      }),
    );
    const run = spawnSync(process.execPath, [compiler, '-p', config], {stdio: 'inherit'});
    if (run.status !== 0) throw new Error(`${name}/${moduleResolution} compile failed`);
    console.log(`typesgate: PASS ${name}/${moduleResolution}`);
  }
  for (const [name, target] of Object.entries(pkg.exports)) {
    if (!target.types || Object.keys(target)[0] !== 'types') throw new Error(`Missing first types condition: ${name}`);
  }
  console.log(`typesgate: PASS ${Object.keys(pkg.exports).length} typed entry points`);
} finally {
  rmSync(temp, {recursive: true, force: true});
  rmSync(contractDir, {recursive: true, force: true});
}
