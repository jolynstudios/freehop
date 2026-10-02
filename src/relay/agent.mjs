// SPDX-License-Identifier: Apache-2.0
// Peer gateway: a TURN server that a desktop participant (or any peer with Node) runs on its own
// machine, made reachable through the participant's router via PCP / NAT-PMP / UPnP. It is not a
// third-party relay: it is the participant's own front door. Peers in the same room can reach the
// participant through it even from symmetric NATs or UDP-blocking networks, and the participant may let
// other members of its own session use it when they cannot reach each other.
import { networkInterfaces } from 'node:os';
import { randomBytes, createHmac } from 'node:crypto';
import { createTurnServer, classifyPeerAddress } from './turn-server.mjs';

const TAG = /^[A-Za-z0-9_-]{8,64}$/, LABEL = /^[A-Za-z0-9_-]{1,64}$/;
// Peer revocations per room, rooms with a credential floor; relay-port router exchanges at once, started per second, burst.
const ROOM_REVOCATIONS = 256, MAX_FLOORS = 4096, ROUTER_SLOTS = 4, ROUTER_RATE = 8, ROUTER_BURST = 16;

// The TURN destination classification: only globally routable unicast counts as public.
export function isPublicAddress(address) { return classifyPeerAddress(address) === 'public'; }

function pickLanAddress() {
  return Object.values(networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)?.address ?? null;
}

/**
 * startGateway({ host, port, relayPortRange, portMapping, mapper, externalAddress, rooms, credentialTtlSeconds, relayScope, limits, log })
 * Resolves with { info(), credentialsFor(), allowRoom(), revokeRoom(), revokePeer(), rotate(), stats(), close() }.
 * info() returns public gateway metadata, or null when unreachable. Keep credentialsFor()
 * in the privileged process and expose a bounded, authenticated broker to renderers.
 *
 * Credentials are TURN REST style and scoped: username "<expiry>:<room tag 8>:<peer id|self>",
 * password = base64(HMAC-SHA1(secret, username)). Only rooms passed to allowRoom() (or the
 * `rooms` option) are accepted, and individual peers can be revoked (kick, leave). revokeRoom()
 * voids every credential issued for that room so far, also after the tag is allowed again.
 *
 * relayScope 'internal' (default) relays only between allocations on this gateway: a remote peer
 * and the owner's own `self` allocation, or two members. 'public' also lets every member relay
 * UDP to any public host from this machine's address; not recommended when members are untrusted.
 */
