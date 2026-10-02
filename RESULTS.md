# Freehop results, 2 October 2026

**Outcome:** browser and desktop audio/video now connects peer-to-peer in every lab network
where *any* route exists inside the session. That includes the cases the earlier direct-only
research proved impossible directly: two fully random symmetric NATs, and UDP-blocking
networks. The operator runs only gates, which carry sealed signalling of tens of KB per call and
never media. When no direct route exists, media goes through machines that belong to the
session: a desktop player's own gateway, the match's host node, or a participant. The only
unsolved network is one that can reach nothing but the gate. There, media is impossible without
the operator carrying it, and Freehop reports `unreachable`.

## Final lab qualification (fixed code, one clean run)

Real Chromium 151, Firefox 153 and WebKit 26.5 ran in separate Linux network namespaces, each
behind its own kernel-NAT router profile, with fake camera and microphone. Every run asserts:
- the path each side reports;
- audio packets (more than 50) and decoded video frames (more than 30) per origin peer;
- that gate traffic stays signalling-sized.

| Scenario (browsers) | Passed | Paths per pair | Gate traffic per run |
|---|---|---|---|
| direct-eim (chromium) | 3/3 | a-b:direct | 31 KB |
| direct-eim (mixed) | 1/1 | a-b:direct | 34 KB |
| ipv6-direct (chromium) | 3/3 | a-b:direct (IPv6, IPv4 UDP blocked) | 34 KB |
| ipv6-direct (mixed) | 1/1 | a-b:direct | 30 KB |
| hard-pair (chromium) | 3/3 | a-b:unreachable (two random NATs, nobody else: expected) | 93 KB |
| hard-pair-bridge (chromium) | 3/3 | a-c:direct b-c:direct a-b:bridged@c | 91 KB |
| hard-pair-bridge (mixed) | 1/1 | a-c:direct b-c:direct a-b:bridged@c | 115 KB |
| two-player-desktop-host (chromium) | 3/3 | a-g:gateway@g | 37–66 KB |
| two-player-desktop-host (mixed) | 1/1 | a-g:gateway@g | 34 KB |
| hard-pair-gateway (chromium) | 3/3 | a-g:gateway@g b-g:gateway@g a-b:relay@g | 143–201 KB |
| hard-pair-gateway (mixed) | 1/1 | a-g:gateway@g b-g:gateway@g a-b:relay@g | 146 KB |
| udpblock-gateway (chromium) | 3/3 | a-g:gateway@g (TURN over TCP) | 34–63 KB |
| udpblock-gateway (mixed) | 1/1 | a-g:gateway@g | 31 KB |
| udpblock-pair-gateway (chromium) | 3/3 | a-g:gateway@g b-g:gateway@g a-b:relay@g | 130–158 KB |
| hard-pair-host-node (chromium) | 3/3 | a-b:relay@h (host node, no desktop player) | 73 KB |
| hard-pair-host-node (mixed) | 1/1 | a-b:relay@h | 62 KB |
| udpblock-pair-host-node (chromium) | 3/3 | a-b:relay@h | 65 KB |
| gate-only (chromium) | 3/3 | a-b, a-c:unreachable (boundary), b-c:direct | 207 KB |

**Total: 40/40 runs passed, 0 failed.** Profiles:
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

## Other evidence
- **Unit tests: 79/79.**
  - STUN codec with RFC 5769 vectors and fuzzing;
  - TURN server, 29 cases;
  - port mapper, 30 cases with fake PCP/NAT-PMP/UPnP routers;
  - gate: routing, isolation, floods, tokens, capacity, STUN, keepalive, trust-proxy;
  - gateway: room-scoped and revocable credentials, loopback refused.
- **Independent TURN conformance:** coturn's `turnutils_uclient` against Freehop's TURN
  server got UDP 800/800 and TCP 800/800 messages with 0 lost.
  - It runs in Send/Data mode because coturn's client uses obsolete RFC 5766 channel numbers.
  - ChannelData is covered by the browser tests.
- **TURN browser interop (macOS):** 20 pass, 0 fail, 6 blocked. All six blocked cases are
  WebKit over TCP, caused by a TURN-URL bug in Playwright's WebKit build (bug 320931). The
  client degrades to UDP TURN for that engine.
- **Local browser suites (macOS), all passing on the final code:**
  - 3×Chromium mesh;
  - Chromium + Firefox + WebKit mesh over TLS;
  - multi-gate: peers on disjoint gates introduced through the mesh, then **all gates shut
    down while media continues** (about 600 audio packets per peer in 6 s);
  - kick/rekey;
  - **a public WebTorrent tracker as the only gate** (`wss://tracker.openwebtorrent.com`: no
    server of our own);
  - the SDK example app driven through its own UI and API, including a kick rotation.
- **Independent security/correctness review:** 11 findings, 3 high, all fixed and re-tested.
  Examples: gates could inject peers, the gateway exposed loopback services, a lost offer
  could deadlock a pair.

## Not yet verified (next phases)
1. **Physical networks:**
   - real home routers;
   - 4G/5G carrier NAT, usually with IPv6;
   - a UDP-blocking corporate network;
   - a router without UPnP/PCP/NAT-PMP.
2. **Redline Wars integration through the SDK** (redlinewars.online), with the game as test
   environment, including the strict frame-time gates with voice on.
3. **iOS Safari and Android browsers:** only desktop engines were tested.
4. **Media quality under real load:** forwarded (bridged) media is re-encoded by the
   participant, and the upstream budget of a forwarding player on home broadband is still
   unmeasured.

## Reproduce
```sh
node --test test/*.test.mjs
node test/browser/smoke.mjs chromium,firefox,webkit --tls
node test/browser/multigate.mjs && node test/browser/rekey.mjs && node test/browser/tracker.mjs && node test/browser/example-app.mjs
# in a disposable privileged Linux container (see ARCHITECTURE.md §9):
FREEHOP_DISPOSABLE_LAB=yes lab/qualify.sh
```

---
Documentation licensed under CC BY 4.0. Copyright 2026 Jolyn Studios. Provided as is, without warranty of any kind.
