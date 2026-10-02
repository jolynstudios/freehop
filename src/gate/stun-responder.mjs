// SPDX-License-Identifier: Apache-2.0
// RFC 8489 Binding responder: tells a peer which public address its UDP socket maps to.
// It answers Binding requests only, never relays anything, and rate-limits per source.
import dgram from 'node:dgram';
import { isStunMessage, decode, encode, encodeXorAddress, METHOD, CLASS, ATTR } from '../shared/stun.mjs';

export async function createStunResponder({ host = '0.0.0.0', port = 3478, ratePerSec = 10, burst = 30, totalRatePerSec = 200, totalBurst = 400, software = 'peerlane-gate', log = () => {} } = {}) {
  const type = host.includes(':') ? 'udp6' : 'udp4';
  const socket = dgram.createSocket({ type, ipv6Only: type === 'udp6' });
  const stats = { requests: 0, responses: 0, bytesIn: 0, bytesOut: 0, dropped: 0, rateLimited: 0 };
  let buckets = new Map();
  const total = { level: totalBurst, at: Date.now() };
  const allow = address => {
    const now = Date.now();
    total.level = Math.min(totalBurst, total.level + (now - total.at) / 1000 * totalRatePerSec); total.at = now;
    if (total.level < 1) return false;
    let b = buckets.get(address);
    if (!b) {
      if (buckets.size > 50000) buckets = new Map();
      b = { level: burst, at: now }; buckets.set(address, b);
    }
    b.level = Math.min(burst, b.level + (now - b.at) / 1000 * ratePerSec); b.at = now;
    if (b.level < 1) return false;
    b.level -= 1; total.level -= 1; return true;
  };
  socket.on('message', (buf, rinfo) => {
    try {
      stats.bytesIn += buf.length;
      if (buf.length > 548 || !isStunMessage(buf)) { stats.dropped++; return; }
      const msg = decode(buf);
      if (!msg || msg.method !== METHOD.BINDING || msg.cls !== CLASS.REQUEST) { stats.dropped++; return; }
      if (!allow(rinfo.address)) { stats.rateLimited++; return; }
      stats.requests++;
      const mapped = rinfo.address.startsWith('::ffff:') && rinfo.address.includes('.')
        ? { family: 4, address: rinfo.address.slice(7), port: rinfo.port }
        : { family: rinfo.family === 'IPv6' ? 6 : 4, address: rinfo.address, port: rinfo.port };
      const out = encode({ method: METHOD.BINDING, cls: CLASS.SUCCESS, transactionId: msg.transactionId, attributes: [
        { type: ATTR.XOR_MAPPED_ADDRESS, value: encodeXorAddress(mapped, msg.transactionId) },
        { type: ATTR.SOFTWARE, value: Buffer.from(software) }
      ] }, { fingerprint: true });
      socket.send(out, rinfo.port, rinfo.address);
      stats.responses++; stats.bytesOut += out.length;
    } catch (error) { stats.dropped++; log('stun-error', { message: error?.message }); }
  });
  socket.on('error', error => log('stun-socket-error', { message: error?.message }));
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(port, host, () => { socket.off('error', reject); resolve(); }); });
  return {
    address: () => socket.address(),
    stats: () => ({ ...stats }),
    close: () => new Promise(resolve => { try { socket.close(resolve); } catch { resolve(); } })
  };
}
