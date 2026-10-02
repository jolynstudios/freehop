// SPDX-License-Identifier: Apache-2.0
// Gateway agent: room-scoped, revocable TURN credentials and the default peer policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { startGateway } from '../src/relay/agent.mjs';
import * as stun from '../src/shared/stun.mjs';

// Minimal long-term-credential TURN client over UDP.
async function turnClient(port, host = '127.0.0.1') {
  const socket = dgram.createSocket('udp4');
  await new Promise(r => socket.bind(0, '127.0.0.1', r));
  const waiters = new Map();
  socket.on('message', buf => { const m = stun.decode(buf); const w = m && waiters.get(m.transactionId.toString('hex')); if (w) { waiters.delete(m.transactionId.toString('hex')); w(m); } });
  const request = (method, attributes, key) => new Promise((resolve, reject) => {
    const transactionId = randomBytes(12);
    waiters.set(transactionId.toString('hex'), resolve);
    socket.send(stun.encode({ method, cls: stun.CLASS.REQUEST, transactionId, attributes }, key ? { integrityKey: key } : {}), port, host);
    setTimeout(() => reject(new Error('timeout')), 2000);
  });
  return {
    async allocate(username, password) {
      const transport = { type: stun.ATTR.REQUESTED_TRANSPORT, value: Buffer.from([17, 0, 0, 0]) };
      const first = await request(stun.METHOD.ALLOCATE, [transport]);
      const realm = stun.getAttr(first, stun.ATTR.REALM), nonce = stun.getAttr(first, stun.ATTR.NONCE);
      const key = stun.longTermKey(username, realm.toString(), password);
      const res = await request(stun.METHOD.ALLOCATE, [transport, { type: stun.ATTR.USERNAME, value: Buffer.from(username) },
        { type: stun.ATTR.REALM, value: realm }, { type: stun.ATTR.NONCE, value: nonce }], key);
      return { cls: res.cls, code: res.cls === stun.CLASS.ERROR ? stun.decodeErrorCode(stun.getAttr(res, stun.ATTR.ERROR_CODE))?.code : 0, key, realm, nonce };
    },
    request, close: () => socket.close()
  };
}

test('gateway credentials are scoped to allowed rooms and revocable per peer', async () => {
  const tagA = 'AAAAAAAA' + 'x'.repeat(35), tagB = 'BBBBBBBB' + 'y'.repeat(35);
  const gw = await startGateway({ host: '127.0.0.1', port: 0, portMapping: false, externalAddress: '198.51.100.7', rooms: [tagA] });
  const port = gw.turn.addresses().find(a => a.transport === 'udp').port;
  const client = await turnClient(port);
  try {
    const ok = gw.credentialsFor(tagA, 'peer-one');
    assert.equal((await client.allocate(ok.username, ok.credential)).cls, stun.CLASS.SUCCESS);
    const otherRoom = gw.credentialsFor(tagB, 'peer-one');
    assert.equal(otherRoom, null, 'cannot mint for a room the gateway does not serve');
    const expired = { username: `${Math.floor(Date.now() / 1000) - 5}:${tagA.slice(0, 8)}:peer-two` };
    assert.equal((await client.allocate(expired.username, 'irrelevant')).code, 401, 'expired credentials');
    assert.equal(gw.revokePeer(tagA, 'peer-one') >= 1, true, 'revocation tears down the live allocation');
    const again = gw.credentialsFor(tagA, 'peer-one');
    assert.equal(again, null, 'cannot mint for a revoked peer');
    assert.equal((await client.allocate(ok.username, ok.credential)).code, 401, 'old credential cannot allocate again');
    gw.allowRoom(tagB);
    const later = gw.credentialsFor(tagB, 'peer-three');
    assert.equal((await client.allocate(later.username, later.credential)).cls, stun.CLASS.SUCCESS);
    gw.revokeRoom(tagB);
    const gone = gw.credentialsFor(tagB, 'peer-four');
    assert.equal(gone, null, 'cannot mint for a revoked room');
    assert.equal((await client.allocate(later.username, later.credential)).code, 401, 'old room credential rejected');
    assert.equal(gw.info().external[0], '198.51.100.7');
  } finally { client.close(); await gw.close(); }
});

test('gateway refuses permissions towards loopback (no access to services on its own machine)', async () => {
  const tag = 'CCCCCCCC' + 'z'.repeat(35);
  const gw = await startGateway({ host: '127.0.0.1', port: 0, portMapping: false, externalAddress: '198.51.100.8', rooms: [tag] });
  const port = gw.turn.addresses().find(a => a.transport === 'udp').port;
  const client = await turnClient(port);
  try {
    const creds = gw.credentialsFor(tag, 'peer');
    const alloc = await client.allocate(creds.username, creds.credential);
    assert.equal(alloc.cls, stun.CLASS.SUCCESS);
    const transactionId = randomBytes(12);
    const peer = { type: stun.ATTR.XOR_PEER_ADDRESS, value: stun.encodeXorAddress({ family: 4, address: '127.0.0.1', port: 11211 }, transactionId) };
    const res = await client.request(stun.METHOD.CREATE_PERMISSION, [peer, { type: stun.ATTR.USERNAME, value: Buffer.from(creds.username) },
      { type: stun.ATTR.REALM, value: alloc.realm }, { type: stun.ATTR.NONCE, value: alloc.nonce }], alloc.key).catch(e => e);
    assert.equal(stun.decodeErrorCode(stun.getAttr(res, stun.ATTR.ERROR_CODE))?.code, 403);
  } finally { client.close(); await gw.close(); }
});

