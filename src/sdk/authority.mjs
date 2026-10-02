// SPDX-License-Identifier: Apache-2.0
// Session authority: the piece an application backend embeds. It owns each room's secret,
// issues tickets to the members the application admits, and rotates the secret when a member
// is removed. It never sees media and never needs to: it only hands out keys.
//
//   const authority = createAuthority({ app: 'my-game', gates: ['wss://example.com/peerlane'], gateTokenSecret });
//   await authority.openRoom('room-42');
//   const ticket = await authority.ticket('room-42', 'user-7');   // deliver over your own channel
//   const { tickets } = await authority.kick('room-42', 'user-3'); // push new tickets to the rest
import { randomBytes } from 'node:crypto';
import { deriveRoom } from '../client/crypto.mjs';
import { mintGateToken } from '../shared/tokens.mjs';
import { validTicket } from './ticket.mjs';

export function createAuthority({ app, gates, gateTokenSecret, gateTokenSecrets = {}, stun = [], ticketTtlSeconds = 6 * 3600, maxRooms = 10000 } = {}) {
  if (!app || !validTicket({ v: 1, app, gates, stun, roomId: '', epoch: 1, secret: 'x'.repeat(22), expires: Math.floor(Date.now() / 1000) + 60 }) ||
      !Number.isSafeInteger(ticketTtlSeconds) || ticketTtlSeconds < 1 || !Number.isSafeInteger(maxRooms) || maxRooms < 1)
    throw new TypeError('createAuthority needs valid { app, gates, ticketTtlSeconds, maxRooms }.');
  gates = [...gates]; stun = [...stun];
  if (!gateTokenSecrets || typeof gateTokenSecrets !== 'object' || Array.isArray(gateTokenSecrets) || Object.keys(gateTokenSecrets).some(url => !gates.includes(url) || url.startsWith('bt+'))) throw new TypeError('gateTokenSecrets must map configured WebSocket gates to secrets');
  const gateKeys = gates.filter(url => !url.startsWith('bt+')).map(url => [url, gateTokenSecrets[url] ?? gateTokenSecret]).filter(([, key]) => key !== undefined);
  if (gateKeys.some(([, key]) => typeof key !== 'string' || !key.length)) throw new TypeError('Gate token secrets must be nonempty strings');
  const rooms = new Map();   // roomId -> { secret, tag, epoch, members: Set, previousTags: [] }
  const pending = new Map();
  // Mutations and ticket issuance for one room must observe one complete epoch at a time.
  function transaction(roomId, action) {
    const task = (pending.get(roomId) ?? Promise.resolve()).then(action);
    const settled = task.catch(() => {}).finally(() => { if (pending.get(roomId) === settled) pending.delete(roomId); });
    pending.set(roomId, settled);
    return task;
  }

  async function keyRoom() {
    const secret = randomBytes(32).toString('base64url');
    return { secret, tag: (await deriveRoom(secret, app)).tag };
  }
  function issue(roomId, room) {
    const expires = Math.floor(Date.now() / 1000) + ticketTtlSeconds;
    const ticket = { v: 1, app, roomId, epoch: room.epoch, gates: [...gates], stun: [...stun], secret: room.secret, expires,
      ...(gateKeys.length ? { auth: Object.fromEntries(gateKeys.map(([url, key]) => [url, mintGateToken(key, { exp: expires, room: room.tag, aud: url })])) } : {}) };
    if (!validTicket(ticket)) throw new Error('Refusing to issue an invalid ticket (check gate URLs and app name).');
    return ticket;
  }

  const authority = {
    /** Create the room (idempotent). Returns public facts only: never the secret. */
    openRoom(roomId) { return transaction(roomId, async () => {
      if (typeof roomId !== 'string' || roomId.length > 128) throw new TypeError('Invalid room id.');
      let room = rooms.get(roomId);
      if (!room) {
        if (rooms.size >= maxRooms) throw new Error('Too many open rooms.');
        room = { epoch: 1, members: new Set(), previousTags: [] };
        // Reserve capacity before deriving the key; different rooms can open concurrently.
        rooms.set(roomId, room);
        try { Object.assign(room, await keyRoom()); }
        catch (error) { if (rooms.get(roomId) === room) rooms.delete(roomId); throw error; }
      }
      return { roomId, tag: room.tag, epoch: room.epoch, members: room.members.size };
    }); },
    /** A ticket for one member. Only call this for members your application has admitted. */
    ticket(roomId, member) { return transaction(roomId, () => {
      const room = rooms.get(roomId);
      if (!room) throw new Error(`Room ${roomId} is not open.`);
      if (member !== undefined) room.members.add(String(member));
      return issue(roomId, room);
    }); },
    /** Remove a member: the room gets a new secret; every remaining member needs its new ticket. */
    kick(roomId, member) { return transaction(roomId, async () => {
      const room = rooms.get(roomId);
      if (!room) throw new Error(`Room ${roomId} is not open.`);
      const next = { ...room, ...await keyRoom(), epoch: room.epoch + 1, members: new Set(room.members),
        previousTags: [...room.previousTags, room.tag].slice(-32) };
      next.members.delete(String(member));
      const tickets = new Map([...next.members].map(m => [m, issue(roomId, next)]));
      const hostTicket = issue(roomId, next);
      rooms.set(roomId, next);
      return { epoch: next.epoch, previousTags: [...next.previousTags], tickets, hostTicket };
    }); },
    /** A voluntary departure also rotates the key. Deliver the returned tickets to remaining members. */
    leave(roomId, member) { return authority.kick(roomId, member); },
    closeRoom(roomId) { return transaction(roomId, () => rooms.delete(roomId)); },
    describe(roomId) { const r = rooms.get(roomId); return r?.tag ? { roomId, tag: r.tag, epoch: r.epoch, members: [...r.members] } : null; }
  };
  return authority;
}
