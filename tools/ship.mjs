// SPDX-License-Identifier: Apache-2.0
// SHIP PIPELINE — run every gate before handing a build or a publish to a human.
// Ordered steps; fails loudly on the first red one. Mirrors the steelseed ship lane.
//
// Usage:  node tools/ship.mjs [--fast]
//         --fast skips the browser gates (test:browsers) for quick iteration;
//         NEVER ship or publish with --fast.
//
// Steps (each gates the next):
//   1. unitgate      — full Node unit suite (test/*.test.mjs)
//   2. exportsgate   — package.json exports/bin resolve and parse
//   3. docsyncgate   — docs only reference APIs that exist
//   4. test:browsers — Playwright smoke over Chromium/Firefox/WebKit (skipped with --fast)
import { spawnSync } from 'node:child_process';

const fast = process.argv.includes('--fast');
const steps = [
  ['unitgate', ['run', 'test']],
  ['exportsgate', ['run', 'exportsgate']],
  ['docsyncgate', ['run', 'docsyncgate']],
];
if (!fast) steps.push(['test:browsers', ['run', 'test:browsers']]);

let done = 0;
const started = Date.now();
try {
  for (const [name, args] of steps) {
    done++;
    console.log(`\n=== [${done}/${steps.length}] ${name} ===`);
    const run = spawnSync('npm', args, { stdio: 'inherit' });
    if (run.status !== 0) throw new Error(`${name} exited ${run.status}`);
  }
} catch (error) {
  console.error(`\nSHIP: FAIL at step ${done}/${steps.length} — ${error.message}`);
  process.exit(1);
}
console.log(`\nSHIP: PASS — ${steps.length} steps in ${((Date.now() - started) / 1000).toFixed(0)}s`);
