// SPDX-License-Identifier: Apache-2.0
// Manual, read-only probe of the real local router:  node test/port-mapper-probe.mjs [--verbose]
// Sends a PCP ANNOUNCE, a NAT-PMP external-address request, an SSDP search, fetches the IGD description and calls
// GetExternalIPAddress. It never creates, refreshes or deletes a port mapping.
import { createPortMapper } from '../src/relay/port-mapper.mjs';

if (process.env.NODE_TEST_CONTEXT) {
  // `node --test` runs every .mjs under test/: never touch the real network from the test runner.
  console.log('port-mapper-probe: skipped under node --test (run it directly)');
} else {
  const events = [];
  const mapper = await createPortMapper({ log: (event, details) => events.push({ event, ...details }) });
  try {
    const started = Date.now();
    const result = await mapper.probe();
    console.log(JSON.stringify({ ...result, elapsedMs: Date.now() - started }, null, 2));
    if (process.argv.includes('--verbose')) console.log(JSON.stringify(events, null, 2));
  } finally {
    await mapper.close();
  }
}
