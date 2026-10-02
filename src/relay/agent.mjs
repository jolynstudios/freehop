// SPDX-License-Identifier: Apache-2.0
// Peer gateway: a TURN server that a desktop participant (or any peer with Node) runs on its own
// machine, made reachable through the participant's router via PCP / NAT-PMP / UPnP. It is not a
// third-party relay: it is the participant's own front door. Peers in the same room can reach the
// participant through it even from symmetric NATs or UDP-blocking networks, and the participant may let
// other members of its own session use it when they cannot reach each other.
import { networkInterfaces } from 'node:os';
import { randomBytes, createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { createTurnServer } from './turn-server.mjs';

const v4 = a => a.split('.').map(Number);
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = v4(address);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && b === 168 || a === 192 && b === 0 && c === 0 || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19));
  }
  if (family === 6) {
    const s = address.toLowerCase();
    if (s.startsWith('::ffff:')) return isPublicAddress(s.slice(7));
    return !(s === '::' || s === '::1' || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') ||
      s.startsWith('fc') || s.startsWith('fd') || s.startsWith('ff'));
  }
  return false;
}

function pickLanAddress() {
  return Object.values(networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)?.address ?? null;
}

/**
 * startGateway({ host, port, relayPortRange, portMapping, mapper, externalAddress, rooms, credentialTtlSeconds, limits, log })
 * Resolves with { info(), credentialsFor(), allowRoom(), revokeRoom(), revokePeer(), stats(), close() }.
 * info() returns the gateway description a room client uses (including the minting secret, for
 * the owner's own renderer only), or null when the machine cannot be reached from outside.
 *
 * Credentials are TURN REST style and scoped: username "<expiry>:<room tag 8>:<peer id|self>",
 * password = base64(HMAC-SHA1(secret, username)). Only rooms passed to allowRoom() (or the
 * `rooms` option) are accepted, and individual peers can be revoked (kick, leave).
 */
