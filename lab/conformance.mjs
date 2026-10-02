// SPDX-License-Identifier: Apache-2.0
// Independent TURN conformance: coturn's own test client (turnutils_uclient) against the
// peerlane TURN server, over UDP and TCP, in client-to-client mode (two allocations relaying
// to each other through the server). Runs inside the disposable lab container.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createTurnServer } from '../src/relay/turn-server.mjs';
import { writeEvidence } from '../test/browser/lab.mjs';

const run = (args) => new Promise(resolve => execFile('turnutils_uclient', args, { timeout: 60000, maxBuffer: 4 << 20 },
  (error, stdout, stderr) => resolve({ code: error?.code ?? 0, output: stdout + stderr })));
const report = { schema: 1, test: 'coturn-turnutils_uclient-vs-peerlane-turn', cases: [], passed: false };
const turn = await createTurnServer({
  listen: [{ transport: 'udp', host: '127.0.0.1', port: 3478 }, { transport: 'tcp', host: '127.0.0.1', port: 3478 }],
  relayHost: '127.0.0.1', realm: 'peerlane', allowPeer: () => true,
  authenticate: async name => name === 'alice' ? 'conformance-secret' : null,
  // Every uclient instance shares one username here; production keeps the per-peer quota.
  limits: { maxAllocationsPerUsername: 64 }
});
try {
  // coturn's client draws channel numbers from RFC 5766's 0x4000-0x7FFF; RFC 8656 allows only
  // 0x4000-0x4FFF (the rest is reserved for DTLS-SRTP demultiplexing), so the independent client
  // runs with Send/Data indications (-s). Browsers exercise ChannelData in the browser tests.
  for (const [name, extra] of [['udp', ['-s']], ['tcp', ['-t', '-s']]]) {
    const args = [...extra, '-c', '-u', 'alice', '-w', 'conformance-secret', '-y', '-n', '200', '-l', '400', '-m', '4', '-p', '3478', '127.0.0.1'];
    const { code, output } = await run(args);
    // uclient prints running counters; the final "tot_send_msgs=N, tot_recv_msgs=M" line is the total.
    const totals = [...output.matchAll(/tot_send_msgs=(\d+), tot_recv_msgs=(\d+)/g)].at(-1);
    const sent = Number(totals?.[1] ?? NaN), received = Number(totals?.[2] ?? NaN);
    const lost = Number(/Total lost packets\s*(\d+)/i.exec(output)?.[1] ?? NaN);
    report.cases.push({ name, code, sent, received, lost, tail: output.trim().split('\n').slice(-12) });
  }
  report.server = turn.stats();
  for (const c of report.cases) assert.ok(c.code === 0 && c.received > 0 && !(c.lost > c.sent * 0.05), `${c.name}: uclient exit ${c.code}, received ${c.received}, lost ${c.lost}`);
  assert.equal(report.server.authFailures, 0);
  report.passed = true;
} catch (error) { report.error = error.message; }
finally {
  await turn.close();
  const file = await writeEvidence('turn-conformance-coturn', report);
  for (const c of report.cases) console.log(c.name, 'exit', c.code, 'sent', c.sent, 'received', c.received, 'lost', c.lost);
  console.log(report.passed ? 'PASS' : 'FAIL: ' + report.error, file);
  process.exitCode = report.passed ? 0 : 1;
}