test('gateway member rotation revokes all old-room allocations, including an unknown alias', async () => {
  const { joinAsGateway } = await import('../src/relay/member.mjs');
  const { deriveRoom, randomId } = await import('../src/client/crypto.mjs');
  class OfflineSocket { readyState = 0; close() {} send() {} }
  const oldSecret = randomId(32), nextSecret = randomId(32), app = 'audit-gateway';
  const oldTag = (await deriveRoom(oldSecret, app)).tag, nextTag = (await deriveRoom(nextSecret, app)).tag;
  const gw = await startGateway({host: '127.0.0.1', port: 0, portMapping: false, externalAddress: '198.51.100.9'});
  const member = await joinAsGateway({gates: ['ws://127.0.0.1:9/freehop'], secret: oldSecret, app, gateway: gw, WebSocketImpl: OfflineSocket});
  const client = await turnClient(gw.turn.addresses().find(a => a.transport === 'udp').port);
  try {
    const alias = gw.credentialsFor(oldTag, 'unreported-alias');
    assert.equal((await client.allocate(alias.username, alias.credential)).cls, stun.CLASS.SUCCESS);
    assert.equal(gw.turn.stats().allocations, 1);
    await member.rekey(nextSecret, {dropped: ['reported-member']});
    assert.equal(gw.turn.stats().allocations, 0, 'unknown alias allocation torn down too');
    assert.equal((await client.allocate(alias.username, alias.credential)).code, 401, 'old credentials cannot return');
    const next = gw.credentialsFor(nextTag, 'remaining-member');
    assert.equal((await client.allocate(next.username, next.credential)).cls, stun.CLASS.SUCCESS);
  } finally {client.close(); await member.close(); await gw.close();}
});

test('gateway rejects correctly signed credentials beyond its lifetime and never exports its key', async () => {
  const tag = 'Lifetime' + 'x'.repeat(35);
  const gw = await startGateway({host: '127.0.0.1', port: 0, portMapping: false, externalAddress: '198.51.100.7', rooms: [tag], credentialTtlSeconds: 60});
  const c = await turnClient(gw.turn.addresses().find(a => a.transport === 'udp').port);
  try {
    assert.equal(gw.info().secret, undefined);
    const clock = Date.now;
    let future;
    try { Date.now = () => clock() + 86400000; future = gw.credentialsFor(tag, 'future'); } finally {Date.now = clock;}
    assert.equal((await c.allocate(future.username, future.credential)).code, 401, 'a valid HMAC cannot bypass the lifetime bound');
    const valid = gw.credentialsFor(tag, 'current');
    assert.equal((await c.allocate(valid.username, valid.credential)).cls, stun.CLASS.SUCCESS);
  } finally {c.close(); await gw.close();}
});

test('revocation saturation fails closed for the affected room without reviving old credentials', async () => {
  const tag = 'RevokeAA' + 'x'.repeat(35), other = 'RevokeBB' + 'y'.repeat(35);
  const gw = await startGateway({host: '127.0.0.1', port: 0, portMapping: false, externalAddress: '198.51.100.7', rooms: [tag, other]});
  const c = await turnClient(gw.turn.addresses().find(a => a.transport === 'udp').port);
  try {
    const first = gw.credentialsFor(tag, 'first'), kept = gw.credentialsFor(tag, 'kept');
    gw.revokePeer(tag, 'first');
    for (let i = 0; i < 4100; i++) gw.revokePeer(tag, `peer-${i}`);
    assert.equal((await c.allocate(first.username, first.credential)).code, 401);
    assert.equal(gw.credentialsFor(tag, 'fresh-alias'), null);
    // Revocation tables are per room now: allowRoom is never refused because of them, and the
    // room's credential floor keeps every credential issued before the overflow void.
    gw.allowRoom(tag);
    assert.equal((await c.allocate(kept.username, kept.credential)).code, 401, 'a re-allowed room does not revive old credentials');
    const valid = gw.credentialsFor(other, 'remaining');
    assert.equal((await c.allocate(valid.username, valid.credential)).cls, stun.CLASS.SUCCESS);
  } finally {c.close(); await gw.close();}
});

test('room allocation quota counts different peer identities together and preserves another room', async () => {
  const tags = ['QuotaAAA' + 'x'.repeat(35), 'QuotaBBB' + 'y'.repeat(35)];
  const gw = await startGateway({host: '127.0.0.1', port: 0, portMapping: false, externalAddress: '198.51.100.7', rooms: tags, limits: {maxAllocationsPerScope: 2}});
  const clients = await Promise.all(Array.from({length: 4}, () => turnClient(gw.turn.addresses().find(a => a.transport === 'udp').port)));
  try {
    for (let i = 0; i < 3; i++) {
      const credential = gw.credentialsFor(tags[0], `alias-${i}`);
      const result = await clients[i].allocate(credential.username, credential.credential);
      assert.equal(result.code, i === 2 ? 486 : 0);
    }
    const other = gw.credentialsFor(tags[1], 'peer');
    assert.equal((await clients[3].allocate(other.username, other.credential)).code, 0);
    gw.revokeRoom(tags[0]);
    assert.equal(gw.turn.stats().allocations, 1);
  } finally {for (const c of clients) c.close(); await gw.close();}
});
