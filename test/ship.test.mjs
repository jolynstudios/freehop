// SPDX-License-Identifier: Apache-2.0
// Locks the ship lane: gate order, what --fast drops, and stop-on-first-failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createShipSteps } from '../tools/ship.mjs';
import { ordered } from '../tools/gate-lib.mjs';
import { readFileSync } from 'node:fs';

const pipeline = fast => {
  const calls = [];
  const steps = createShipSteps({ fast, run: (command, args) => calls.push([command, ...args].join(' ')) });
  for (const step of steps) step.fn();
  return { steps, calls };
};

test('full ship runs every gate in the locked order, browsers last', () => {
  const { steps, calls } = pipeline(false);
  assert.deepEqual(steps.map(s => s.name), ['unitgate', 'exportsgate', 'typesgate', 'docsyncgate', 'contractgate', 'laddergate', 'test:browsers']);
  assert.deepEqual(calls, ['npm run test', 'npm run exportsgate', 'npm run typesgate', 'npm run docsyncgate', 'npm run contractgate', 'npm run laddergate', 'npm run test:browsers']);
});

test('--fast drops only the browser gate', () => {
  assert.deepEqual(pipeline(true).calls, pipeline(false).calls.slice(0, -1));
});

test('a red gate stops every later gate', () => {
  const calls = [];
  const steps = createShipSteps({ run: (command, args) => { calls.push(args[1]); if (args[1] === 'typesgate') throw new Error('typesgate exited 1'); } });
  assert.throws(() => { for (const step of steps) step.fn(); }, /typesgate exited 1/);
  assert.deepEqual(calls, ['test', 'exportsgate', 'typesgate']);
});

test('every ship gate has an npm script and runs in CI', () => {
  const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
  for (const name of ['test', 'exportsgate', 'typesgate', 'docsyncgate', 'contractgate', 'laddergate', 'test:browsers']) assert.ok(scripts[name], `npm script ${name}`);
  const ci = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  assert.ok(ordered(ci, ['npm test', 'npm run exportsgate', 'npm run typesgate', 'npm run docsyncgate', 'npm run contractgate', 'npm run laddergate']));
  assert.throws(() => ordered(ci.replace('npm run laddergate', ''), ['npm run contractgate', 'npm run laddergate']));
});
