// SPDX-License-Identifier: Apache-2.0
// Regressions for the gate findings of the October 2026 review: pre-admission budgets (M4),
// output budgets and heartbeat nonces (M5), bursts, expiry on delivery, token form and the CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createGate, mintGateToken, verifyGateToken, randomTag } from '../src/gate/gate.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waiter = inbox => {
  const waiters = [];
  const deliver = m => { const w = waiters.findIndex(x => x.match(m)); if (w >= 0) waiters.splice(w, 1)[0].resolve(m); else inbox.push(m); };
  const next = (match = () => true, ms = 2000) => {
    const i = inbox.findIndex(match); if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout waiting for message')), ms); waiters.push({ match, resolve: m => { clearTimeout(t); res(m); } }); });
  };
  return { deliver, next };
};

const connect = (url) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url); const inbox = []; const { deliver, next } = waiter(inbox);
  ws.onmessage = e => deliver(JSON.parse(e.data));
  ws.onopen = () => resolve(Object.assign(ws, { inbox, next, sendJson: m => ws.send(JSON.stringify(m)), closed: new Promise(r => { ws.onclose = e => r(e); }) }));
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

// A bare WebSocket client on a TCP socket: it can stay silent, ignore close frames and pings,
// stop reading, or put many frames into one TCP write.
const frame = (opcode, payload) => {
  const data = Buffer.from(payload), mask = randomBytes(4), n = data.length;
  assert.ok(n < 65536);
  for (let i = 0; i < n; i++) data[i] ^= mask[i & 3];
  return Buffer.concat([Buffer.from(n < 126 ? [0x80 | opcode, 0x80 | n] : [0x80 | opcode, 0xfe, n >> 8, n & 255]), mask, data]);
};
const text = message => frame(1, JSON.stringify(message));
const raw = (url, headers = {}) => new Promise(resolve => {
  const { hostname, port, pathname } = new URL(url);
  const socket = net.connect(Number(port), hostname), inbox = [], { deliver, next } = waiter(inbox);
  const client = { socket, inbox, next, ok: false, write: (...frames) => socket.write(Buffer.concat(frames)) };
  let buffer = Buffer.alloc(0), upgraded = false;
  socket.on('connect', () => socket.write(`GET ${pathname} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`));
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
      upgraded = true; client.ok = buffer.subarray(0, 12).toString() === 'HTTP/1.1 101'; buffer = buffer.subarray(end + 4); resolve(client);
    }
    while (buffer.length >= 2) {
      let n = buffer[1] & 127, at = 2;
      if (n === 126) { if (buffer.length < 4) return; n = buffer.readUInt16BE(2); at = 4; }
      else if (n === 127) { if (buffer.length < 10) return; n = Number(buffer.readBigUInt64BE(2)); at = 10; }
      if (buffer.length < at + n) return;
      const opcode = buffer[0] & 15, payload = buffer.subarray(at, at + n); buffer = buffer.subarray(at + n);
      if (opcode === 1) deliver(JSON.parse(payload));
      else if (opcode === 8) deliver({ t: 'close', code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005 });
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => { if (!upgraded) resolve(client); });
});
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

test('silent sockets cannot lock clients with valid tokens out of a token-gated gate', async () => {
  const secret = randomTag(32);
  const gate = await createGate({ port: 0, tokenSecret: secret, trustProxy: true,
    limits: { maxSockets: 2, maxPendingSockets: 4, pendingPerAddress: 2, helloMs: 400, closeMs: 200 } });
  const hello = () => ({ t: 'hello', v: 1, auth: mintGateToken(secret, { exp: Math.floor(Date.now() / 1000) + 60, aud: gate.url() }) });
  const flood = [];
  try {
    const room = randomTag(32), a = randomTag(), b = randomTag();
    const wa = await joined(gate.url(), room, a, hello());
    const started = Date.now();
    for (const ip of ['198.51.100.1', '198.51.100.2']) for (let i = 0; i < 2; i++) flood.push(await raw(gate.url(), { 'x-forwarded-for': ip }));
    assert.ok(flood.every(s => s.ok), 'silent sockets use the pending budget, not the admitted one');
    flood.push(await raw(gate.url(), { 'x-forwarded-for': '198.51.100.1' }));
    assert.equal(flood.at(-1).ok, false, 'one address holds at most pendingPerAddress sockets before admission');
    // The pending budget is full of silent sockets: the oldest one makes room for a real client.
    const wb = await joined(gate.url(), room, b, hello());
    assert.equal(wb.peers.t, 'peers');
    assert.ok(gate.stats().evicted >= 1);
    wb.sendJson({ t: 'send', room, to: a, box: 'still-reachable' });
    assert.equal((await wa.next(m => m.t === 'recv')).box, 'still-reachable');
    // maxSockets now counts admitted sockets only.
    assert.equal((await joined(gate.url(), room, randomTag(), hello())).error, 'busy');
    // A refused socket that never answers the close frame is destroyed after closeMs, like the
    // silent ones after helloMs + closeMs: about half a second here, not ws's 30 s close timeout.
    const liar = await raw(gate.url(), { 'x-forwarded-for': '198.51.100.3' }); flood.push(liar);
    liar.write(text({ t: 'hello', v: 1, auth: 'nope' }));
    assert.equal((await liar.next(m => m.t === 'error')).code, 'auth');
    while (gate.stats().sockets > 2 && Date.now() - started < 5000) await sleep(20);
    assert.equal(gate.stats().sockets, 2);
    assert.equal(gate.stats().pending, 0);
    assert.ok(Date.now() - started < 2000, `teardown took ${Date.now() - started} ms`);
    wa.close(); wb.close();
  } finally { for (const s of flood) s.socket.destroy(); await gate.close(); }
});

