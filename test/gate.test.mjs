// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { createGate, mintGateToken, verifyGateToken, randomTag } from '../src/gate/gate.mjs';
import { deriveRoom, seal, open, randomId } from '../src/client/crypto.mjs';
import * as stun from '../src/shared/stun.mjs';

const connect = (url) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url); const inbox = []; const waiters = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); const w = waiters.findIndex(x => x.match(m)); if (w >= 0) waiters.splice(w, 1)[0].resolve(m); else inbox.push(m); };
  ws.onopen = () => resolve(Object.assign(ws, {
    sendJson: m => ws.send(JSON.stringify(m)),
    next: (match = () => true, ms = 2000) => {
      const i = inbox.findIndex(match); if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout waiting for message')), ms); waiters.push({ match, resolve: m => { clearTimeout(t); res(m); } }); });
    },
    closed: new Promise(r => { ws.onclose = e => r(e); })
  }));
  ws.onerror = reject;
});

async function joined(url, room, peer, hello = { t: 'hello', v: 1 }) {
  const ws = await connect(url);
  ws.sendJson(hello);
  const welcome = await ws.next(m => m.t === 'welcome' || m.t === 'error');
  if (welcome.t === 'error') return Object.assign(ws, { error: welcome.code });
  ws.sendJson({ t: 'join', room, peer });
  ws.peers = (await ws.next(m => m.t === 'peers' || m.t === 'error'));
  return ws;
}

test('gate introduces peers and routes sealed envelopes only between room members', async () => {
  const gate = await createGate({ port: 0 });
  try {
    const room = randomTag(32), a = randomTag(), b = randomTag();
    const wa = await joined(gate.url(), room, a);
    assert.deepEqual(wa.peers.peers, []);
    const wb = await joined(gate.url(), room, b);
    assert.deepEqual(wb.peers.peers, [a]);
    assert.deepEqual(await wa.next(m => m.t === 'peer'), { t: 'peer', room, peer: b, on: true });
    wa.sendJson({ t: 'send', room, to: b, box: 'abc_DEF-123' });
    assert.deepEqual(await wb.next(m => m.t === 'recv'), { t: 'recv', room, from: a, box: 'abc_DEF-123' });
    wb.sendJson({ t: 'send', room, to: '*', box: 'xyz' });
    assert.equal((await wa.next(m => m.t === 'recv')).box, 'xyz');
    wa.sendJson({ t: 'send', room, to: randomTag(), box: 'nobody' });
    assert.equal((await wa.next(m => m.t === 'error')).code, 'no-such-peer');
    // A peer in another room is unreachable.
    const wc = await joined(gate.url(), randomTag(32), randomTag());
    wc.sendJson({ t: 'send', room, to: a, box: 'intrude' });
    assert.equal((await wc.next(m => m.t === 'error')).code, 'not-joined');
    wb.close();
    assert.deepEqual(await wa.next(m => m.t === 'peer'), { t: 'peer', room, peer: b, on: false });
    wa.close(); wc.close();
    await new Promise(r => setTimeout(r, 100));
    assert.equal(gate.rooms(), 0);
    const s = gate.stats();
    assert.equal(s.envelopes, 2);
  } finally { await gate.close(); }
});

test('gate rejects malformed frames, oversize boxes and floods', async () => {
  const gate = await createGate({ port: 0, limits: { burstBytes: 4096, refillBytesPerSec: 1, box: 2048 } });
  try {
    const room = randomTag(32);
    const a = await joined(gate.url(), room, randomTag()), b = await joined(gate.url(), room, randomTag());
    a.sendJson({ t: 'send', room, to: b.peers.peers.length ? b.peers.peers[0] : '*', box: 'x'.repeat(3000) });
    assert.equal((await a.next(m => m.t === 'error')).code, 'schema');
    await a.closed;
    const c = await joined(gate.url(), room, randomTag());
    for (let i = 0; i < 3; i++) c.sendJson({ t: 'send', room, to: '*', box: 'y'.repeat(2000) });
    assert.equal((await c.next(m => m.t === 'error')).code, 'rate');
    const e = await c.closed; assert.equal(e.code, 1008);
    const d = await connect(gate.url());
    d.sendJson({ t: 'join', room, peer: randomTag() });           // no hello first
    assert.equal((await d.next(m => m.t === 'error')).code, 'hello');
    b.close();
  } finally { await gate.close(); }
});

