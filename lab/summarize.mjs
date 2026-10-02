// SPDX-License-Identifier: Apache-2.0
// Summarise NAT-lab evidence: one row per run, then pass counts per scenario/browser.
// Usage: node lab/summarize.mjs [--since=2026-10-01T21:00] [--markdown]
import { readdir, readFile } from 'node:fs/promises';

const dir = new URL('../test/evidence/', import.meta.url);
const since = process.argv.find(a => a.startsWith('--since='))?.slice(8);
const markdown = process.argv.includes('--markdown');
const runs = [];
for (const name of (await readdir(dir)).filter(n => n.startsWith('nat-') && n.endsWith('.json')).sort()) {
  const r = JSON.parse(await readFile(new URL(name, dir), 'utf8'));
  if (since && r.startedAt < since) continue;
  const pairs = Object.entries(r.pairs ?? {}).map(([pair, sides]) => {
    const s = Object.values(sides);
    const paths = [...new Set(s.map(x => x.path + (x.via ? '@' + x.via : '')))].join('/');
    return `${pair}:${paths}`;
  });
  runs.push({ scenario: r.scenario, browser: r.browser, passed: r.passed, pairs: pairs.join(' '), gateKB: r.gateTotals ? Math.round((r.gateTotals.bytesIn + r.gateTotals.bytesOut) / 1024) : null, error: r.error ?? '', at: r.startedAt });
}
const groups = new Map();
for (const r of runs) {
  const key = `${r.scenario} (${r.browser})`;
  const g = groups.get(key) ?? { pass: 0, total: 0, pairs: new Set(), gateKB: [] };
  g.total++; if (r.passed) g.pass++;
  if (r.passed) { g.pairs.add(r.pairs); if (r.gateKB !== null) g.gateKB.push(r.gateKB); }
  groups.set(key, g);
}
if (markdown) {
  console.log('| Scenario (browsers) | Passed | Paths per pair | Gate traffic per run |');
  console.log('|---|---|---|---|');
  for (const [key, g] of groups) console.log(`| ${key} | ${g.pass}/${g.total} | ${[...g.pairs].join('<br>')} | ${g.gateKB.length ? `${Math.min(...g.gateKB)}–${Math.max(...g.gateKB)} KB` : '—'} |`);
} else {
  for (const r of runs) console.log(`${r.at.slice(11, 19)} ${r.passed ? 'PASS' : 'FAIL'} ${r.scenario.padEnd(26)} ${String(r.browser).padEnd(8)} ${r.pairs} ${r.gateKB ?? '-'}KB ${r.error.slice(0, 80)}`);
  console.log();
  for (const [key, g] of groups) console.log(`${String(g.pass).padStart(2)}/${g.total} ${key}`);
}
