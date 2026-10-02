// SPDX-License-Identifier: Apache-2.0
// Session authority: the piece an application backend embeds. It owns each room's secret,
// issues tickets to the members the application admits, and rotates the secret when a member
// is removed. It never sees media and never needs to: it only hands out keys.
//
//   const authority = createAuthority({ app: 'my-game', gates: ['wss://example.com/peerlane'], gateTokenSecret });
//   await authority.openRoom('match-42');
//   const ticket = await authority.ticket('match-42', 'player-7');   // deliver over your own channel
//   const { tickets } = await authority.kick('match-42', 'player-3'); // push new tickets to the rest
import { randomBytes } from 'node:crypto';
import { deriveRoom } from '../client/crypto.mjs';
import { mintGateToken } from '../shared/tokens.mjs';
import { validTicket } from './ticket.mjs';

export function createAuthority({ app, gates, gateTokenSecret, ticketTtlSeconds = 6 * 3600, maxRooms = 10000 } = {}) {
  if (typeof app !== 'string' || !app || !Array.isArray(gates) || !gates.length) throw new TypeError('createAuthority needs { app, gates }.');
  const rooms = new Map();   // roomId -> { secret, tag, epoch, members: Set, previousTags: [] }

  async function keyRoom(room) {
    room.secret = randomBytes(32).toString('base64url');
    room.tag = (await deriveRoom(room.secret, app)).tag;
  }
  function issue(roomId, room) {
    const expires = Math.floor(Date.now() / 1000) + ticketTtlSeconds;
    const ticket = { v: 1, app, roomId, epoch: room.epoch, gates: [...gates], secret: room.secret, expires,
      ...(gateTokenSecret ? { auth: mintGateToken(gateTokenSecret, { exp: expires, room: room.tag }) } : {}) };
    if (!validTicket(ticket)) throw new Error('Refusing to issue an invalid ticket (check gate URLs and app name).');
    return ticket;
  }

  return {
    /** Create the room (idempotent). Returns public facts only: never the secret. */
    async openRoom(roomId) {
      let room = rooms.get(roomId);
      if (!room) {
        if (rooms.size >= maxRooms) throw new Error('Too many open rooms.');
        room = { epoch: 1, members: new Set(), previousTags: [] };
        await keyRoom(room);
        rooms.set(roomId, room);
      }
      return { roomId, tag: room.tag, epoch: room.epoch, members: room.members.size };
    },
    /** A ticket for one member. Only call this for members your application has admitted. */
    async ticket(roomId, member) {
      const room = rooms.get(roomId);
      if (!room) throw new Error(`Room ${roomId} is not open.`);
      if (member !== undefined) room.members.add(String(member));
      return issue(roomId, room);
    },
    /** Remove a member: the room gets a new secret; every remaining member needs its new ticket. */
    async kick(roomId, member) {
      const room = rooms.get(roomId);
      if (!room) throw new Error(`Room ${roomId} is not open.`);
      room.members.delete(String(member));
      room.previousTags.push(room.tag);
      room.epoch++;
      await keyRoom(room);
      const tickets = new Map([...room.members].map(m => [m, issue(roomId, room)]));
      return { epoch: room.epoch, previousTags: [...room.previousTags], tickets, hostTicket: issue(roomId, room) };
    },
    /** A member left on its own: no rotation needed (it cannot rejoin without a new ticket). */
    leave(roomId, member) { rooms.get(roomId)?.members.delete(String(member)); },
    closeRoom(roomId) { return rooms.delete(roomId); },
    describe(roomId) { const r = rooms.get(roomId); return r ? { roomId, tag: r.tag, epoch: r.epoch, members: [...r.members] } : null; }
  };
}
