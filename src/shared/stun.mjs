// SPDX-License-Identifier: Apache-2.0
// STUN (RFC 8489) and TURN (RFC 8656) message codec. Every decoder returns null on
// malformed input and never throws on hostile bytes; encoders throw on programmer errors.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import * as zlib from 'node:zlib';

export const MAGIC_COOKIE = 0x2112A442;
export const METHOD = { BINDING: 0x001, ALLOCATE: 0x003, REFRESH: 0x004, SEND: 0x006, DATA: 0x007, CREATE_PERMISSION: 0x008, CHANNEL_BIND: 0x009 };
export const CLASS = { REQUEST: 0, INDICATION: 1, SUCCESS: 2, ERROR: 3 };
export const ATTR = { MAPPED_ADDRESS: 0x0001, USERNAME: 0x0006, MESSAGE_INTEGRITY: 0x0008, ERROR_CODE: 0x0009, UNKNOWN_ATTRIBUTES: 0x000A,
  CHANNEL_NUMBER: 0x000C, LIFETIME: 0x000D, XOR_PEER_ADDRESS: 0x0012, DATA: 0x0013, REALM: 0x0014, NONCE: 0x0015, XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_ADDRESS_FAMILY: 0x0017, EVEN_PORT: 0x0018, REQUESTED_TRANSPORT: 0x0019, DONT_FRAGMENT: 0x001A, MESSAGE_INTEGRITY_SHA256: 0x001C,
  PASSWORD_ALGORITHM: 0x001D, USERHASH: 0x001E, XOR_MAPPED_ADDRESS: 0x0020, RESERVATION_TOKEN: 0x0022, PRIORITY: 0x0024, USE_CANDIDATE: 0x0025,
  ADDITIONAL_ADDRESS_FAMILY: 0x8000, PASSWORD_ALGORITHMS: 0x8002, ALTERNATE_DOMAIN: 0x8003, SOFTWARE: 0x8022, ALTERNATE_SERVER: 0x8023,
  FINGERPRINT: 0x8028, ICE_CONTROLLED: 0x8029, ICE_CONTROLLING: 0x802A };

const HEADER = 20, FINGERPRINT_XOR = 0x5354554e, COLON = Buffer.from(':'), EMPTY = Buffer.alloc(0);
const COOKIE = Buffer.from([0x21, 0x12, 0xa4, 0x42]);
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const pad4 = n => (n + 3) & ~3;

let CRC_TABLE;
function tableCrc32(buf, crc = 0) {
  if (!CRC_TABLE) CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n; });
  crc = ~crc;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}
const crc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : tableCrc32; // native since Node 20.15/22.2

function asBuffer(b) { return Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength); }
function toBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  if (ArrayBuffer.isView(v)) return asBuffer(v);
  throw new TypeError('STUN value must be a Buffer, Uint8Array or string');
}

export function isStunMessage(buf) {
  if (!buf || !(buf.length >= HEADER) || (buf[0] & 0xc0) !== 0 || u32(buf, 4) !== MAGIC_COOKIE) return false;
  const len = u16(buf, 2);
  return (len & 3) === 0 && len + HEADER <= buf.length;
}

export function isChannelData(buf) { return !!buf && buf.length >= 4 && buf[0] >= 0x40 && buf[0] <= 0x4f; }

const messageType = (method, cls) => (method & 0x000f) | ((method & 0x0070) << 1) | ((method & 0x0f80) << 2) | ((cls & 1) << 4) | ((cls & 2) << 7);

