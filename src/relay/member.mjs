// SPDX-License-Identifier: Apache-2.0
// Gateway member: the session's own host node (a participant's desktop app or a community server
// that hosts the session) joins the room through the same gates, never sends media and offers
// its gateway to the session's peers, each with its own short-lived, room-scoped TURN
// credentials. The relay cost therefore stays inside the session that uses it.
import { deriveRoom, seal, open, randomId } from '../client/crypto.mjs';
import { GateClient } from '../client/gate-client.mjs';

export const GATEWAY_ID_PREFIX = 'gw_';
const PEER_ID = /^[A-Za-z0-9_-]{22}$/;

/**
 * joinAsGateway({ gates, secret, app, gateway, auth })
 * `gateway` is the object returned by startGateway(). Returns { id, stats(), drop(peer), rekey(secret, {auth}), close() }.
 */
export async function joinAsGateway({ gates, secret, app = 'peerlane', gateway, auth, WebSocketImpl = globalThis.WebSocket, departGraceMs = 8000, log = () => {} }) {
  if (!gateway?.info?.() || typeof gateway.credentialsFor !== 'function') throw new TypeError('A reachable gateway from startGateway() is required.');
  // Host nodes join through WebSocket gates; tracker gates (bt+wss://) are used by clients only.
  const socketGates = list => list.filter(url => !url.startsWith('bt+'));
  let usable = socketGates(gates);
  if (!usable.length) throw new TypeError('A host node needs at least one WebSocket gate (ws:// or wss://) in its ticket.');
  if (typeof WebSocketImpl !== 'function') throw new TypeError('No WebSocket implementation: use Node.js 22 or newer, or pass WebSocketImpl.');
  const id = GATEWAY_ID_PREFIX + randomId(16).slice(0, 19);
  const stats = { peersServed: 0, envelopesSent: 0, envelopesReceived: 0, revoked: 0 };
  let room, clients = [], n = 0, closed = false, currentAuth = auth;
  const presence = new Map();    // peer -> Set(gate)
  const lastContact = new Map();
  const greeted = new Map();     // peer -> expiry of the credentials we sent
  const sequences = new Map();   // peer -> highest envelope counter seen (replay guard)
  const tags = new Set();        // every room tag this member served (kept until close)
  const issued = new Set();      // peers that received credentials in this epoch: the only revocation targets
  let rekeyTask = Promise.resolve();

  const capsFor = peer => {
    const info = gateway.info(), creds = gateway.credentialsFor(room.tag, peer);
    if (!info || !creds) return null;
    return { v: 1, role: 'gateway', forward: false, peers: [],
      gateway: { urls: info.urls, username: creds.username, credential: creds.credential, external: info.external, internal: info.internal } };
  };
  async function greet(peer) {
    if (closed || peer === id || !PEER_ID.test(peer) || peer.startsWith(GATEWAY_ID_PREFIX)) return;
    const epoch = room;
    const caps = capsFor(peer); if (!caps) return;
    const box = await seal(epoch, id, peer, { kind: 'caps', caps, n: ++n });
    if (closed || epoch !== room) return;
    let sent = false;
    for (const gate of presence.get(peer) ?? []) sent = gate.send(peer, box) || sent;
    if (sent) {
      if (!greeted.has(peer)) stats.peersServed++;
      greeted.set(peer, Number(caps.gateway.username.split(':')[0])); stats.envelopesSent++;
      issued.add(peer); if (issued.size > 1024) issued.delete(issued.values().next().value);
    }
  }
  function openGates() {
    clients = usable.map(url => {
      // Auth is read at every (re)connect, so refreshed tokens apply without a rotation.
      const gate = new GateClient(url, { room: room.tag, peer: id, auth: gateUrl => currentAuth && typeof currentAuth === 'object' ? currentAuth[gateUrl] : currentAuth, WebSocketImpl });
      const seen = peer => {
        if (!presence.has(peer) && presence.size >= 64) return false;
        const set = presence.get(peer) ?? new Set(); set.add(gate); presence.set(peer, set); return true;
      };
      // Roster entries consume no state for strangers: clients must first prove membership. A
      // peer that already authenticated in this epoch is restored after our own gate reconnects,
      // and greeted again if the sweep forgot it, so credential renewal continues.
      const restore = peer => {
        if (closed || typeof peer !== 'string' || !sequences.has(peer) || !seen(peer)) return;
        lastContact.set(peer, Date.now());
        if (!greeted.has(peer)) greet(peer);
      };
      gate.on('joined', ({ peers } = {}) => { if (Array.isArray(peers)) for (const peer of peers.slice(0, 256)) restore(peer); });
      gate.on('left', () => { for (const [peer, sources] of presence) { sources.delete(gate); if (!sources.size) lastContact.set(peer, Date.now()); } });
      gate.on('peer', ({ peer, on }) => {
        if (on) { restore(peer); return; }
        presence.get(peer)?.delete(gate);
        if (presence.has(peer) && !presence.get(peer).size) lastContact.set(peer, Date.now());
      });
      gate.on('recv', async ({ from, box }) => {
        if (closed || !PEER_ID.test(from) || from.startsWith(GATEWAY_ID_PREFIX)) return;
        const epoch = room;
        const p = await open(epoch, from, id, box);
        if (closed || epoch !== room || !p || !Number.isSafeInteger(p.n) || p.n < 1 || p.n <= (sequences.get(from) ?? 0)) return;
        if (!seen(from)) return;
        lastContact.set(from, Date.now());
        sequences.delete(from); sequences.set(from, p.n);
        // Keep recent departure replay guards without consuming active membership slots.
        if (sequences.size > 256) { const stale = [...sequences.keys()].find(peer => !presence.has(peer)); if (stale) sequences.delete(stale); }
        stats.envelopesReceived++;
        if (p.kind === 'bye') { drop(from); return; }
        // Credentials only for peers that proved room membership with a sealed envelope.
        if (p.kind === 'caps' && !greeted.has(from)) greet(from);
      });
      gate.connect();
      return gate;
    });
  }
  // Only peers we issued credentials to are revoked: a member cannot fill the gateway's
  // revocation table with made-up ids (a departure of an unknown id has nothing to revoke).
  function drop(peer) {
    if (issued.delete(peer)) for (const tag of tags) stats.revoked += gateway.revokePeer(tag, peer) ?? 0;
    greeted.delete(peer); presence.delete(peer); lastContact.delete(peer);
  }
  async function enter(newSecret) {
    const next = await deriveRoom(newSecret, app);
    if (closed) return;
    room = next;
    tags.add(room.tag); gateway.allowRoom(room.tag);
    openGates();
  }
  await enter(secret);
  const sweep = () => {
    for (const [peer, sources] of presence) if (!sources.size && Date.now() - (lastContact.get(peer) ?? 0) >= departGraceMs) {
      // A mailbox outage is not authenticated revocation: existing TURN media must survive.
      presence.delete(peer); greeted.delete(peer); lastContact.delete(peer);
    }
  };
  const sweeper = setInterval(sweep, Math.max(10, Math.min(departGraceMs, 1000))); sweeper.unref?.();
  // Renew credentials well before they expire.
  const ttl = gateway.info()?.ttlSeconds ?? 7200;
  const renew = setInterval(() => {
    const soon = Math.floor(Date.now() / 1000) + ttl / 2;
    for (const [peer, expiry] of greeted) if (expiry < soon) greet(peer);
  }, Math.min(ttl * 250, 60000));
  renew.unref?.();
  return {
    id,
    stats: () => ({ ...stats, peers: presence.size }),
    drop,
    // Every old-epoch allocation is revoked, including aliases the backend never learned. The new
    // room is admitted first: if the gateway refuses it, the old room keeps working and a retry of
    // the same rotation runs again (state only advances after success).
    rekey(newSecret, { auth: nextAuth, dropped = [], gates: nextGates } = {}) {
      const task = rekeyTask.then(async () => {
        if (closed) return;
        const next = await deriveRoom(newSecret, app);
        if (closed || next.tag === room.tag) return;
        const nextUsable = nextGates === undefined ? usable : Array.isArray(nextGates) ? socketGates(nextGates) : [];
        if (!nextUsable.length) throw new TypeError('A host node needs at least one WebSocket gate (ws:// or wss://) in its ticket.');
        try { gateway.allowRoom(next.tag); }
        catch (error) {
          // At room capacity the old epoch's slots are what the new room needs: retire them first.
          // Any other refusal leaves the old room untouched, so the rotation can simply be retried.
          if (!/capacity/i.test(String(error?.message))) throw error;
          for (const tag of tags) gateway.revokeRoom(tag);
          gateway.allowRoom(next.tag);
        }
        for (const peer of dropped) drop(peer);
        currentAuth = nextAuth; usable = nextUsable;
        for (const gate of clients) gate.close();
        for (const tag of tags) if (tag !== next.tag) gateway.revokeRoom(tag);
        tags.clear(); presence.clear(); lastContact.clear(); greeted.clear(); sequences.clear(); issued.clear();
        room = next; tags.add(room.tag);
        openGates();
      });
      rekeyTask = task.catch(() => {});
      return task;
    },
    /** Use refreshed gate tokens for the same epoch at the next (re)connect. */
    setAuth(nextAuth) { if (!closed) currentAuth = nextAuth; },
    async close() {
      closed = true; clearInterval(renew); clearInterval(sweeper);
      for (const peer of greeted.keys()) {
        const box = await seal(room, id, peer, { kind: 'bye', n: ++n });
        for (const gate of presence.get(peer) ?? []) gate.send(peer, box);
      }
      for (const gate of clients) gate.close();
      for (const tag of tags) gateway.revokeRoom(tag);
    }
  };
}