test('token admission and room binding', async () => {
  const secret = 'gate-secret-for-tests';
  const gate = await createGate({ port: 0, tokenSecret: secret });
  try {
    const room = randomTag(32), other = randomTag(32);
    const bad = await joined(gate.url(), room, randomTag(), { t: 'hello', v: 1, auth: 'nope' });
    assert.equal(bad.error, 'auth');
    const expired = mintGateToken(secret, { exp: Math.floor(Date.now() / 1000) - 5 });
    assert.equal(verifyGateToken(secret, expired), null);
    const bound = mintGateToken(secret, { exp: Math.floor(Date.now() / 1000) + 60, room });
    const ok = await joined(gate.url(), room, randomTag(), { t: 'hello', v: 1, auth: bound });
    assert.equal(ok.peers.t, 'peers');
    const wrong = await joined(gate.url(), other, randomTag(), { t: 'hello', v: 1, auth: bound });
    assert.equal(wrong.peers.code, 'room-not-allowed');
    ok.close(); wrong.close();
  } finally { await gate.close(); }
});

test('room capacity is enforced', async () => {
  const gate = await createGate({ port: 0, limits: { peersPerRoom: 2 } });
  try {
    const room = randomTag(32);
    const a = await joined(gate.url(), room, randomTag()), b = await joined(gate.url(), room, randomTag());
    const c = await joined(gate.url(), room, randomTag());
    assert.equal(c.peers.code, 'room-full');
    a.close(); b.close(); c.close();
  } finally { await gate.close(); }
});

test('gate STUN responder reports the reflexive address', async () => {
  const gate = await createGate({ port: 0, stun: [{ host: '127.0.0.1', port: 0 }] });
  const socket = dgram.createSocket('udp4');
  try {
    assert.match(gate.stunUrls[0], /^stun:127\.0\.0\.1:\d+$/);
    const port = Number(gate.stunUrls[0].split(':')[2]);
    const tid = Buffer.from('0123456789ab');
    const reply = new Promise(r => socket.once('message', r));
    await new Promise(r => socket.bind(0, '127.0.0.1', r));
    socket.send(stun.encode({ method: stun.METHOD.BINDING, cls: stun.CLASS.REQUEST, transactionId: tid }), port, '127.0.0.1');
    const msg = stun.decode(await reply);
    assert.equal(msg.cls, stun.CLASS.SUCCESS);
    const mapped = stun.decodeXorAddress(stun.getAttr(msg, stun.ATTR.XOR_MAPPED_ADDRESS), msg.transactionId);
    assert.deepEqual(mapped, { family: 4, address: '127.0.0.1', port: socket.address().port });
    assert.equal(gate.stats().stun[0].requests, 1);
  } finally { socket.close(); await gate.close(); }
});

test('envelopes are opaque to gates and bound to sender, recipient and room', async () => {
  const room = await deriveRoom(randomId(32), 'test');
  const other = await deriveRoom(randomId(32), 'test');
  const a = randomId(), b = randomId(), c = randomId();
  const box = await seal(room, a, b, { kind: 'description', n: 1, sdp: 'v=0' });
  assert.ok(!box.includes('v=0') && !/description/.test(Buffer.from(box, 'base64url').toString('latin1')));
  assert.deepEqual(await open(room, a, b, box), { kind: 'description', n: 1, sdp: 'v=0' });
  assert.equal(await open(room, c, b, box), null);      // relabelled sender
  assert.equal(await open(room, a, c, box), null);      // re-routed to another peer
  assert.equal(await open(other, a, b, box), null);     // another room's key
  assert.equal(room.tag.length, 43);
  assert.notEqual(room.tag, other.tag);
});

