// SPDX-License-Identifier: Apache-2.0
// The room secret never leaves the peers. HKDF derives an opaque room tag (the only room
// identifier a gate sees) and an AES-GCM key that seals every signalling envelope end to end.
const te = new TextEncoder(), td = new TextDecoder();
const subtle = globalThis.crypto.subtle;

export function toBase64Url(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function fromBase64Url(text) {
  const s = atob(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - text.length % 4) % 4));
  const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
export const randomId = (bytes = 16) => toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));

/** deriveRoom(secret, app) -> { tag, key }. `secret` is a string or bytes with >=128 bits of entropy. */
export async function deriveRoom(secret, app = 'peerlane') {
  const raw = typeof secret === 'string' ? te.encode(secret) : secret;
  if (!(raw instanceof Uint8Array) || raw.length < 16) throw new TypeError('Room secret must carry at least 16 bytes.');
  const base = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const salt = te.encode('peerlane/v1/' + app);
  const tag = toBase64Url(new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('room-tag') }, base, 256)));
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('envelope-key') }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { tag, key };
}

// The additional data binds room, sender and recipient: a gate that re-routes or relabels an
// envelope makes it fail authentication instead of reaching the wrong peer.
const aad = (room, from, to) => te.encode(`peerlane/v1|${room.tag}|${from}|${to}`);

export async function seal(room, from, to, payload) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(room, from, to) }, room.key, te.encode(JSON.stringify(payload))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return toBase64Url(out);
}

export async function open(room, from, to, box) {
  try {
    const bytes = fromBase64Url(box);
    if (bytes.length < 29) return null;
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: aad(room, from, to) }, room.key, bytes.subarray(12));
    const payload = JSON.parse(td.decode(plain));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch { return null; }
}
