// SPDX-License-Identifier: Apache-2.0
// Gate admission tokens: base64url(JSON claims) "." base64url(HMAC-SHA256(secret, body)).
// Claims: { exp: unix seconds, room?: room tag, aud?: exact gate URL }. A room-bound token admits only that room.
import { createHmac, timingSafeEqual } from 'node:crypto';

const TAG = /^[A-Za-z0-9_-]{22,43}$/;
// Unpadded base64url with one spelling only: the decoded bytes must re-encode to the same text.
const canonical = text => typeof text === 'string' && /^[A-Za-z0-9_-]+$/.test(text) && Buffer.from(text, 'base64url').toString('base64url') === text;

export function mintGateToken(secret, claims) {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
}

/**
 * verifyGateToken(secret, token, { audience?, now? }) -> claims, or null.
 * Both parts must be canonical unpadded base64url, the MAC must match and `exp` must be in the future.
 * With `audience`, `claims.aud` must equal it exactly, so a token without `aud` is refused.
 * A number as the third argument is still read as `now` (milliseconds).
 */
export function verifyGateToken(secret, token, options = {}) {
  const { now = Date.now(), audience } = typeof options === 'number' ? { now: options } : options ?? {};
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [body, mac, extra] = token.split('.');
  if (extra !== undefined || !canonical(body) || !canonical(mac)) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims; try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!claims || typeof claims !== 'object' || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now) return null;
  if (claims.room !== undefined && (typeof claims.room !== 'string' || !TAG.test(claims.room))) return null;
  if (claims.aud !== undefined && (typeof claims.aud !== 'string' || claims.aud.length > 320)) return null;
  if (audience !== undefined && claims.aud !== audience) return null;
  return claims;
}
