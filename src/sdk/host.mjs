// SPDX-License-Identifier: Apache-2.0
// Host SDK: for the party that hosts a session (a player's desktop app or a server that runs
// the match). One call makes this machine the session's gateway member: it starts (or reuses)
// the process-wide gateway, joins the room without media and follows ticket rotations.
//
//   const host = await hostSession(ticket);          // host.available === false when unreachable
//   await host.update(nextTicket, { dropped: ['peerId'] });
//   await host.close();
import { startGateway } from '../relay/agent.mjs';
import { joinAsGateway } from '../relay/member.mjs';
import { validTicket, decodeTicket } from './ticket.mjs';

let shared = null;
/** One gateway per process, shared by every hosted room. */
export function sharedGateway(options = {}) {
  shared ??= startGateway(options).catch(error => { shared = null; throw error; });
  return shared;
}

export async function closeSharedGateway() {
  const gateway = shared && await shared.catch(() => null);
  shared = null;
  await gateway?.close();
}

export async function hostSession(ticket, { gateway = 'auto', gatewayOptions, log = () => {} } = {}) {
  if (typeof ticket === 'string') ticket = decodeTicket(ticket);
  if (!validTicket(ticket)) throw new TypeError('Invalid ticket.');
  let gw = null;
  try { gw = gateway === 'auto' ? await sharedGateway(gatewayOptions) : gateway || null; } catch (error) { log('gateway-unavailable', { message: error.message }); }
  if (!gw?.info()) {
    // Not reachable from outside (no public address, no router mapping): nothing to offer.
    return { available: false, async update() {}, async close() {}, stats: () => ({ available: false }) };
  }
  let epoch = ticket.epoch;
  const member = await joinAsGateway({ gates: ticket.gates, secret: ticket.secret, app: ticket.app, auth: ticket.auth, gateway: gw, log });
  return {
    available: true, id: member.id, gateway: gw,
    async update(next, { dropped = [] } = {}) {
      if (typeof next === 'string') next = decodeTicket(next);
      if (!validTicket(next) || next.epoch <= epoch) return;
      epoch = next.epoch;
      await member.rekey(next.secret, { auth: next.auth, dropped });
    },
    drop: peer => member.drop(peer),
    stats: () => ({ available: true, epoch, member: member.stats(), gateway: gw.stats() }),
    close: () => member.close()
  };
}