export async function startGateway(options = {}) {
  const ttlSeconds = options.credentialTtlSeconds ?? 7200;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86400) throw new TypeError('credentialTtlSeconds must be 1..86400');
  const relayScope = options.relayScope ?? 'internal';
  if (relayScope !== 'internal' && relayScope !== 'public') throw new TypeError("relayScope must be 'internal' or 'public'");
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

  // Relay ports need router mappings only when relaying leaves this machine ('public' scope);
  // internal delivery never touches them. Router exchanges are bounded (ROUTER_SLOTS at once,
  // ROUTER_RATE starts per second); later Allocates wait, within the TURN hook timeout. A mapping
  // lives exactly while an allocation still uses it: the TURN server aborts `signal` when it stops.
  const relayUsers = new Map(), relayMapped = new Map(), routerQueue = []; // internal port -> users / mapping
  let routerBusy = 0, routerTokens = ROUTER_BURST, routerAt = Date.now(), routerTimer = null;
  const dropMapping = m => { const i = mappings.indexOf(m); if (i >= 0) mappings.splice(i, 1); try { mapper.unmap(m)?.catch?.(() => {}); } catch {} };
  const releaseRelay = localPort => {
    const users = (relayUsers.get(localPort) ?? 1) - 1;
    if (users > 0) { relayUsers.set(localPort, users); return; }
    relayUsers.delete(localPort);
    const m = relayMapped.get(localPort);
    if (m) { relayMapped.delete(localPort); dropMapping(m); }
  };
  const pumpRouter = () => {
    const now = Date.now();
    routerTokens = Math.min(ROUTER_BURST, routerTokens + (now - routerAt) * ROUTER_RATE / 1000); routerAt = now;
    while (routerQueue.length && routerBusy < ROUTER_SLOTS && routerTokens >= 1) { routerTokens--; routerBusy++; routerQueue.shift()(); }
    if (routerQueue.length && routerBusy < ROUTER_SLOTS && !routerTimer) {
      routerTimer = setTimeout(() => { routerTimer = null; pumpRouter(); }, Math.ceil((1 - routerTokens) * 1000 / ROUTER_RATE));
      routerTimer.unref?.();
    }
  };
  const routerSlot = signal => new Promise((resolve, reject) => {
    const start = () => { signal.removeEventListener('abort', leave); resolve(); };
    const leave = () => { routerQueue.splice(routerQueue.indexOf(start), 1); reject(new Error('allocation ended')); };
    routerQueue.push(start); signal.addEventListener('abort', leave, { once: true });
    pumpRouter();
  });
  const routerDone = () => { routerBusy--; pumpRouter(); };
  async function mapRelayPort(localPort, family, signal) {
    if (signal.aborted) return null;
    relayUsers.set(localPort, (relayUsers.get(localPort) ?? 0) + 1);
    signal.addEventListener('abort', () => releaseRelay(localPort), { once: true });
    await routerSlot(signal);
    let m;
    try { m = await mapper.map({ protocol: 'udp', internalPort: localPort, suggestedExternalPort: localPort, lifetimeSeconds: 7200, description: 'peerlane gateway' }); }
    catch (error) { log('mapping-failed', { protocol: 'udp', internalPort: localPort, message: error.message }); return null; }
    finally { routerDone(); }
    // The mapper answers one (protocol, port) request for every caller: a newer allocation on this
    // port may share the mapping, so one that ended meanwhile releases it only when nobody waits.
    if (signal.aborted) { if (!relayUsers.has(localPort)) dropMapping(m); return null; }
    if (!relayMapped.has(localPort)) { relayMapped.set(localPort, m); mappings.push(m); }
    return m.externalPort;
  }

  let secret = randomBytes(32).toString('base64url');
  // Allowed room (tag prefix) -> { revoked: label -> ms until every credential issued so far has expired,
  // issued: newest issue second }. Revocation state is per room: a room can only exhaust its own table.
  const rooms = new Map(), floors = new Map(); // floors: room -> { at, until }; credentials issued at or before `at` are void
  const admit = room => rooms.set(room, { revoked: new Map(), issued: 0 });
  for (const tag of options.rooms ?? []) admit(String(tag).slice(0, 8));
  const sign = name => createHmac('sha1', secret).update(name).digest('base64');
  const floorOf = room => floors.get(room)?.at ?? -Infinity;
  // Issue time = expiry - ttl. A revoked room keeps its floor until all older credentials have expired, so
  // re-allowing the tag never revives them; at the table's bound the secret rotates instead of forgetting one.
  function retire(room, state) {
    const now = Date.now(), at = Math.max(Math.floor(now / 1000), state.issued, floorOf(room));
    if (!floors.has(room)) {
      for (const [r, f] of floors) if (f.until <= now) floors.delete(r);
      if (floors.size >= MAX_FLOORS) {
        secret = randomBytes(32).toString('base64url'); floors.clear();
        log('secret-rotated', { reason: 'revocation-capacity' });
        return;
      }
    }
    floors.set(room, { at, until: (at + ttlSeconds + 1) * 1000 });
  }
  const turn = await createTurnServer({
    listen: [{ transport: 'udp', host, port }, { transport: 'tcp', host, port }],
    relayHost: host,
    relayPortRange: options.relayPortRange ?? [49160, 49359],
    realm: 'peerlane',
    authenticate: name => {
      const [expiry, room, label, extra] = name.split(':'), state = rooms.get(room);
      if (extra !== undefined || name.length > 128 || !label || !state) return null;
      const seconds = Number(expiry), now = Date.now(), floor = floorOf(room);
      // One extra second of horizon: credentials minted right after a revocation carry issue time floor + 1.
      if (!Number.isSafeInteger(seconds) || seconds * 1000 <= now || seconds > Math.max(Math.floor(now / 1000), floor) + 1 + ttlSeconds) return null;
      if (seconds - ttlSeconds <= floor || state.revoked.get(label) > now) return null;
      return sign(name);
    },
    // No custom peer policy: loopback, link-local and private peers are refused and this machine's own
    // addresses are relay<->relay only; the 'internal' scope refuses every other destination as well.
    peerScope: relayScope,
    externalAddress: external ?? undefined,
    mapRelayPort: relayScope === 'public' && !publicHost && !manual && external && mapper ? mapRelayPort : undefined,
    allocationScope: username => username.split(':')[1],
    limits: { maxAllocationsPerUsername: 6, maxAllocationsPerScope: 32, scopeBitrate: 20_000_000, ...options.limits },
    log
  });
  // Ports actually bound (port 0 = ephemeral, e.g. tests); directly reachable hosts advertise them.
  const bound = { udp: turn.addresses().find(a => a.transport === 'udp')?.port, tcp: turn.addresses().find(a => a.transport === 'tcp')?.port };
  if (publicHost || manual) { listenerPorts.udp = bound.udp; listenerPorts.tcp = bound.tcp; }
  const bracket = a => a.includes(':') ? `[${a}]` : a;
  const matches = (room, label) => name => { const [, r, l] = name.split(':'); return r === room && (label === undefined || l === label); };
  function info() {
    if (!external || !listenerPorts.udp && !listenerPorts.tcp) return null;
    const urls = [];
    if (listenerPorts.udp) urls.push(`turn:${bracket(external)}:${listenerPorts.udp}?transport=udp`);
    if (listenerPorts.tcp) urls.push(`turn:${bracket(external)}:${listenerPorts.tcp}?transport=tcp`);
    return { urls, internalUrls: [`turn:${bracket(host)}:${bound.udp}?transport=udp`, `turn:${bracket(host)}:${bound.tcp}?transport=tcp`],
      ttlSeconds, external: [external], internal: host };
  }
  function revokeRoom(roomTag) {
    const room = String(roomTag).slice(0, 8), state = rooms.get(room);
    if (state) { retire(room, state); rooms.delete(room); }
    return turn.revoke(matches(room));
  }

  return {
    turn, mapper, info,
    credentialsFor(roomTag, label) {
      if (typeof roomTag !== 'string' || !TAG.test(roomTag) || typeof label !== 'string' || !LABEL.test(label)) return null;
      const room = roomTag.slice(0, 8), state = rooms.get(room), now = Date.now();
      if (!state || state.revoked.get(label) > now) return null;
      const issued = Math.max(Math.floor(now / 1000), floorOf(room) + 1);
      state.issued = Math.max(state.issued, issued);
      const username = `${issued + ttlSeconds}:${room}:${label}`;
      return { username, credential: sign(username) };
    },
    allowRoom(roomTag) {
      if (typeof roomTag !== 'string' || !TAG.test(roomTag)) throw new TypeError('Invalid room tag');
      const room = roomTag.slice(0, 8);
      if (rooms.has(room)) return;
      if (rooms.size >= 64) throw new Error('Gateway room capacity reached');
      admit(room);
    },
    revokeRoom,
    revokePeer(roomTag, peer) {
      const room = String(roomTag).slice(0, 8), state = rooms.get(room), now = Date.now();
      // Only an allowed room has valid credentials (a revoked one is covered by its floor), and only valid labels get any.
      if (state && typeof peer === 'string' && LABEL.test(peer) && !(state.revoked.get(peer) > now)) {
        if (!state.revoked.has(peer) && state.revoked.size >= ROOM_REVOCATIONS) {
          for (const [label, until] of state.revoked) if (until <= now) state.revoked.delete(label);
          // At this room's bound revoke the room itself rather than forget a denial: its floor voids every older credential.
          if (state.revoked.size >= ROOM_REVOCATIONS) { log('room-revocations-full', { room }); return revokeRoom(roomTag); }
        }
        state.revoked.set(peer, (Math.max(Math.floor(now / 1000), state.issued) + ttlSeconds + 1) * 1000);
      }
      return turn.revoke(matches(room, peer));
    },
    rotate() { secret = randomBytes(32).toString('base64url'); floors.clear(); return info(); },
    stats() {
      let revocations = 0;
      for (const state of rooms.values()) revocations += state.revoked.size;
      return { external, relayScope, rooms: rooms.size, revocations, floors: floors.size,
        mappings: mappings.map(m => ({ method: m.method, protocol: m.protocol, internalPort: m.internalPort, externalPort: m.externalPort })), turn: turn.stats() };
    },
    async close() {
      try { await turn.close(); } finally { clearTimeout(routerTimer); if (mapper) await mapper.close(); }
    }
  };
}
