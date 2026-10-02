// SPDX-License-Identifier: Apache-2.0
// Gate admission tokens: base64url(JSON claims) "." base64url(HMAC-SHA256(secret, body)).
// Claims: { exp: unix seconds, room?: room tag }. A room-bound token admits only that room.
import { createHmac, timingSafeEqual } from 'node:crypto';

const TAG = /^[A-Za-z0-9_-]{22,43}$/;

export function mintGateToken(secret, claims) {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
}

export function verifyGateToken(secret, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims; try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!claims || typeof claims !== 'object' || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now) return null;
  if (claims.room !== undefined && (typeof claims.room !== 'string' || !TAG.test(claims.room))) return null;
  return claims;
}
