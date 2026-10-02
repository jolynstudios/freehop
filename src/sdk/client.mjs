// SPDX-License-Identifier: Apache-2.0
// Client SDK: what an application's front end calls. Give it the ticket your backend issued;
// it joins the room, uses the desktop gateway automatically when the app runs inside the
// Freehop Electron helper, and follows ticket rotations (kicks).
//
//   const session = await connect(ticket, { media: { audio: true } });
//   session.on('track', ({ peer, track }) => session.attach(track, elementFor(peer)));
//   session.on('path', ({ peer, kind }) => showRoute(peer, kind));
//   await session.update(nextTicket);     // after a kick, from your backend
//   const levels = await session.levels(); // { peerId: 0..1 } for speaking indicators
import { join } from '../client/room.mjs';
import { deriveRoom } from '../client/crypto.mjs';
import { validTicket, decodeTicket, encodeTicket } from './ticket.mjs';

export { decodeTicket, encodeTicket, validTicket };

export async function connect(ticket, options = {}) {
  if (typeof ticket === 'string') ticket = decodeTicket(ticket);
  if (!validTicket(ticket)) throw new TypeError('Invalid ticket.');
  // Desktop apps expose their gateway through the Freehop preload (window.freehopGateway).
  const desktop = options.desktopGateway === undefined ? globalThis.freehopGateway : options.desktopGateway;
  let gateway = options.gateway;
  if (!gateway && desktop?.info && desktop?.credentialsFor) { try { const info = await desktop.info(); if (info) gateway = {...info, credentialsFor: (tag, peer) => desktop.credentialsFor(tag, peer)}; } catch { gateway = null; } }
  const allow = async secret => { if (gateway && desktop?.allowRoom) await desktop.allowRoom((await deriveRoom(secret, ticket.app)).tag).catch(() => {}); };
  await allow(ticket.secret);

  const room = await join({ ...options, gates: ticket.gates, stun: options.stun ?? ticket.stun, secret: ticket.secret, app: ticket.app, auth: ticket.auth, gateway: gateway ?? undefined });
  let current = ticket;
  let updating = Promise.resolve();
  const trackPeers = new Map();   // remote track id -> origin peer (direct or forwarded)
  room.on('track', ({ peer, track }) => { trackPeers.set(track.id, peer); track.addEventListener('ended', () => trackPeers.delete(track.id)); });
  // Disconnect a peer and revoke its credentials on the desktop gateway (current room tag).
  const remove = async peer => {
    room.drop(peer);
    if (gateway && desktop?.revokePeer) await desktop.revokePeer(room.tag, peer).catch(() => {});
  };

  return Object.assign(room, {
    ticket: () => current,
    /** Apply a newer ticket for the same room (secret rotation after a kick). */
    update(next, { dropped = [] } = {}) {
      const task = updating.then(async () => {
        if (typeof next === 'string') next = decodeTicket(next);
        if (!validTicket(next) || room.closed || next.roomId !== current.roomId || next.app !== current.app || next.epoch <= current.epoch) return false;
        const previousTag = room.tag;
        if ((await deriveRoom(next.secret, next.app)).tag === previousTag) return false;
        await allow(next.secret);
        for (const peer of dropped) await remove(peer);
        // Revoke the whole old epoch, including any unreported identity's credentials.
        if (gateway && desktop?.revokeRoom) await desktop.revokeRoom(previousTag);
        await room.rekey(next.secret, { auth: next.auth });
        trackPeers.clear();
        current = next;
        return true;
      });
      updating = task.catch(() => {});
      return task;
    },
    /** Local disconnection only. Membership removal requires authority.kick() and update() on all remaining members. */
    async disconnectPeer(peer) { await remove(peer); },
    /** Fail closed on the old, misleading name: local removal cannot revoke room membership. */
    async kick() { throw new Error('session.kick() cannot revoke membership. Use authority.kick() and distribute replacement tickets; use disconnectPeer() for local removal.'); },
    /** Attach a remote track to a media element (muted video elements still need play()). */
    attach(track, element) {
      element.srcObject = new MediaStream([track]);
      element.autoplay = true; element.playsInline = true;
      element.play?.().catch(() => {});
      return element;
    },
    /** Current speaking level per origin peer (0..1), from inbound audio statistics. */
    async levels() {
      const out = {};
      for (const link of room.links.values()) {
        let stats; try { stats = await link.pc.getStats(); } catch { continue; }
        for (const s of stats.values()) {
          if (s.type !== 'inbound-rtp' || s.kind !== 'audio') continue;
          const peer = trackPeers.get(s.trackIdentifier) ?? link.id;
          out[peer] = Math.max(out[peer] ?? 0, s.audioLevel ?? 0);
        }
      }
      return out;
    }
  });
}
