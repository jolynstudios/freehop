# Freehop verification results

## Alpha.6 release checks — 10 October 2026

Alpha.6 keeps the application's TURN relay (`turn`) the last resort after it connects a pair. A pair it carries checks for a cheaper route by restarting ICE with the relay still configured: after `timing.turnUpgradeMs` (60 s), then at doubling intervals up to `maxRetryMs`, and within seconds when a gateway it could use appears. Once another route has held for two media checks, the relay leaves the pair's ICE servers and one more restart ends its allocations. Only the client changed; the gate, the TURN server and the ticket format did not.

- `npm run ship` passed: 208 unit tests; the export, type, documentation, contract and ladder gates; and the Chromium/Firefox/WebKit TLS mesh, multi-gate outage, kick/rekey, SDK example, application-TURN and TURN-upgrade browser suites.
- `laddergate` replayed 23 path-ladder scenarios. The 19 stamped for alpha.5 are byte-identical; four new ones cover a pair that stays on the relay, one that moves to a direct route and back to TURN when that route breaks, one that moves to a gateway appearing mid-call, and the polite side.
- `test/browser/turn-upgrade.mjs`, two Chromium peers on one machine whose pages first accept only relayed candidates: a check with nothing better kept the call on the relay with no gap in the audio. Once every candidate was accepted, both peers moved to a direct route by themselves, again with no audio gap; the relay forwarded 0 bytes afterwards and its allocations ended about 70 s later. A variant without the final restart left one allocation open for the rest of the run, so that restart is what releases the relay.
- Not verified: leaving the relay on real networks, in WebKit and in Firefox. In this relay-only setup Firefox gets no audio in one direction through the application relay (the TURN server drops it for a missing permission), also with the alpha.5 code, so Firefox through the application relay remains unverified. The Linux NAT lab and coturn conformance were not rerun; their alpha.5 results stand.

## Alpha.5 release checks — 9 October 2026

Alpha.5 adds opt-in last resorts before `unreachable`: NAT classification (`classifyNat`), port prediction (`portPrediction`) and the application's own TURN relay (`turn`). All are off by default.

- `npm run ship` passed: 201 unit tests; the export, type, documentation, contract and ladder gates; and the Chromium/Firefox/WebKit TLS mesh, multi-gate outage, kick/rekey, SDK example and application-TURN browser suites.
- `laddergate` replayed 19 path-ladder scenarios; the 12 with the new options unset match traces recorded from the unmodified ladder byte for byte.
- The Linux NAT lab, packaged as a disposable Docker container (`lab/docker.sh`, Docker Desktop on macOS, Linux 6.10), ran every existing scenario once with Chromium: all 12 passed with the same routes as on 2 October. The six new scenarios passed once each: `eim-random` and `udpblock-eim` stay unreachable with default options; `hard-pair-turn` (UDP) and `udpblock-pair-turn` (TCP) connect as relay via `turn` through the application's TURN server; `random-eim-predict` and `hard-pair-predict` stay unreachable with no prediction attempt.
- coturn's `turnutils_uclient` against Freehop's TURN server: UDP 800/800 and TCP 800/800, 0 lost.
- After publication, a fresh install of `freehop@0.1.0-alpha.5` from npm passed compile and runtime smoke checks; the npm archive is byte-identical to the GitHub release asset.
- Not verified: port prediction's success case (a NAT that hands out ports in order) cannot be simulated with Linux NAT and has not been tested on real networks, so the option stays off by default. These are one-run, single-engine lab results, not the three-trial cross-engine qualification.

## Alpha.4 release checks — 7 October 2026

`npm run ship` passed: 173 unit tests, export and documentation gates, and the local Chromium/Firefox/WebKit TLS mesh, multi-gate outage, kick/rekey and SDK example suites. TypeScript 6 and 7 consumers passed across all 15 public entry points, including backend-only and Electron checks. A fresh install of `freehop@0.1.0-alpha.4` from npm passed compile and runtime smoke checks.