test('idle but healthy sockets survive: pongs count as activity', async () => {
  const gate = await createGate({ port: 0, limits: { idleMs: 400, pingMs: 150 } });
  try {
    const ws = await joined(gate.url(), randomTag(32), randomTag());
    let closed = false; ws.addEventListener('close', () => { closed = true; });
    await new Promise(r => setTimeout(r, 1200));   // three idle periods without app messages
    assert.equal(closed, false);
    ws.close();
  } finally { await gate.close(); }
});

test('behind a trusted local proxy the per-address limit applies to X-Forwarded-For', async () => {
  const { WebSocket: WsClient } = await import('ws');
  const gate = await createGate({ port: 0, trustProxy: true, limits: { socketsPerAddress: 1 } });
  const open = ip => new Promise(resolve => {
    const ws = new WsClient(gate.url(), { headers: { 'x-forwarded-for': `10.9.9.9, ${ip}` } });
    ws.on('open', () => resolve({ ws, ok: true })); ws.on('error', () => resolve({ ws, ok: false })); ws.on('unexpected-response', () => resolve({ ws, ok: false }));
  });
  try {
    const a = await open('203.0.113.1'), b = await open('203.0.113.2'), c = await open('203.0.113.1');
    assert.equal(a.ok, true); assert.equal(b.ok, true);
    assert.equal(c.ok, false, 'second socket from the same forwarded client address is refused');
    for (const x of [a, b, c]) x.ws.terminate();
  } finally { await gate.close(); }
});

test('an admitted socket loses access when its gate token expires', async () => {
  const secret = 'expiry-regression', expires = Math.floor(Date.now() / 1000) + 2;
  const gate = await createGate({port: 0, tokenSecret: secret, limits: {pingMs: 50}});
  try {
    const ws = await joined(gate.url(), randomTag(32), randomTag(), {t: 'hello', v: 1, auth: mintGateToken(secret, {exp: expires})});
    assert.equal(ws.peers.t, 'peers');
    const event = await Promise.race([ws.closed, new Promise((_, reject) => setTimeout(() => reject(new Error('expired socket stayed open')), 3000))]);
    assert.equal(event.code, 1008);
    assert.equal(event.reason, 'auth-expired');
    const until = Date.now() + 1000;
    while (gate.rooms() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(gate.rooms(), 0);
  } finally {await gate.close();}
});

test('frames queued behind asynchronous admission are bounded and cannot resurrect a closed socket', async () => {
  let release, begun;
  const started = new Promise(resolve => {begun = resolve;});
  const gate = await createGate({port: 0, limits: {maxPendingFrames: 4}, authorize: () => {begun(); return new Promise(resolve => {release = resolve;});}});
  try {
    const ws = await connect(gate.url());
    ws.sendJson({t: 'hello', v: 1}); await started;
    for (let i = 0; i < 8; i++) ws.sendJson({t: 'join', room: randomTag(32), peer: randomTag()});
    assert.equal((await ws.closed).code, 1008);
    release(true);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(gate.rooms(), 0);
    assert.equal(gate.stats().joins, 0);
    assert.ok(gate.stats().rateLimited >= 1);
  } finally {release?.(false); await gate.close();}
});

test('STUN Binding answers obey the global reflection budget', async () => {
  const {createStunResponder} = await import('../src/gate/stun-responder.mjs');
  const responder = await createStunResponder({host: '127.0.0.1', port: 0, burst: 100, totalBurst: 2, totalRatePerSec: 0});
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
    for (let i = 0; i < 10; i++) socket.send(stun.encode({method: stun.METHOD.BINDING, cls: stun.CLASS.REQUEST, transactionId: Buffer.alloc(12, i)}), responder.address().port, '127.0.0.1');
    const until = Date.now() + 2000;
    while (responder.stats().responses + responder.stats().rateLimited < 10 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(responder.stats().responses, 2);
    assert.equal(responder.stats().rateLimited, 8);
  } finally {socket.close(); await responder.close();}
});