export function decode(buf) {
  try {
    if (!isStunMessage(buf)) return null;
    const b = asBuffer(buf), length = u16(b, 2), raw = b.subarray(0, HEADER + length), type = u16(raw, 0);
    const attributes = [];
    // After MESSAGE-INTEGRITY only MESSAGE-INTEGRITY-SHA256 and FINGERPRINT count (RFC 8489 14.5/14.6);
    // after FINGERPRINT nothing does. Ignored attributes are still bounds-checked until FINGERPRINT.
    let off = HEADER, stage = 0;
    while (off < raw.length) {
      if (off + 4 > raw.length) return null;
      const t = u16(raw, off), len = u16(raw, off + 2), next = off + 4 + pad4(len);
      if (next > raw.length) return null;
      const attr = { type: t, value: raw.subarray(off + 4, off + 4 + len), offset: off };
      if (t === ATTR.FINGERPRINT) { attributes.push(attr); break; }
      if (stage === 0) {
        attributes.push(attr);
        if (t === ATTR.MESSAGE_INTEGRITY) stage = 1; else if (t === ATTR.MESSAGE_INTEGRITY_SHA256) stage = 2;
      } else if (stage === 1 && t === ATTR.MESSAGE_INTEGRITY_SHA256) { attributes.push(attr); stage = 2; }
      off = next;
    }
    const method = (type & 0x000f) | ((type & 0x00e0) >> 1) | ((type & 0x3e00) >> 2), cls = ((type >> 4) & 1) | ((type >> 7) & 2);
    return { type, method, cls, transactionId: raw.subarray(8, HEADER), attributes, length, raw };
  } catch { return null; }
}

export function getAttr(msg, type) {
  const list = msg?.attributes;
  if (list) for (const a of list) if (a.type === type) return a.value;
  return undefined;
}

export function encode({ method, cls, transactionId, attributes = [] }, { integrityKey, fingerprint = false } = {}) {
  const tid = transactionId === undefined ? randomBytes(12) : toBuffer(transactionId);
  if (tid.length !== 12) throw new RangeError('transactionId must be 12 bytes');
  const items = attributes.map(({ type, value }) => {
    const v = value === undefined ? EMPTY : toBuffer(value);
    if (v.length > 0xffff || !(type >= 0 && type <= 0xffff)) throw new RangeError('invalid STUN attribute');
    return [type, v];
  });
  let body = HEADER;
  for (const [, v] of items) body += 4 + pad4(v.length);
  const total = body + (integrityKey ? 24 : 0) + (fingerprint ? 8 : 0);
  if (total - HEADER > 0xffff) throw new RangeError('STUN message too large');
  const out = Buffer.allocUnsafe(total);
  out.writeUInt16BE(messageType(method, cls), 0); out.writeUInt16BE(body - HEADER, 2); out.writeUInt32BE(MAGIC_COOKIE, 4); tid.copy(out, 8);
  let off = HEADER;
  for (const [type, v] of items) {
    out.writeUInt16BE(type, off); out.writeUInt16BE(v.length, off + 2); v.copy(out, off + 4);
    const end = off + 4 + pad4(v.length); out.fill(0, off + 4 + v.length, end); off = end;
  }
  if (integrityKey) {
    out.writeUInt16BE(off + 24 - HEADER, 2); // length covers MESSAGE-INTEGRITY, not FINGERPRINT
    const mac = createHmac('sha1', toBuffer(integrityKey)).update(out.subarray(0, off)).digest();
    out.writeUInt16BE(ATTR.MESSAGE_INTEGRITY, off); out.writeUInt16BE(20, off + 2); mac.copy(out, off + 4); off += 24;
  }
  if (fingerprint) {
    out.writeUInt16BE(off + 8 - HEADER, 2);
    const crc = (crc32(out.subarray(0, off)) ^ FINGERPRINT_XOR) >>> 0;
    out.writeUInt16BE(ATTR.FINGERPRINT, off); out.writeUInt16BE(4, off + 2); out.writeUInt32BE(crc, off + 4);
  }
  return out;
}

// IPv4 dotted quad or IPv6 (zone ids stripped, embedded IPv4 tails accepted) to 4/16 bytes.
export function ipToBytes(address) {
  if (typeof address !== 'string') return null;
  const zone = address.indexOf('%');
  if (zone >= 0) address = address.slice(0, zone);
  if (isIPv4(address)) return Buffer.from(address.split('.').map(Number));
  if (!isIPv6(address)) return null;
  let s = address, tail = null;
  if (s.includes('.')) { const i = s.lastIndexOf(':'); tail = s.slice(i + 1).split('.').map(Number); s = s.slice(0, i + 1) + '0:0'; }
  const halves = s.split('::'), head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length > 1 ? (halves[1] ? halves[1].split(':') : []) : null;
  const groups = rest === null ? head : [...head, ...Array(8 - head.length - rest.length).fill('0'), ...rest];
  if (groups.length !== 8) return null;
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) out.writeUInt16BE(parseInt(groups[i], 16), i * 2);
  if (tail) out.set(tail, 12);
  return out;
}