The 40-run Linux NAT matrix below is dated 2 October 2026 and has not been rerun for alpha.4. Its network evidence is separate from the current release checks. See the [release changelog](https://github.com/jolynstudios/freehop/releases/tag/v0.1.0-alpha.4).

## Network evidence — 2 October 2026

**Outcome:** browser and desktop audio/video connected peer-to-peer in every simulated network
where *any* route exists inside the session. That includes the cases the earlier direct-only
research proved impossible directly: two fully random symmetric NATs, and UDP-blocking
networks. In this test setup, the operator ran only gates, which carry sealed signalling of tens of KB per call and
never media. When no direct route exists, media goes through machines that belong to the
session: a desktop participant's own gateway, the session's host node, or another participant. A hard-NAT pair without a helper remains unreachable. A network that reaches only the gate remains unreachable even with session helpers. There, media is impossible without
the operator carrying it, and Freehop reports `unreachable`.

## Original home-lab network test run (before subsequent security fixes)

These tests were designed and run by Freehop's developer in a home lab. They use an isolated,
disposable Linux environment with simulated NATs; this was not an independent testing lab and
did not test real ISP, carrier, corporate or physical home-router networks.

Real Chromium 151, Firefox 153 and WebKit 26.5 ran in separate Linux network namespaces, each
behind its own kernel-NAT router profile, with fake camera and microphone. Every run asserts:
- the path each side reports;
- audio packets (more than 50) and decoded video frames (more than 30) per origin peer;
- that gate traffic stays signalling-sized.

| Scenario (browsers) | Passed | Paths per pair | Gate traffic per run |
|---|---|---|---|
| direct-eim (chromium) | 3/3 | a-b:direct | 31–32 KB |
| direct-eim (mixed) | 1/1 | a-b:direct | 34 KB |
| ipv6-direct (chromium) | 3/3 | a-b:direct (IPv6, IPv4 UDP blocked) | 34 KB |
| ipv6-direct (mixed) | 1/1 | a-b:direct | 36 KB |
| hard-pair (chromium) | 3/3 | a-b:unreachable (two random NATs, nobody else: expected) | 93 KB |
| hard-pair-bridge (chromium) | 3/3 | a-c:direct b-c:direct a-b:bridged@c | 91 KB |
| hard-pair-bridge (mixed) | 1/1 | a-c:direct b-c:direct a-b:bridged@c | 80 KB |
| two-peer-desktop-host (chromium) | 3/3 | a-g:gateway@g | 37–66 KB |
| two-peer-desktop-host (mixed) | 1/1 | a-g:gateway@g | 34 KB |
| hard-pair-gateway (chromium) | 3/3 | a-g:gateway@g b-g:gateway@g a-b:relay@g | 143–201 KB |
| hard-pair-gateway (mixed) | 1/1 | a-g:gateway@g b-g:gateway@g a-b:relay@g | 203 KB |
| udpblock-gateway (chromium) | 3/3 | a-g:gateway@g (TURN over TCP) | 63 KB |
| udpblock-gateway (mixed) | 1/1 | a-g:gateway@g | 54 KB |
| udpblock-pair-gateway (chromium) | 3/3 | a-g:gateway@g b-g:gateway@g a-b:relay@g | 186 KB |
| hard-pair-host-node (chromium) | 3/3 | a-b:relay@h (host node, no desktop participant) | 73 KB |
| hard-pair-host-node (mixed) | 1/1 | a-b:relay@h | 62 KB |
| udpblock-pair-host-node (chromium) | 3/3 | a-b:relay@h | 65 KB |
| gate-only (chromium) | 3/3 | a-b, a-c:unreachable (boundary), b-c:direct | 207 KB |

**Total: 40/40 home-lab network test runs passed, 0 failed.** Profiles:
- `eim`: home router;
- `random`: symmetric, random ports;
- `udpblock`: all UDP blocked;
- `upnp`: miniupnpd 2.3.4 with PCP/NAT-PMP/UPnP;
- `public`: no NAT;
- `gateonly`: only TCP to the gate is forwarded;
- `v6`: IPv6 behind a stateful firewall, IPv4 UDP blocked.

"mixed" runs put Firefox and WebKit behind the hard profiles and use Chromium only where a third
party is needed. Gate traffic is the gate's total for the whole run, including retries of pairs
that stay unreachable. It is signalling only.

The 40-run matrix above was re-run in the same home-lab test environment on 2 October 2026 after security hardening: gateways and host nodes now relay only between allocations on themselves, and every gateway and host-node scenario still passed. The same run repeated the coturn conformance check (UDP 800/800 and TCP 800/800, 0 lost).

## Other evidence
- **Unit tests: 173/173 on 7 October 2026.**
  - STUN codec with RFC 5769 vectors and fuzzing;
  - TURN server;
  - port mapper, 30 cases with fake PCP/NAT-PMP/UPnP routers;
  - gate: routing, isolation, floods, tokens, capacity, STUN, keepalive, trust-proxy;
  - gateway: room-scoped and revocable credentials, loopback refused, old-epoch alias allocations revoked;
  - Protocol security regressions (tickets, authority races, key epochs, forwarding, hostile gates and Electron IPC).
- **TURN conformance test with coturn (run as part of the original home-lab test):** coturn's `turnutils_uclient` against Freehop's TURN
  server got UDP 800/800 and TCP 800/800 messages with 0 lost.
  - It runs in Send/Data mode because coturn's client uses obsolete RFC 5766 channel numbers.
  - ChannelData is covered by the browser tests.
- **TURN browser interop (macOS, original test run):** 20 pass, 0 fail, 6 blocked. All six blocked cases are
  WebKit over TCP, caused by a TURN-URL bug in Playwright's WebKit build (bug 320931). The
  client degrades to UDP TURN for that engine.
- **Local browser suites (macOS):** the original test run included all suites below. On 7 October 2026, the three-engine TLS mesh, multi-gate outage, kick/rekey and SDK reference app were rerun for alpha.4; public tracker connectivity was also exercised in live demo checks.
  - 3×Chromium mesh;
  - Chromium + Firefox + WebKit mesh over TLS;
  - multi-gate: peers on disjoint gates introduced through the mesh, then **all gates shut
    down while media continues** (about 600 audio packets per peer in 6 s);
  - kick/rekey;
  - **a public WebTorrent tracker as the only gate** (`wss://tracker.openwebtorrent.com`: no
    server of our own);
  - the SDK example app driven through its own UI and API, including a kick rotation.
- **Earlier review:** the prior source and test review recorded 11 security/correctness findings. The current trust boundaries are described in [PROTOCOL.md](PROTOCOL.md), with regressions in `test/security.test.mjs` and the review test suites.

## Not yet verified
1. **Physical networks:**
   - real home routers;
   - 4G/5G carrier NAT, usually with IPv6;
   - a UDP-blocking corporate network;
   - a router without UPnP/PCP/NAT-PMP.
2. **Application performance under load:** CPU, rendering and responsiveness alongside
   a meeting UI, shared workspace or game.
3. **iOS Safari and Android browsers:** only desktop engines were tested.
4. **Media quality under real load:** forwarded (bridged) media is re-encoded by the
   participant, and the upstream budget of a forwarding participant on home broadband is still
   unmeasured.
5. **Port prediction on real networks:** its success case, a NAT that hands out ports in order,
   cannot be simulated with Linux NAT, so `portPrediction` stays off by default.

## Reproduce
```sh
npm run ship                    # unit tests, release gates and browser suites
node test/browser/tracker.mjs   # a public WebTorrent tracker as the only gate
# NAT lab in a disposable privileged Docker container (see ARCHITECTURE.md §9):
lab/docker.sh qualify           # the 11-scenario matrix three times, cross-engine runs, coturn conformance
lab/docker.sh hard-pair-turn    # one scenario, including the opt-in ones
```

---
Documentation licensed under CC BY 4.0. Copyright 2026 Jolyn Studios. Provided as is, without warranty of any kind.
