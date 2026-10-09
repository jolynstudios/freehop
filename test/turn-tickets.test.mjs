// SPDX-License-Identifier: Apache-2.0
// The opt-in application TURN relay through tickets, the authority and connect(): absent unless
// configured, validated everywhere, refreshed with tickets, never accepted from a gate or a peer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthority } from '../src/sdk/authority.mjs';
import { connect } from '../src/sdk/client.mjs';
import { decodeTicket, encodeTicket, validTicket } from '../src/sdk/ticket.mjs';

const gate = 'wss://operator.example/gate';
const TURN = [{ urls: ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349?transport=tcp'], username: '1800000000:u', credential: 'c1' }];
class Socket {
  readyState = 1; sent = [];
  constructor(url) { this.url = url; }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
}
const quiet = { WebSocket: Socket, media: { getTracks: () => [] }, desktopGateway: null };

test('tickets carry TURN servers only when the authority is configured with them', async () => {
  const plain = createAuthority({ app: 'turn', gates: [gate] }); await plain.openRoom('r');
  assert.equal('turn' in await plain.ticket('r', 'a'), false);
  const withTurn = createAuthority({ app: 'turn', gates: [gate], gateTokenSecret: 'g'.repeat(32), turn: [{ ...TURN[0], urls: TURN[0].urls[0] }] });
  await withTurn.openRoom('r');
  const ticket = await withTurn.ticket('r', 'a');
  assert.deepEqual(Object.keys(ticket), ['v', 'app', 'roomId', 'epoch', 'gates', 'stun', 'secret', 'expires', 'auth', 'turn'], 'turn is appended last');
  assert.deepEqual(ticket.turn, [{ urls: [TURN[0].urls[0]], username: TURN[0].username, credential: TURN[0].credential }]);
  assert.deepEqual(decodeTicket(encodeTicket(ticket)), ticket);
  assert.throws(() => createAuthority({ app: 'turn', gates: [gate], turn: 'turn:turn.example.com' }), /turn must be valid TURN servers/);
  assert.throws(() => createAuthority({ app: 'turn', gates: [gate], turn: [{ urls: ['stun:stun.example.com'], username: 'u', credential: 'c' }] }), /turn must be valid/);
});

test('a turn function mints servers per ticket, including every ticket of a rotation', async () => {
  const calls = [];
  const authority = createAuthority({ app: 'turn', gates: [gate], turn: async ({ roomId, member, expires }) => {
    calls.push({ roomId, member, expires: Number.isSafeInteger(expires) });
    return member === 'nobody' ? null : [{ urls: 'turn:turn.example.com:3478', username: `${expires}:${member ?? 'host'}`, credential: 'minted' }];
  } });
  await authority.openRoom('r');
  const alice = await authority.ticket('r', 'alice');
  assert.match(alice.turn[0].username, /^\d+:alice$/);
  assert.equal('turn' in await authority.ticket('r', 'nobody'), false, 'null means no relay for that ticket');
  await authority.ticket('r', 'bob');
  const { tickets, hostTicket } = await authority.kick('r', 'nobody');
  assert.deepEqual([...tickets.keys()], ['alice', 'bob']);
  assert.match(tickets.get('bob').turn[0].username, /:bob$/);
  assert.match(hostTicket.turn[0].username, /:host$/);
  assert.ok(calls.every(c => c.roomId === 'r' && c.expires));
  const broken = createAuthority({ app: 'turn', gates: [gate], turn: () => [{ urls: 'http://x.example', username: 'u', credential: 'c' }] });
  await broken.openRoom('r');
  await assert.rejects(broken.ticket('r', 'a'), /turn\(\) returned invalid TURN servers/);
});

test('validTicket accepts well-formed TURN servers and rejects anything else', () => {
  const base = { v: 1, app: 'turn', roomId: 'r', epoch: 1, gates: [gate], secret: 's'.repeat(43), expires: Math.floor(Date.now() / 1000) + 60 };
  assert.equal(validTicket({ ...base, turn: TURN }), true);
  assert.equal(validTicket({ ...base, turn: [] }), true);
  for (const turn of [null, 'turn:x.example', [{ urls: [], username: 'u', credential: 'c' }], [{ urls: 'turn:x.example', username: 'u' }],
    [{ urls: 'turn:x.example/path', username: 'u', credential: 'c' }], Array(3).fill(TURN[0])])
    assert.equal(validTicket({ ...base, turn }), false, JSON.stringify(turn));
});

test('connect() uses the ticket\'s TURN servers unless options.turn pins them', async () => {
  const authority = createAuthority({ app: 'turn', gates: [gate], turn: TURN }); await authority.openRoom('r');
  const ticket = await authority.ticket('r', 'a');
  const fromTicket = await connect(ticket, quiet);
  try { assert.deepEqual(fromTicket.turnServers, TURN); } finally { await fromTicket.leave(); }
  const pinnedOff = await connect(ticket, { ...quiet, turn: null });
  try { assert.equal(pinnedOff.turnServers, null); } finally { await pinnedOff.leave(); }
  const plainAuthority = createAuthority({ app: 'turn', gates: [gate] }); await plainAuthority.openRoom('r');
  const plain = await connect(await plainAuthority.ticket('r', 'a'), quiet);
  try { assert.equal(plain.turnServers, null); assert.equal('turn' in plain.options, false); } finally { await plain.leave(); }
});

test('refresh() and update() follow the TURN servers of newer tickets', async () => {
  let generation = 0;
  const authority = createAuthority({ app: 'turn', gates: [gate], turn: () => (generation++ === 3 ? null : [{ urls: 'turn:turn.example.com:3478', username: `g${generation}`, credential: 'c' }]) });
  await authority.openRoom('r');
  const first = await authority.ticket('r', 'a');
  const session = await connect(first, quiet);
  try {
    assert.equal(session.turnServers[0].username, 'g1');
    const reissued = { ...first, turn: [{ urls: 'turn:turn.example.com:3478', username: 'fresh', credential: 'c2' }], expires: first.expires + 60 };
    assert.equal(await session.refresh(reissued), true);
    assert.equal(session.turnServers[0].username, 'fresh');
    const { tickets } = await authority.kick('r', 'gone');
    assert.equal(await session.update(tickets.get('a')), true);
    assert.equal(session.turnServers[0].username, 'g2');
    const { tickets: next } = await authority.kick('r', 'gone-again');
    assert.equal(await session.update(next.get('a')), true);
    assert.equal(session.turnServers, null, 'a newer ticket without TURN servers removes them');
  } finally { await session.leave(); }
});

test('TURN servers never come from gates or peers', async () => {
  const authority = createAuthority({ app: 'turn', gates: [gate] }); await authority.openRoom('r');
  const session = await connect(await authority.ticket('r', 'a'), quiet);
  try {
    session.updateCaps('B'.repeat(22), { forward: true, peers: [], turn: TURN, gateway: null });
    assert.equal(session.turnServers, null);
    assert.equal('turn' in session.caps.get('B'.repeat(22)), false);
  } finally { await session.leave(); }
});
