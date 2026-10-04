# Freehop SDK: integrating it into an application

Freehop is built to be consumed. Any application uses the same five pieces. Redline Wars is
a planned consumer and test environment, using the same public API. Nothing below is
game-specific.

```
 your backend            your gate host            every client               hosts (optional)
 ───────────             ─────────────             ────────────               ────────────────
 createAuthority()  ───► freehop-gate (gate)  ◄── connect(ticket)        hostSession(ticket)
   openRoom / ticket       signalling only          media P2P / via a          desktop app or server
   kick (rotate)           never media              session gateway            that hosts the session
        │                                                ▲
        └──────── tickets over YOUR authenticated channel┘     desktop apps: installFreehopGateway()
```

## 1. Backend: decide who is in a room (`freehop/authority`)
```js
import { createAuthority } from 'freehop/authority';
const authority = createAuthority({
  app: 'my-app',                                   // namespaces room keys
  gates: ['wss://example.com/freehop'],           // one or more gates (yours, community, bt+wss:// trackers)
  gateTokenSecrets: { 'wss://example.com/freehop': process.env.FREEHOP_GATE_TOKEN_SECRET },
  stun: ['stun:example.com:3478']                    // application-approved discovery servers
});
await authority.openRoom(roomId);                  // creates the room secret (never leaves the backend except in tickets)
const ticket = await authority.ticket(roomId, memberId);   // for members your app admitted
const { tickets } = await authority.kick(roomId, memberId); // rotates the secret; deliver new tickets to the rest
```
A ticket (`{ v, app, roomId, epoch, gates, secret, auth?, stun?, expires }`) is a bearer credential for the
room. Deliver it only to that member, over the application's own authenticated channel.
`auth` maps exact gate URLs to audience-bound tokens; community gates without a configured signing key receive no token. `stun` lists approved STUN URLs: clients ignore gate-supplied STUN hints.
`encodeTicket`/`decodeTicket` (`freehop/ticket`) turn it into a compact string.

## 2. Gate: run the signalling service (`bin/freehop-gate.mjs`)
```sh
FREEHOP_GATE_PORT=8787 FREEHOP_GATE_PUBLIC_HOST=example.com FREEHOP_GATE_STUN='0.0.0.0:3478,[::]:3478' \
FREEHOP_GATE_TOKEN_SECRET=… FREEHOP_GATE_TOKEN_AUDIENCE=wss://example.com/freehop FREEHOP_GATE_TRUST_PROXY=1 node bin/freehop-gate.mjs
```
Put it behind your TLS proxy (`deploy/Caddyfile.snippet`, `deploy/freehop-gate.service`). It
carries sealed signalling only: about 15–35 KB per peer pair at setup, roughly zero
afterwards. More gates mean more resilience. Clients use every gate in the ticket, and a call
survives all gates going down. Public trackers can replace your own gate; configure approved STUN separately. Keepalives, tracker discovery and recovery still contribute signalling traffic.

## 3. Client: join with the ticket (`freehop/sdk`)

This runs in the browser or Electron renderer. Bundle the package import with your frontend build tool, fetch the ticket from your authenticated backend, and join from a user control on an HTTPS page (localhost works for development). The callbacks below are UI placeholders; the media, update and leave calls illustrate separate controls, not a startup sequence. Node.js 22 or newer is needed for the backend/gate/host helpers, not for browser execution.

```js
import { connect } from 'freehop';
const session = await connect(ticket, { media: { audio: true, video: false }, adaptiveVideo: true });
session.on('peer', ({ id }) => …);                       // an authenticated member appeared
session.on('track', ({ peer, track }) => session.attach(track, elementFor(peer)));
session.on('path', ({ peer, kind, via }) => …);          // direct | gateway | relay | bridged | unreachable
session.on('peer-left', ({ id, reason }) => …);
await session.setMicrophone(false); await session.setCamera(true);
const levels = await session.levels();                   // speaking indicators
await session.update(newTicket, { dropped: [kickedPeerId] });   // after a kick
await session.switchDevice('audio', deviceId);      // another microphone or camera, no renegotiation
await session.send({ type: 'chat', text: 'hi' });   // app data to everyone (or { to: peerId })
session.on('message', ({ from, data }) => …);      // untrusted input: render as text
session.on('video-quality', ({ peer, direction, level, reason }) => …);
await session.setAdaptiveVideo(false);              // disable at runtime
await session.refresh(reissuedTicket);   // same epoch, fresh gate tokens for long calls
await session.leave();                   // also releases the room on a desktop gateway
```
`session.disconnectPeer(peerId)` removes only a local connection. It does not revoke membership. The former `session.kick()` throws a migration error; use `authority.kick()` and distribute replacement tickets for removal.