export async function startGateway(options = {}) {
  const log = options.log ?? (() => {});
  const host = options.host ?? pickLanAddress();
  if (!host) throw new Error('No usable local IPv4 address for the gateway.');
  const port = options.port ?? 3478;
  // A machine with a public address (VPS, community server, IPv4 without NAT) needs no router
  // mapping: its listener and relay ports are reachable as they are.
  const publicHost = isPublicAddress(host);
  let mapper = options.mapper ?? null;
  if (!mapper && !publicHost && options.portMapping !== false) {
    try {
      const { createPortMapper } = await import('./port-mapper.mjs');
      mapper = await createPortMapper({ localAddress: host, ...(typeof options.portMapping === 'object' ? options.portMapping : {}), log });
    } catch (error) { log('port-mapper-unavailable', { message: error.message }); mapper = null; }
  }
  const mappings = [];
  let external = options.externalAddress ?? (publicHost ? host : null);
  const listenerPorts = { udp: port, tcp: port };
  // An operator who forwards ports by hand passes externalAddress with portMapping:false.
  const manual = !!options.externalAddress && options.portMapping === false;
  const mapPort = async (protocol, internalPort) => {
    if (publicHost || manual) return internalPort;
    if (!mapper) return null;
    try {
      const m = await mapper.map({ protocol, internalPort, suggestedExternalPort: internalPort, lifetimeSeconds: 7200, description: 'peerlane gateway' });
      mappings.push(m);
      if (!m.externalAddressIsPrivate && isPublicAddress(m.externalAddress)) external ??= m.externalAddress;
      else log('mapping-not-public', { externalAddress: m.externalAddress });
      return m.externalPort;
    } catch (error) { log('mapping-failed', { protocol, internalPort, message: error.message }); return null; }
  };
  // Map the listener ports first: the router's answer tells us the external address that
  // every relayed transport address must advertise.
  listenerPorts.udp = await mapPort('udp', port);
  listenerPorts.tcp = await mapPort('tcp', port);

  let secret = randomBytes(32).toString('base64url');
  const ttlSeconds = options.credentialTtlSeconds ?? 7200;
  const rooms = new Set((options.rooms ?? []).map(tag => String(tag).slice(0, 8)));
  const revoked = new Set();
  const sign = name => createHmac('sha1', secret).update(name).digest('base64');
  const turn = await createTurnServer({
    listen: [{ transport: 'udp', host, port }, { transport: 'tcp', host, port }],
    relayHost: host,
    relayPortRange: options.relayPortRange ?? [49160, 49359],
    realm: 'peerlane',
    authenticate: async name => {
      const [expiry, room, label, extra] = name.split(':');
      if (extra !== undefined || name.length > 128 || !label || !rooms.has(room) || revoked.has(`${room}:${label}`)) return null;
      if (!Number.isSafeInteger(Number(expiry)) || Number(expiry) * 1000 < Date.now()) return null;
      return sign(name);
    },
    // No custom peer policy: the TURN server's default refuses loopback, link-local and
    // private peers, and lets this machine's own addresses act only as relay<->relay.
    externalAddress: external ?? undefined,
    mapRelayPort: !publicHost && !manual && external && mapper ? async localPort => mapPort('udp', localPort) : undefined,
    limits: { maxAllocationsPerUsername: 6, ...options.limits },
    // Release a relay port's router mapping as soon as its allocation ends.
    log: (event, details) => {
      if (event === 'allocation-deleted' && mapper) {
        const relayedPort = Number(String(details?.relayed ?? '').split(':').pop());
        const index = mappings.findIndex(m => m.protocol === 'udp' && m.externalPort === relayedPort && m.internalPort !== port);
        if (index >= 0) { const [m] = mappings.splice(index, 1); mapper.unmap(m).catch?.(() => {}); }
      }
      log(event, details);
    }
  });
  // Ports actually bound (port 0 = ephemeral, e.g. tests); directly reachable hosts advertise them.
  const bound = { udp: turn.addresses().find(a => a.transport === 'udp')?.port, tcp: turn.addresses().find(a => a.transport === 'tcp')?.port };
  if (publicHost || manual) { listenerPorts.udp = bound.udp; listenerPorts.tcp = bound.tcp; }
  const bracket = a => a.includes(':') ? `[${a}]` : a;
  const matches = (room, label) => name => { const [, r, l] = name.split(':'); return r === room && (label === undefined || l === label); };

  return {
    turn, mapper,
    info() {
      if (!external || !listenerPorts.udp && !listenerPorts.tcp) return null;
      const urls = [];
      if (listenerPorts.udp) urls.push(`turn:${bracket(external)}:${listenerPorts.udp}?transport=udp`);
      if (listenerPorts.tcp) urls.push(`turn:${bracket(external)}:${listenerPorts.tcp}?transport=tcp`);
      return { urls, internalUrls: [`turn:${bracket(host)}:${bound.udp}?transport=udp`, `turn:${bracket(host)}:${bound.tcp}?transport=tcp`],
        secret, ttlSeconds, external: [external], internal: host };
    },
    credentialsFor(roomTag, label) {
      const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:${String(roomTag).slice(0, 8)}:${label}`;
      return { username, credential: sign(username) };
    },
    allowRoom(roomTag) { rooms.add(String(roomTag).slice(0, 8)); },
    revokeRoom(roomTag) { const room = String(roomTag).slice(0, 8); rooms.delete(room); return turn.revoke(matches(room)); },
    revokePeer(roomTag, peer) {
      const room = String(roomTag).slice(0, 8);
      revoked.add(`${room}:${peer}`);
      if (revoked.size > 4096) revoked.delete(revoked.values().next().value);
      return turn.revoke(matches(room, peer));
    },
    rotate() { secret = randomBytes(32).toString('base64url'); return this.info(); },
    stats() { return { external, rooms: rooms.size, mappings: mappings.map(m => ({ method: m.method, protocol: m.protocol, internalPort: m.internalPort, externalPort: m.externalPort })), turn: turn.stats() }; },
    async close() {
      await turn.close();
      if (mapper) await mapper.close();
    }
  };
}
