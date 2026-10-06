// SPDX-License-Identifier: Apache-2.0
// Keep the Pages security gate active while unpatched build-tool advisories remain.
import {spawnSync} from 'node:child_process';

// name -> advisory URL. Every entry must still have no fixed release upstream; the
// moment one ships a fix the gate goes red again and the dependency must move.
const knownUnpatched = new Map([
  ['braces', 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm'],
  ['http-cache-semantics', 'https://github.com/advisories/GHSA-ch52-4w7c-c8xp'],
]);

const audit = spawnSync('npm', ['audit', '--json', '--audit-level=moderate'], {
  encoding: 'utf8',
  maxBuffer: 5 * 1024 * 1024,
});
if (audit.error) throw audit.error;

let report;
try { report = JSON.parse(audit.stdout); }
catch { throw new Error(`npm audit did not return JSON: ${audit.stderr || audit.stdout}`); }
if (report.error || !report.metadata?.vulnerabilities || !report.vulnerabilities) {
  throw new Error(`npm audit could not complete: ${JSON.stringify(report.error ?? report)}`);
}

const findings = Object.entries(report.vulnerabilities).flatMap(([name, entry]) =>
  entry.via.filter(item => typeof item === 'object').map(item => ({name, entry, item})),
);
const allowedUrls = new Set(knownUnpatched.values());

// An allowlisted package must still be unpatched upstream: the advisory covers every
// published version and npm offers no real fix. npm sometimes proposes a dependency
// reshuffle (an old framework version that happens to drop the package) as a "fix";
// that is tree-shuffling, not a patch, and never re-arms the gate here.
const isStaleAllowlistEntry = ({name, entry, item}) =>
  knownUnpatched.get(name) === item.url && !(entry.range === '*' && entry.fixAvailable === false);

// A downstream entry (a framework package flagged only because it carries the same
// advisory) is reviewed when every advisory it carries is allowlisted.
const isReviewed = ({entry}) => {
  const direct = entry.via.filter(item => typeof item === 'object');
  return direct.length > 0 && direct.every(item => allowedUrls.has(item.url));
};

const unexpected = findings.filter(f => !isReviewed(f) || isStaleAllowlistEntry(f));
if (unexpected.length || (report.metadata.vulnerabilities.total && !findings.length)) {
  for (const {name, item} of unexpected) console.error(`Unreviewed audit finding: ${name} ${item.url}`);
  for (const f of findings.filter(isStaleAllowlistEntry)) console.error(`Allowlist entry is stale, a fix exists: ${f.name} ${f.item.url}`);
  process.exitCode = 1;
} else if (findings.length) {
  const urls = [...new Set(findings.map(f => f.item.url))].join(', ');
  console.warn(`npm audit: ${report.metadata.vulnerabilities.total} transitive findings from known, unpatched build-tool advisories (${urls}).`);
  console.warn('These packages run only while building this static site; all other audit findings still fail this gate.');
} else {
  console.log('npm audit: no findings.');
}
