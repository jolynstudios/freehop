// SPDX-License-Identifier: Apache-2.0
// Keep the Pages security gate active while two unpatched build-tool advisories remain.
import {spawnSync} from 'node:child_process';

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
const unexpected = findings.filter(({name, entry, item}) =>
  knownUnpatched.get(name) !== item.url || entry.fixAvailable !== false,
);
if (unexpected.length || report.metadata.vulnerabilities.total && !findings.length) {
  for (const {name, item} of unexpected) console.error(`Unreviewed audit finding: ${name} ${item.url}`);
  process.exitCode = 1;
} else if (findings.length) {
  console.warn(`npm audit: ${report.metadata.vulnerabilities.total} transitive findings from ${findings.length} known, unpatched build-tool advisories.`);
  console.warn('These packages run only while building this static site; all other audit findings still fail this gate.');
} else {
  console.log('npm audit: no findings.');
}
