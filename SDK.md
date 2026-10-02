# Freehop SDK: integrating it into an application

Freehop is built to be consumed. Any application uses the same five pieces. Redline Wars is
its first consumer and test environment, and integrates exactly this way. Nothing below is
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
  gateTokenSecret: process.env.FREEHOP_GATE_TOKEN_SECRET  // same secret as your gate (optional)
});
await authority.openRoom(roomId);                  // creates the room secret (never leaves the backend except in tickets)
const ticket = await authority.ticket(roomId, memberId);   // for members your app admitted
const { tickets } = await authority.kick(roomId, memberId); // rotates the secret; deliver new tickets to the rest
```
A ticket (`{ v, app, roomId, epoch, gates, secret, auth?, expires }`) is a bearer credential for the
room. Deliver it only to that member, over the application's own authenticated channel.
`encodeTicket`/`decodeTicket` (`freehop/ticket`) turn it into a compact string.

## 2. Gate: run the signalling service (`bin/freehop-gate.mjs`)
```sh
FREEHOP_GATE_PORT=8787 FREEHOP_GATE_PUBLIC_HOST=example.com FREEHOP_GATE_STUN=0.0.0.0:3478,[::]:3478 \
FREEHOP_GATE_TOKEN_SECRET=… FREEHOP_GATE_TRUST_PROXY=1 node bin/freehop-gate.mjs
```
Put it behind your TLS proxy (`deploy/Caddyfile.snippet`, `deploy/freehop-gate.service`). It
carries sealed signalling only: about 15–35 KB per peer pair at setup, roughly zero
afterwards. More gates mean more resilience. Clients use every gate in the ticket, and a call
survives all gates going down.

## 3. Client: join with the ticket (`freehop/sdk`)
```js
import { connect } from 'freehop';
const session = await connect(ticket, { media: { audio: true, video: false } });
session.on('peer', ({ id }) => …);                       // an authenticated member appeared
session.on('track', ({ peer, track }) => session.attach(track, elementFor(peer)));
session.on('path', ({ peer, kind, via }) => …);          // direct | gateway | relay | bridged | unreachable
session.on('peer-left', ({ id, reason }) => …);
await session.setMicrophone(false); await session.setCamera(true);
const levels = await session.levels();                   // speaking indicators
await session.update(newTicket, { dropped: [kickedPeerId] });   // after a kick
await session.leave();
```
Map your member ids to Freehop peer ids (`session.id`) in your backend, so that a kick can
name the peer the remaining clients must drop.

## 4. Desktop apps: become reachable (`freehop/electron`)
Main process:
```js
import { installFreehopGateway } from 'freehop/electron';
const freehop = installFreehopGateway({ ipcMain });
app.on('will-quit', () => freehop.close());
new BrowserWindow({ webPreferences: { preload: require.resolve('freehop/electron/preload'),
  additionalArguments: ['--freehop-origins=https://example.com'], contextIsolation: true } });
```
`connect()` finds `window.freehopGateway` automatically. It starts the gateway (TURN plus a
PCP/NAT-PMP/UPnP router mapping) on first use, allows that room, and offers it to the room's
peers with per-peer credentials. Players behind hard NATs or UDP-blocking networks can then
reach the desktop player without any third party.

## 5. Hosts: let the session's own host relay for it (`freehop/host`)
Whoever hosts a session can make its machine the session's gateway: a match server, a
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
