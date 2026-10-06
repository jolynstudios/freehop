// SPDX-License-Identifier: Apache-2.0
// unitgate — runs the full Node unit suite (test/*.test.mjs) and fails loudly on any red.
// Usage: node tools/unitgate.mjs
import { spawnSync } from 'node:child_process';

const run = spawnSync('npm', ['test'], { stdio: 'inherit' });
if (run.status !== 0) {
  console.error('unitgate: FAIL');
  process.exit(run.status ?? 1);
}
console.log('unitgate: PASS');