test('per-address budgets count an IPv6 /64 as one address and IPv4-mapped as IPv4', async () => {
  const gate = await createGate({ port: 0, trustProxy: true, limits: { pendingPerAddress: 2 } });
  const sockets = [];
  const open = async ip => { const s = await raw(gate.url(), { 'x-forwarded-for': ip }); sockets.push(s); return s.ok; };
  try {
    assert.equal(await open('2001:db8:1:2::1'), true);
    assert.equal(await open('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), true);
    assert.equal(await open('2001:db8:1:2::3'), false, 'a third socket from the same /64 is refused');
    assert.equal(await open('2001:db8:1:3::1'), true, 'the next /64 has its own budget');
    assert.equal(await open('192.0.2.7'), true);
    assert.equal(await open('::ffff:192.0.2.7'), true);
    assert.equal(await open('192.0.2.7'), false, 'an IPv4-mapped address is the same client');
  } finally { for (const s of sockets) s.socket.destroy(); await gate.close(); }
});

test('only a pong that echoes the heartbeat nonce keeps a socket alive', async () => {
  const { WebSocket: WsClient } = await import('ws');
  const gate = await createGate({ port: 0, limits: { pingMs: 100, idleMs: 60000 } });
  const open = () => new Promise((resolve, reject) => { const ws = new WsClient(gate.url(), { autoPong: false }); ws.once('open', () => resolve(ws)); ws.once('error', reject); });
  try {
    const liar = await open(), honest = await open();
    for (const ws of [liar, honest]) ws.send(JSON.stringify({ t: 'hello', v: 1 }));
    honest.on('ping', data => honest.pong(data));
    // Unsolicited pongs used to count as liveness, so a socket that never reads stayed open.
    const fake = setInterval(() => { if (liar.readyState === 1) liar.pong(randomBytes(8)); }, 30);
    const closed = await Promise.race([new Promise(r => liar.once('close', () => r(true))), sleep(2000).then(() => false)]);
    clearInterval(fake);
    assert.equal(closed, true, 'a socket that never echoes the nonce is closed');
    assert.equal(honest.readyState, 1, 'a socket that echoes the nonce stays open');
    // Pings from clients are still answered, now through the output budget.
    const echo = new Promise(r => honest.once('pong', r));
    honest.ping(Buffer.from('are-you-there'));
    assert.equal((await echo).toString(), 'are-you-there');
    honest.close();
  } finally { await gate.close(); }
});

test('receivers that stop reading are closed before they pin gate memory', async () => {
  // First the per-socket cap, then the gate-wide budget, which closes the receiver that has been
  // behind the longest while a receiver that keeps up is unaffected.
  for (const limits of [{ maxBufferedBytes: 262144, maxBufferedTotal: 2 ** 30 }, { maxBufferedBytes: 2 ** 30, maxBufferedTotal: 262144 }]) {
    const gate = await createGate({ port: 0, limits: { ...limits, burstBytes: 2 ** 30, messageBurst: 2 ** 20 } });
    let stuck;
    try {
      const room = randomTag(32), peer = randomTag();
      const sender = await joined(gate.url(), room, randomTag()), reader = await joined(gate.url(), room, randomTag());
      stuck = await raw(gate.url());
      stuck.write(text({ t: 'hello', v: 1 })); await stuck.next(m => m.t === 'welcome');
      stuck.write(text({ t: 'join', room, peer })); await stuck.next(m => m.t === 'peers');
      stuck.socket.pause();   // kernel buffers fill first, then the gate's own queue grows
      const box = 'b'.repeat(40000);
      for (let i = 0; i < 2000 && !gate.stats().closedForAbuse; i++) {
        sender.sendJson({ t: 'send', room, to: '*', box });
        await reader.next(m => m.t === 'recv');
      }
      assert.equal(gate.stats().closedForAbuse, 1, JSON.stringify(limits));
      assert.deepEqual(await reader.next(m => m.t === 'peer' && m.peer === peer && !m.on), { t: 'peer', room, peer, on: false });
      assert.ok(gate.stats().buffered <= Math.min(limits.maxBufferedBytes, limits.maxBufferedTotal));
      sender.sendJson({ t: 'send', room, to: '*', box: 'after' });
      assert.equal((await reader.next(m => m.t === 'recv')).box, 'after');
      assert.equal(reader.readyState, 1);
      sender.close(); reader.close();
    } finally { stuck?.socket.destroy(); await gate.close(); }
  }
});

test('a burst of envelopes in one TCP read after admission is not mistaken for a flood', async () => {
  const gate = await createGate({ port: 0 });
  let burst;
  try {
    const room = randomTag(32), peer = randomTag();
    const reader = await joined(gate.url(), room, randomTag());
    burst = await raw(gate.url());
    burst.write(text({ t: 'hello', v: 1 })); await burst.next(m => m.t === 'welcome');
    burst.write(text({ t: 'join', room, peer })); await burst.next(m => m.t === 'peers');
    burst.write(...Array.from({ length: 70 }, (_, i) => text({ t: 'send', room, to: '*', box: `envelope${i}` })));
    for (let i = 0; i < 70; i++) assert.equal((await reader.next(m => m.t === 'recv')).box, `envelope${i}`);
    assert.equal(gate.stats().rateLimited, 0);
    assert.equal(burst.inbox.find(m => m.t === 'error' || m.t === 'close'), undefined);
    reader.close();
  } finally { burst?.socket.destroy(); await gate.close(); }
});

test('an expired socket is closed on delivery, without waiting for a heartbeat', async () => {
  const secret = randomTag(32);
  const gate = await createGate({ port: 0, tokenSecret: secret, limits: { pingMs: 600000 } });
  try {
    const room = randomTag(32), a = randomTag(), b = randomTag(), exp = Math.floor(Date.now() / 1000) + 1;
    const brief = await joined(gate.url(), room, a, { t: 'hello', v: 1, auth: mintGateToken(secret, { exp, room, aud: gate.url() }) });
    const lasting = await joined(gate.url(), room, b, { t: 'hello', v: 1, auth: mintGateToken(secret, { exp: exp + 60, room, aud: gate.url() }) });
    await brief.next(m => m.t === 'peer' && m.on);
    await sleep(exp * 1000 - Date.now() + 50);
    lasting.sendJson({ t: 'send', room, to: a, box: 'too-late' });
    const event = await Promise.race([brief.closed, sleep(1500).then(() => null)]);
    assert.ok(event, 'the expired socket is closed when a message would reach it');
    assert.equal(event.code, 1008); assert.equal(event.reason, 'auth-expired');
    assert.equal(brief.inbox.find(m => m.t === 'recv'), undefined, 'nothing is delivered after expiry');
    assert.deepEqual(await lasting.next(m => m.t === 'peer' && !m.on), { t: 'peer', room, peer: a, on: false });
    lasting.close();
  } finally { await gate.close(); }
});

test('gate tokens have one canonical spelling and verify an optional audience', async () => {
  const secret = randomTag(32), aud = 'wss://gate.example.com/freehop', exp = Math.floor(Date.now() / 1000) + 60;
  let token, i = 0;
  do token = mintGateToken(secret, { exp: exp + i++, aud }); while (!/[-_]/.test(token.split('.')[1]));
  const [body, mac] = token.split('.');
  assert.equal(verifyGateToken(secret, token).aud, aud);
  // A 32-byte MAC is 43 characters whose last one has two spare bits: several spellings decode alike.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const twin = mac.slice(0, -1) + alphabet[alphabet.indexOf(mac.at(-1)) ^ 1];
  const standard = mac.replace(/-/g, '+').replace(/_/g, '/');
  assert.deepEqual(Buffer.from(twin, 'base64url'), Buffer.from(mac, 'base64url'));
  assert.deepEqual(Buffer.from(standard, 'base64url'), Buffer.from(mac, 'base64url'));
  const sign = text => `${text}.${createHmac('sha256', secret).update(text).digest('base64url')}`;
  for (const variant of [token + '=', token + '!', `${body}.${twin}`, `${body}.${standard}`, `${body}.${mac}==`, sign(`${body}=`)])
    assert.equal(verifyGateToken(secret, variant), null, variant);
  assert.equal(verifyGateToken(secret, token, { audience: aud }).aud, aud);
  assert.equal(verifyGateToken(secret, token, { audience: 'wss://other.example.com/freehop' }), null);
  const unbound = mintGateToken(secret, { exp });
  assert.equal(verifyGateToken(secret, unbound).exp, exp);
  assert.equal(verifyGateToken(secret, unbound, { audience: aud }), null, 'a required audience rejects a token without one');
  assert.equal(verifyGateToken(secret, token, Date.now() + 3600000), null, 'a number is still read as `now`');
  assert.equal(verifyGateToken(secret, token, { now: Date.now() + 3600000, audience: aud }), null);
  const gate = await createGate({ port: 0, tokenSecret: secret });
  try {
    const good = mintGateToken(secret, { exp, aud: gate.url() });
    const bad = await joined(gate.url(), randomTag(32), randomTag(), { t: 'hello', v: 1, auth: `${good}=` });
    assert.equal(bad.error, 'auth');
    const ok = await joined(gate.url(), randomTag(32), randomTag(), { t: 'hello', v: 1, auth: good });
    assert.equal(ok.peers.t, 'peers'); ok.close(); bad.close();
  } finally { await gate.close(); }
});

test('the gate CLI refuses weak secrets and unprotected public listeners, and warns when anonymous', async () => {
  const cli = fileURLToPath(new URL('../bin/freehop-gate.mjs', import.meta.url));
  const run = (vars, untilListening = false) => new Promise(resolve => {
    const child = spawn(process.execPath, [cli], { env: { PATH: process.env.PATH, ...vars } });
    const guard = setTimeout(() => child.kill('SIGKILL'), 10000);
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; if (untilListening && out.includes('"listening"')) child.kill('SIGTERM'); });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => { clearTimeout(guard); resolve({ code, out, err }); });
  });
  const port = String(await freePort()), audience = 'wss://gate.example.com/freehop';
  for (const [vars, message] of [
    [{ FREEHOP_GATE_TOKEN_SECRET: 'x'.repeat(31), FREEHOP_GATE_TOKEN_AUDIENCE: audience }, /at least 32 characters/],
    [{ FREEHOP_GATE_HOST: '0.0.0.0' }, /reachable beyond loopback/],
    [{ FREEHOP_GATE_HOST: '' }, /FREEHOP_GATE_HOST is empty/],
    [{ FREEHOP_GATE_TRUST_PROXY: '1' }, /reachable beyond loopback/],
    [{ FREEHOP_GATE_PUBLIC_HOST: 'gate.example.com' }, /reachable beyond loopback/],
    [{ FREEHOP_GATE_TRUST_PROXY: 'true' }, /must be 0 or 1/],
    [{ FREEHOP_GATE_PORT: '' }, /port from 1 to 65535/],
    [{ FREEHOP_GATE_PORT: '65536' }, /port from 1 to 65535/]
  ]) {
    const result = await run({ FREEHOP_GATE_PORT: port, ...vars });
    assert.equal(result.code, 1, JSON.stringify(vars));
    assert.match(result.err, message);
    assert.doesNotMatch(result.out, /listening/);
  }
  const local = await run({ FREEHOP_GATE_PORT: port }, true);
  assert.match(local.out, /"event":"listening"/);
  assert.equal(local.err.split('\n').filter(line => line.includes('"warning"')).length, 1, 'one warning line when anonymous');
  for (const name of ['FREEHOP_GATE_ALLOW_ANONYMOUS', 'FREEHOP_GATE_ANONYMOUS']) {
    const open = await run({ FREEHOP_GATE_PORT: port, FREEHOP_GATE_PUBLIC_HOST: 'gate.example.com', [name]: '1' }, true);
    assert.match(open.out, /"event":"listening"/, name); assert.match(open.err, /anonymous gate/);
  }
  const gated = await run({ FREEHOP_GATE_PORT: port, FREEHOP_GATE_TRUST_PROXY: '1', FREEHOP_GATE_TOKEN_SECRET: randomTag(32), FREEHOP_GATE_TOKEN_AUDIENCE: audience }, true);
  assert.match(gated.out, /"event":"listening"/);
  assert.doesNotMatch(gated.err, /warning/);
});
