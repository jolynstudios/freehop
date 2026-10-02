// SPDX-License-Identifier: Apache-2.0
// Gateway member: the session's own host node (a player's desktop app or a community server
// that hosts the match) joins the room through the same gates, never sends media and offers
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
export async function joinAsGateway({ gates, secret, app = 'peerlane', gateway, auth, WebSocketImpl = globalThis.WebSocket, log = () => {} }) {
  if (!gateway?.info?.() || typeof gateway.credentialsFor !== 'function') throw new TypeError('A reachable gateway from startGateway() is required.');
  // Host nodes join through WebSocket gates; tracker gates (bt+wss://) are used by clients only.
  const usable = gates.filter(url => !url.startsWith('bt+'));
  if (!usable.length) throw new TypeError('A host node needs at least one WebSocket gate (ws:// or wss://) in its ticket.');
  if (typeof WebSocketImpl !== 'function') throw new TypeError('No WebSocket implementation: use Node.js 22 or newer, or pass WebSocketImpl.');
  const id = GATEWAY_ID_PREFIX + randomId(16).slice(0, 19);
  const stats = { peersServed: 0, envelopesSent: 0, envelopesReceived: 0, revoked: 0 };
  let room, clients = [], n = 0, closed = false, currentAuth = auth;
  const presence = new Map();    // peer -> Set(gate)
  const greeted = new Map();     // peer -> expiry of the credentials we sent
  const sequences = new Map();   // peer -> highest envelope counter seen (replay guard)
  const tags = new Set();        // every room tag this member served (kept until close)

  const capsFor = peer => {
    const info = gateway.info(), creds = gateway.credentialsFor(room.tag, peer);
    return { v: 1, role: 'gateway', forward: false, peers: [],
      gateway: { urls: info.urls, username: creds.username, credential: creds.credential, external: info.external, internal: info.internal } };
  };
  async function greet(peer) {
    if (closed || peer === id || !PEER_ID.test(peer) || peer.startsWith(GATEWAY_ID_PREFIX)) return;
    const caps = capsFor(peer), box = await seal(room, id, peer, { kind: 'caps', caps, n: ++n });
    let sent = false;
    for (const gate of presence.get(peer) ?? []) sent = gate.send(peer, box) || sent;
    if (sent) { if (!greeted.has(peer)) stats.peersServed++; greeted.set(peer, Number(caps.gateway.username.split(':')[0])); stats.envelopesSent++; }
  }
  function openGates() {
    clients = usable.map(url => {
      const gate = new GateClient(url, { room: room.tag, peer: id, auth: currentAuth, WebSocketImpl });
      const seen = peer => {
        if (!presence.has(peer) && presence.size >= 64) return false;
        const set = presence.get(peer) ?? new Set(); set.add(gate); presence.set(peer, set); return true;
      };
      gate.on('joined', ({ peers }) => { for (const p of peers) seen(p); });
      gate.on('peer', ({ peer, on }) => {
        if (on) { seen(peer); return; }
        presence.get(peer)?.delete(gate);
        if (!presence.get(peer)?.size) presence.delete(peer);
      });
      gate.on('recv', async ({ from, box }) => {
        const p = await open(room, from, id, box);
        if (!p || !Number.isSafeInteger(p.n) || p.n <= (sequences.get(from) ?? 0)) return;
        sequences.set(from, p.n); seen(from);
        stats.envelopesReceived++;
        if (p.kind === 'bye') { drop(from); return; }
        // Credentials only for peers that proved room membership with a sealed envelope.
        if (p.kind === 'caps' && !greeted.has(from)) greet(from);
      });
      gate.connect();
      return gate;
    });
  }
  function drop(peer) {
    for (const tag of tags) stats.revoked += gateway.revokePeer(tag, peer) ?? 0;
    greeted.delete(peer); presence.delete(peer);
  }
  async function enter(newSecret) {
    room = await deriveRoom(newSecret, app);
    tags.add(room.tag); gateway.allowRoom(room.tag);
    openGates();
  }
  await enter(secret);
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
    // Kick: move to the new room (credentials for its tag) and revoke the removed peers. The
    // previous tag stays allowed for remaining members' existing allocations until close().
    async rekey(newSecret, { auth: nextAuth, dropped = [] } = {}) {
      if (closed) return;
      for (const peer of dropped) drop(peer);
      if (nextAuth !== undefined) currentAuth = nextAuth;
      for (const gate of clients) gate.close();
      presence.clear(); greeted.clear();
      await enter(newSecret);
    },
    async close() {
      closed = true; clearInterval(renew);
      for (const peer of greeted.keys()) {
        const box = await seal(room, id, peer, { kind: 'bye', n: ++n });
        for (const gate of presence.get(peer) ?? []) gate.send(peer, box);
      }
      for (const gate of clients) gate.close();
      for (const tag of tags) gateway.revokeRoom(tag);
    }
  };
}
