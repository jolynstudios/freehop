// SPDX-License-Identifier: Apache-2.0
// Minimal Freehop consumer: an application backend that admits members to rooms and hands
// out tickets, plus the gate on the same origin. Everything an app needs, nothing app-specific.
//   node examples/minimal/server.mjs [port]
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createGate } from '../../src/gate/gate.mjs';
import { createAuthority } from '../../src/sdk/authority.mjs';

const root = new URL('../../', import.meta.url);
const TYPES = { '.mjs': 'text/javascript', '.html': 'text/html; charset=utf-8' };

export async function startExample({ host = '127.0.0.1', port = 0 } = {}) {
  const gateTokenSecret = randomBytes(32).toString('base64url');
  const members = new Map();   // member id -> room id (your app's own notion of membership)
  const peerIds = new Map();   // member id -> Freehop peer id (reported by the client)
  const dropped = new Map();   // room id -> peer ids removed (so remaining clients drop them too)
  let authority;
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const body = req => new Promise(resolve => { let s = ''; req.on('data', c => { s += c; if (s.length > 4096) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } }); });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://example');
    // Static: the page and the SDK's browser modules (client/ and sdk/ only).
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': TYPES['.html'] }); res.end(await readFile(new URL('examples/minimal/index.html', root))); return; }
    const m = /^\/peerlane\/(client|sdk)\/([a-z-]+\.mjs)$/.exec(url.pathname);
    if (m) { res.writeHead(200, { 'content-type': TYPES['.mjs'], 'cache-control': 'no-store' }); res.end(await readFile(new URL(`src/${m[1]}/${m[2]}`, root))); return; }
    // App API: your own authentication decides who may join; here anyone may.
    if (url.pathname === '/api/join' && req.method === 'POST') {
      const { room } = await body(req);
      if (typeof room !== 'string' || !/^[a-z0-9-]{1,32}$/.test(room)) return json(res, 400, { error: 'room' });
      await authority.openRoom(room);
      const member = randomBytes(6).toString('hex');
      members.set(member, room);
      return json(res, 200, { member, ticket: await authority.ticket(room, member) });
    }
    if (url.pathname === '/api/peer' && req.method === 'POST') {
      const { member, peer } = await body(req);
      if (!members.has(member) || typeof peer !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(peer)) return json(res, 400, { error: 'peer' });
      peerIds.set(member, peer);
      return json(res, 200, {});
    }
    if (url.pathname === '/api/ticket' && req.method === 'GET') {
      const member = url.searchParams.get('member'), room = members.get(member);
      if (!room) return json(res, 403, { error: 'not a member' });
      return json(res, 200, { ticket: await authority.ticket(room, member), dropped: dropped.get(room) ?? [] });
    }
    if (url.pathname === '/api/kick' && req.method === 'POST') {
      const { member } = await body(req), room = members.get(member);
      if (!room) return json(res, 404, { error: 'unknown member' });
      members.delete(member);
      if (peerIds.has(member)) { dropped.set(room, [...(dropped.get(room) ?? []), peerIds.get(member)].slice(-32)); peerIds.delete(member); }
      const result = await authority.kick(room, member);
      return json(res, 200, { epoch: result.epoch });
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(port, host, resolve));
  const origin = `http://${host}:${server.address().port}`;
  const gate = await createGate({ server, tokenSecret: gateTokenSecret });
  authority = createAuthority({ app: 'peerlane-example', gates: [origin.replace(/^http/, 'ws') + gate.path], gateTokenSecret });
  return { origin, gate, authority, members, async close() { await gate.close(); await new Promise(r => server.close(r)); server.closeAllConnections?.(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const example = await startExample({ port: Number(process.argv[2] ?? 8790) });
  console.log(`Freehop example: ${example.origin}  (open it in two or more browser windows)`);
}