`adaptiveVideo` is opt-in and defaults to `false`. When enabled, Freehop uses per-link WebRTC statistics to lower video after sustained packet loss, dropped frames, encoder CPU limitation or a low outgoing bitrate estimate. It never changes audio. It can ask the other endpoint on that link to lower video too; peers that did not opt in ignore the request. Recovery requires 25 seconds of healthy samples and moves one level at a time. Severe sustained pressure can pause video; a minimal-quality probe checks for recovery before restoring it. A manual `setCamera(false)` remains authoritative.

The `video-quality` event reports `{ peer, direction: 'send'|'receive', level: 'normal'|'reduced'|'minimal'|'paused', reason }`. `reason` is `monitoring`, `cpu`, `bandwidth`, `peer-request`, `recovery-probe`, `recovery` or `disabled`. Browser support and stats availability vary; missing measurements leave the current quality unchanged.

Map your member ids to Freehop peer ids (`session.id`) in your backend, so that a kick can
name the peer the remaining clients must drop.

Audio packets arriving does not guarantee sound playback. `attach()` attempts playback, but browsers may block it. Check `element.play()` and offer a button that retries it directly from a click; preserve an existing audio attachment when only video changes. See the [browser playback example](https://jolynstudios.github.io/freehop/docs/sdk/client#audio-playback-in-the-browser).

## 4. Desktop apps: become reachable (`freehop/electron`)
Main process:
```js
import { installFreehopGateway } from 'freehop/electron';
const freehop = installFreehopGateway({ ipcMain, allowedOrigins: ['https://play.example.com'] });
app.on('will-quit', () => freehop.close());
new BrowserWindow({ webPreferences: { preload: require.resolve('freehop/electron/preload'),
  additionalArguments: ['--freehop-origins=https://play.example.com'], contextIsolation: true } });
```
`connect()` finds `window.freehopGateway` automatically. It starts the gateway (TURN plus a
PCP/NAT-PMP/UPnP router mapping) on first use, allows that room, and offers it to the room's
peers with per-peer credentials. Participants behind hard NATs or UDP-blocking networks can then
reach the desktop participant without any third party. The minting key stays in the main process; the renderer requests short-lived credentials through an origin-checked broker. HTTPS origins are required except for loopback development. A raw gateway integration supplies `credentialsFor(tag, peer)` alongside its public `info()` metadata, rather than sending the key to a page.

The gateway relays only between allocations on itself (`relayScope: 'internal'`, the default), so room members cannot use it to reach other internet hosts. A window's rooms are released when its page leaves, navigates away or closes.

## 5. Hosts: let the session's own host relay for it (`freehop/host`)
Whoever hosts a session can make its machine the session's gateway: an app server, a
community server, or a desktop app that hosts. It needs a public address or a router mapping.
```js
import { hostSession } from 'freehop/host';
const host = await hostSession(hostTicket);         // host.available === false when unreachable
await host.update(nextTicket, { dropped: [peerId] });
await host.close();
```
Never call this on infrastructure whose bandwidth you do not want to spend. The operator's own
servers should not host sessions' media.

## Runnable reference
`examples/minimal/` is a complete consumer: backend, gate on the same origin, and a page with
join, mic/camera, per-peer path and level, and kick through the app's API. Run it with
`node examples/minimal/server.mjs` and open it in several windows. `test/browser/example-app.mjs`
drives it with three real browsers and asserts the mesh, the kick rotation and the removal.

---
Documentation licensed under CC BY 4.0. Copyright 2026 Jolyn Studios. Provided as is, without warranty of any kind.