// RFC 5952 text form; IPv4-mapped addresses keep the ::ffff:a.b.c.d form Node uses.
export function bytesToIp(b) {
  if (b?.length === 4) return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
  if (b?.length !== 16) return null;
  let mapped = b[10] === 0xff && b[11] === 0xff;
  for (let i = 0; i < 10 && mapped; i++) mapped = b[i] === 0;
  if (mapped) return `::ffff:${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  const g = []; for (let i = 0; i < 16; i += 2) g.push(u16(b, i));
  let best = -1, bestLen = 1;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i; while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) { best = i; bestLen = j - i; }
    i = j;
  }
  const hex = a => a.map(x => x.toString(16)).join(':');
  return best < 0 ? hex(g) : `${hex(g.slice(0, best))}::${hex(g.slice(best + bestLen))}`;
}

function addressBytes({ family, address }) {
  const ip = ipToBytes(address), want = family === 6 || family === 'IPv6' ? 16 : family === 4 || family === 'IPv4' ? 4 : ip?.length;
  if (!ip || ip.length !== want) throw new TypeError(`invalid IPv${want === 16 ? 6 : 4} address: ${address}`);
  return ip;
}
function addressValue(ip, port) {
  if (!Number.isInteger(port) || port < 0 || port > 0xffff) throw new RangeError('invalid port');
  const out = Buffer.alloc(4 + ip.length);
  out[1] = ip.length === 4 ? 0x01 : 0x02; out.writeUInt16BE(port, 2); ip.copy(out, 4);
  return out;
}
function xorBytes(ip, transactionId) {
  if (ip.length === 16) {
    const tid = toBuffer(transactionId);
    if (tid.length !== 12) throw new RangeError('transactionId must be 12 bytes');
    for (let i = 0; i < 16; i++) ip[i] ^= i < 4 ? COOKIE[i] : tid[i - 4];
  } else for (let i = 0; i < 4; i++) ip[i] ^= COOKIE[i];
  return ip;
}

export function encodeAddress(addr) { return addressValue(addressBytes(addr), addr.port); }
export function encodeXorAddress(addr, transactionId) {
  return addressValue(xorBytes(Buffer.from(addressBytes(addr)), transactionId), addr.port ^ (MAGIC_COOKIE >>> 16));
}

function readAddress(value) {
  if (!value || value.length < 4) return null;
  const size = value[1] === 0x01 ? 4 : value[1] === 0x02 ? 16 : 0;
  if (!size || value.length !== 4 + size) return null;
  return { family: size === 4 ? 4 : 6, port: u16(value, 2), ip: Buffer.from(value.subarray(4)) };
}
export function decodeAddress(value) {
  try { const a = readAddress(value); return a && { family: a.family, address: bytesToIp(a.ip), port: a.port }; } catch { return null; }
}
export function decodeXorAddress(value, transactionId) {
  try {
    const a = readAddress(value);
    if (!a || (a.family === 6 && transactionId?.length !== 12)) return null;
    return { family: a.family, address: bytesToIp(xorBytes(a.ip, transactionId)), port: a.port ^ (MAGIC_COOKIE >>> 16) };
  } catch { return null; }
}

export function errorCodeValue(code, reason = '') {
  if (!Number.isInteger(code) || code < 300 || code > 699) throw new RangeError('STUN error code must be 300..699');
  let r = Buffer.from(String(reason), 'utf8');
  if (r.length > 763) r = r.subarray(0, 763);
  const out = Buffer.alloc(4 + r.length);
  out[2] = Math.floor(code / 100); out[3] = code % 100; r.copy(out, 4);
  return out;
}
export function decodeErrorCode(value) {
  if (!value || value.length < 4 || value[3] > 99) return null;
  return { code: (value[2] & 7) * 100 + value[3], reason: value.subarray(4).toString('utf8') };
}

// SASLprep-lite (RFC 4013 mapping + NFKC). Limitation: no prohibited-output, bidi or
// unassigned-code-point checks, and not the RFC 8265 OpaqueString (NFC) profile. Browsers
// hash the raw password bytes, so only ASCII credentials are guaranteed to interoperate.
const NON_ASCII_SPACE = /[   -​  　]/g;
const MAPPED_TO_NOTHING = /[­͏᠆᠋-᠍​-‍⁠︀-️﻿]/g;
export function saslprep(s) { return String(s).replace(NON_ASCII_SPACE, ' ').replace(MAPPED_TO_NOTHING, '').normalize('NFKC'); }

// Long-term credential key (RFC 8489 9.2.2, MD5 algorithm). USERNAME/REALM are used exactly as
// sent on the wire (Buffer or UTF-8 string); a string password is SASLprep-lite processed,
// a Buffer password is used verbatim.
export function longTermKey(username, realm, password) {
  const pw = typeof password === 'string' ? Buffer.from(saslprep(password), 'utf8') : toBuffer(password);
  return createHash('md5').update(Buffer.concat([toBuffer(username), COLON, toBuffer(realm), COLON, pw])).digest();
}

function adjustedHeader(msg, end) { const h = Buffer.from(msg.raw.subarray(0, HEADER)); h.writeUInt16BE(end - HEADER, 2); return h; }

export function verifyIntegrity(msg, key) {
  try {
    const attr = msg?.attributes?.find(a => a.type === ATTR.MESSAGE_INTEGRITY);
    if (!attr || attr.value.length !== 20) return false;
    const mac = createHmac('sha1', toBuffer(key)).update(adjustedHeader(msg, attr.offset + 24)).update(msg.raw.subarray(HEADER, attr.offset)).digest();
    return timingSafeEqual(mac, attr.value);
  } catch { return false; }
}

export function verifyFingerprint(msg) {
  try {
    const attr = msg?.attributes?.find(a => a.type === ATTR.FINGERPRINT);
    if (!attr) return { present: false, valid: false };
    if (attr.value.length !== 4) return { present: true, valid: false };
    const crc = (crc32(msg.raw.subarray(HEADER, attr.offset), crc32(adjustedHeader(msg, attr.offset + 8))) ^ FINGERPRINT_XOR) >>> 0;
    return { present: true, valid: crc === u32(attr.value, 0) };
  } catch { return { present: false, valid: false }; }
}

export function encodeChannelData(channel, data, { pad = false } = {}) {
  const d = toBuffer(data);
  if (!Number.isInteger(channel) || channel < 0x4000 || channel > 0x4fff) throw new RangeError('channel must be 0x4000..0x4FFF');
  if (d.length > 0xffff) throw new RangeError('ChannelData too large');
  const out = Buffer.allocUnsafe(4 + (pad ? pad4(d.length) : d.length));
  out.writeUInt16BE(channel, 0); out.writeUInt16BE(d.length, 2); d.copy(out, 4); out.fill(0, 4 + d.length);
  return out;
}

export function decodeChannelData(buf) {
  if (!isChannelData(buf)) return null;
  const len = u16(buf, 2);
  if (4 + len > buf.length) return null; // trailing bytes beyond Length (UDP/stream padding) are ignored
  const b = asBuffer(buf);
  return { channel: u16(b, 0), data: b.subarray(4, 4 + len) };
}

// Splits accumulated TCP/TLS bytes into complete STUN messages (20 + Length) and ChannelData
// frames (4 + Length padded to 4; 0x4000-0x7FFF framed so reserved channels don't desync the
// stream). Also returns `need` (total bytes the next frame requires, 4 while unknown) and
// `error` when the stream cannot be framed; the caller must then close the connection.
export function frameStreamMessages(buffer) {
  const buf = buffer ? asBuffer(buffer) : EMPTY, messages = [];
  let off = 0, need = 4, error;
  while (buf.length - off >= 4) {
    const b0 = buf[off], len = u16(buf, off + 2);
    let total;
    if (b0 < 0x40) {
      if (len & 3) { error = 'bad-stun-length'; break; }
      if (buf.length - off >= 8 && u32(buf, off + 4) !== MAGIC_COOKIE) { error = 'bad-magic-cookie'; break; }
      total = HEADER + len;
    } else if (b0 < 0x80) total = 4 + pad4(len);
    else { error = 'not-stun-or-channeldata'; break; }
    if (buf.length - off < total) { need = total; break; }
    messages.push(buf.subarray(off, off + total)); off += total;
  }
  const result = { messages, rest: buf.subarray(off), need: error ? 0 : need };
  if (error) result.error = error;
  return result;
}
