// SPDX-License-Identifier: Apache-2.0
// SHIP PIPELINE — run every gate before handing a build or a publish to a human.
// Ordered steps; fails loudly on the first red one. Mirrors the steelseed ship lane.
//
// Usage:  node tools/ship.mjs [--fast]
//         --fast skips the browser gates (test:browsers) for quick iteration;
//         NEVER ship or publish with --fast.
//
// Steps (each gates the next; the order is locked by test/ship.test.mjs):
//   1. unitgate      — full Node unit suite (test/*.test.mjs)
//   2. exportsgate   — package.json exports/bin resolve and parse
//   3. typesgate     — strict browser/Node consumer contracts
//   4. docsyncgate   — docs only reference APIs that exist
//   5. contractgate  — frozen public, wire and consumer (website, Redline) contracts
//   6. laddergate    — path-ladder decisions equal the stamped baseline traces
//   7. test:browsers — Playwright smoke over Chromium/Firefox/WebKit (skipped with --fast)
import { spawnSync } from 'node:child_process';
import { isMain } from './gate-lib.mjs';

export function createShipSteps({ run, fast = false }) {
  const steps = [];
  const step = (name, args) => steps.push({ name, fn: () => run('npm', args) });
  step('unitgate', ['run', 'test']);
  step('exportsgate', ['run', 'exportsgate']);
  step('typesgate', ['run', 'typesgate']);
  step('docsyncgate', ['run', 'docsyncgate']);
  step('contractgate', ['run', 'contractgate']);
  step('laddergate', ['run', 'laddergate']);
  if (!fast) step('test:browsers', ['run', 'test:browsers']);
  return steps;
}

if (isMain(import.meta.url)) {
  const run = (command, args) => {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`exited ${result.status}`);
  };
  const steps = createShipSteps({ run, fast: process.argv.includes('--fast') });
  let done = 0, current = '';
  const started = Date.now();
  try {
    for (const { name, fn } of steps) {
      done++; current = name;
      console.log(`\n=== [${done}/${steps.length}] ${name} ===`);
      fn();
    }
  } catch (error) {
    console.error(`\nSHIP: FAIL at step ${done}/${steps.length} — ${current} ${error.message}`);
    process.exit(1);
  }
  console.log(`\nSHIP: PASS — ${steps.length} steps in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}
