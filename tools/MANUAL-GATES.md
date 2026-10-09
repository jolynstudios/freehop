# Manual gates

These gates guard real behaviour that `npm run ship` and CI cannot run on an ordinary machine.
Each entry records what the gate guards, why it is manual, how to run it, and what must hold.
Run the relevant ones before a release whose changes touch the area they guard.

## NAT lab matrix

- **Guards:** every path-ladder route on real Chromium, Firefox and WebKit behind kernel NAT profiles,
  with audio and video flowing and gate traffic signalling-sized.
- **Why manual:** it needs a disposable, privileged Linux container (network namespaces, iptables,
  nftables, miniupnpd). It must never run directly on a developer machine or CI runner.
- **Run:** `lab/docker.sh qualify` (or one scenario: `lab/docker.sh hard-pair`) on any machine with
  Docker, including Docker Desktop on macOS. It builds `lab/Dockerfile` and runs each scenario in a throwaway
  `--privileged` container. Inside an existing lab container: `FREEHOP_DISPOSABLE_LAB=yes lab/qualify.sh`.
- **Must hold:** every `SCENARIOS` expectation in `lab/nat-run.mjs`; `hard-pair` and `gate-only` stay
  `unreachable` with the default options. Evidence lands in `test/evidence/nat-*.json`.
- **Opt-in rung scenarios** (added with the `classifyNat`, `portPrediction` and `turn` options):
  `eim-random` and `udpblock-eim` document pairs that stay unreachable by default; `hard-pair-turn` and
  `udpblock-pair-turn` must report `relay` via `turn` through the application's TURN server
  (`lab/turn-proc.mjs`); `random-eim-predict` and `hard-pair-predict` must stay unreachable with no
  prediction attempt. Run each with `lab/docker.sh <name>`.
- **Last run (9 October 2026, Chromium, Docker Desktop on macOS, Linux 6.10):** the 12 existing scenarios
  and the 6 opt-in scenarios each passed once, and coturn conformance passed (UDP and TCP 800/800, 0 lost).
  This is one run, not the three-trial cross-engine qualification.

## Port prediction on real networks

- **Guards:** the `portPrediction` rung where it matters: a home router against a carrier NAT that
  allocates ports in order, and two such carrier NATs.
- **Why manual:** Linux NAT cannot allocate ports sequentially, so the lab has no such profile; it needs
  real SIMs or routers, and the browsers on them.
- **Run:** two browsers on the networks under test join one room with `{ portPrediction: true }` and at
  least two `stun:` servers at different addresses; record `(await session.stats()).nat` on both sides
  and the `path` events.
- **Must hold before `portPrediction` defaults on:** a `direct` path for the home-router↔sequential
  pair, `predictAttempts` counted once per link, and no change for pairs that connected without it.

## Browser suites in CI

- **Guards:** the TLS mesh, multi-gate outage, kick/rekey and SDK example suites on three engines,
  and the application TURN rung in Chromium (`test/browser/turn-rung.mjs`, needs a LAN IPv4 address).
- **Why manual:** CI runners have no browsers installed; `npm run ship` (without `--fast`) runs them.
- **Run:** `npm run ship`, or `npm run test:browsers`.

## Redline Wars cross-repository gate

- **Guards:** a real consumer: Redline's five-peer browser gate (audio and video on every pair, bitrate
  caps) against this working tree instead of its pinned npm release.
- **Why manual:** it lives in `../redline-wars-unified-release`, needs that checkout's dependencies, and runs
  on macOS with browsers.
- **Run:** in `../redline-wars-unified-release/web`:
  `FREEHOP_TEST_SOURCE=/path/to/freehop node tools/freehop-browser-gate.mjs`
- **Must hold:** `freehop-browser-gate PASS`. Only the bare `freehop` import is redirected; `freehop/gate`,
  `freehop/authority` and `freehop/ticket` still come from Redline's pinned release, which doubles as an
  old-version compatibility check. `tools/contractgate.mjs` covers the structural rules Redline's asset gate
  applies to the bundled client.
- **Status (9 October 2026):** red before any media flows, on Redline's own pinned `0.1.0-alpha.3` as well as
  on Freehop HEAD and the working tree: its harness reports `Room fedcba9876543210 is not open` and "Call
  access could not be updated". The failure is identical with and without this repository's changes, so it
  provides no evidence until Redline's harness is fixed.

## TURN browser interoperability

- **Guards:** relay-only connections through Freehop's TURN server over UDP and TCP on real engines.
- **Why manual:** needs a LAN IPv4 address (browsers ignore loopback for ICE) and installed browsers.
- **Run:** `node test/interop/turn-browser.mjs`
