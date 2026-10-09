// SPDX-License-Identifier: Apache-2.0
// A ticket is everything a client needs to enter one room: the application backend issues it
// to a member over the application's own authenticated channel. It carries the room secret,
// so it is as sensitive as room membership itself.
//   { v: 1, app, roomId, epoch, gates: [url], secret, auth?, expires, turn? }
import { validStunUrls, validTurnServers } from '../client/ice-urls.mjs';
import { toBase64Url, fromBase64Url } from '../client/crypto.mjs';

const GATE_URL = /^(wss?:\/\/|bt\+wss:\/\/)[^\s]{3,300}$/;

export function validTicket(t) {
  return !!t && typeof t === 'object' && t.v === 1 && typeof t.app === 'string' && t.app.length <= 64 &&
    typeof t.roomId === 'string' && t.roomId.length <= 128 && Number.isSafeInteger(t.epoch) && t.epoch >= 1 &&
    Array.isArray(t.gates) && t.gates.length >= 1 && t.gates.length <= 8 && t.gates.every(g => typeof g === 'string' && GATE_URL.test(g)) &&
    typeof t.secret === 'string' && t.secret.length >= 22 && t.secret.length <= 128 &&
    (t.stun === undefined || validStunUrls(t.stun)) &&
    (t.turn === undefined || validTurnServers(t.turn)) &&
    (t.auth === undefined || typeof t.auth === 'string' && t.auth.length <= 2048 && t.gates.length === 1 && !t.gates[0].startsWith('bt+') ||
      t.auth && typeof t.auth === 'object' && !Array.isArray(t.auth) && Object.keys(t.auth).length <= 8 && Object.entries(t.auth).every(([url, token]) => t.gates.includes(url) && !url.startsWith('bt+') && typeof token === 'string' && token.length <= 2048)) && Number.isSafeInteger(t.expires) && t.expires * 1000 > Date.now();
}

const te = new TextEncoder(), td = new TextDecoder();
const b64 = { enc: s => toBase64Url(te.encode(s)), dec: s => td.decode(fromBase64Url(s)) };

export const encodeTicket = ticket => b64.enc(JSON.stringify(ticket));
export function decodeTicket(text) {
  let t; try { t = JSON.parse(b64.dec(String(text))); } catch { throw new TypeError('Malformed ticket.'); }
  if (!validTicket(t)) throw new TypeError('Invalid ticket.');
  return t;
}
