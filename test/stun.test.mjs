// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MAGIC_COOKIE, METHOD, CLASS, ATTR, isStunMessage, isChannelData, decode, getAttr, encode, encodeAddress, encodeXorAddress,
  decodeXorAddress, decodeAddress, errorCodeValue, decodeErrorCode, longTermKey, verifyIntegrity, verifyFingerprint, encodeChannelData,
  decodeChannelData, frameStreamMessages, ipToBytes, bytesToIp, saslprep } from '../src/shared/stun.mjs';

const hex = s => Buffer.from(s.replace(/\s+/g, ''), 'hex');
// RFC 5769 test vectors (Copyright (c) 2010 IETF Trust and the document authors; Simplified BSD License, see NOTICE), verbatim (SOFTWARE/USERNAME padding in 2.1-2.3 is 0x20 on purpose).
const RFC5769 = {
  request: hex(`00 01 00 58 21 12 a4 42 b7 e7 a7 01 bc 34 d6 86 fa 87 df ae 80 22 00 10 53 54 55 4e 20 74 65 73 74 20 63 6c 69 65 6e 74
    00 24 00 04 6e 00 01 ff 80 29 00 08 93 2f f9 b1 51 26 3b 36 00 06 00 09 65 76 74 6a 3a 68 36 76 59 20 20 20
    00 08 00 14 9a ea a7 0c bf d8 cb 56 78 1e f2 b5 b2 d3 f2 49 c1 b5 71 a2 80 28 00 04 e5 7a 3b cf`),
  ipv4: hex(`01 01 00 3c 21 12 a4 42 b7 e7 a7 01 bc 34 d6 86 fa 87 df ae 80 22 00 0b 74 65 73 74 20 76 65 63 74 6f 72 20
    00 20 00 08 00 01 a1 47 e1 12 a6 43 00 08 00 14 2b 91 f5 99 fd 9e 90 c3 8c 74 89 f9 2a f9 ba 53 f0 6b e7 d7 80 28 00 04 c0 7d 4c 96`),
  ipv6: hex(`01 01 00 48 21 12 a4 42 b7 e7 a7 01 bc 34 d6 86 fa 87 df ae 80 22 00 0b 74 65 73 74 20 76 65 63 74 6f 72 20
    00 20 00 14 00 02 a1 47 01 13 a9 fa a5 d3 f1 79 bc 25 f4 b5 be d2 b9 d9
    00 08 00 14 a3 82 95 4e 4b e6 7b f1 17 84 c9 7c 82 92 c2 75 bf e3 ed 41 80 28 00 04 c8 fb 0b 4c`),
  longTerm: hex(`00 01 00 60 21 12 a4 42 78 ad 34 33 c6 ad 72 c0 29 da 41 2e 00 06 00 12 e3 83 9e e3 83 88 e3 83 aa e3 83 83 e3 82 af e3 82 b9 00 00
    00 15 00 1c 66 2f 2f 34 39 39 6b 39 35 34 64 36 4f 4c 33 34 6f 4c 39 46 53 54 76 79 36 34 73 41
    00 14 00 0b 65 78 61 6d 70 6c 65 2e 6f 72 67 00 00 08 00 14 f6 70 24 65 6d d6 4a 3e 02 b8 e0 71 2e 85 c9 a2 8c a8 96 66`),
};
const SHORT_TERM = 'VOkJxbRl1RmTxUk/WvJxBt';
const TID = hex('b7e7a701bc34d686fa87dfae');

test('RFC 5769 2.1 sample request: attributes, MESSAGE-INTEGRITY and FINGERPRINT', () => {
  const msg = decode(RFC5769.request);
  assert.ok(msg);
  assert.equal(msg.method, METHOD.BINDING); assert.equal(msg.cls, CLASS.REQUEST); assert.equal(msg.length, 0x58);
  assert.deepEqual(msg.transactionId, TID);
  assert.equal(getAttr(msg, ATTR.SOFTWARE).toString(), 'STUN test client');
  assert.equal(getAttr(msg, ATTR.USERNAME).toString(), 'evtj:h6vY');
  assert.deepEqual(getAttr(msg, ATTR.PRIORITY), hex('6e0001ff'));
  assert.deepEqual(getAttr(msg, ATTR.ICE_CONTROLLED), hex('932ff9b151263b36'));
  assert.equal(verifyIntegrity(msg, SHORT_TERM), true);
  assert.equal(verifyIntegrity(msg, 'wrong'), false);
  assert.deepEqual(verifyFingerprint(msg), { present: true, valid: true });
});

test('RFC 5769 2.2 IPv4 response decodes 192.0.2.1:32853', () => {
  const msg = decode(RFC5769.ipv4);
  assert.equal(msg.method, METHOD.BINDING); assert.equal(msg.cls, CLASS.SUCCESS);
  assert.equal(getAttr(msg, ATTR.SOFTWARE).toString(), 'test vector');
  assert.deepEqual(decodeXorAddress(getAttr(msg, ATTR.XOR_MAPPED_ADDRESS), msg.transactionId), { family: 4, address: '192.0.2.1', port: 32853 });
  assert.equal(verifyIntegrity(msg, SHORT_TERM), true);
  assert.deepEqual(verifyFingerprint(msg), { present: true, valid: true });
  assert.deepEqual(encodeXorAddress({ family: 4, address: '192.0.2.1', port: 32853 }, TID), getAttr(msg, ATTR.XOR_MAPPED_ADDRESS));
});

test('RFC 5769 2.3 IPv6 response decodes 2001:db8:1234:5678:11:2233:4455:6677:32853', () => {
  const msg = decode(RFC5769.ipv6);
  const mapped = { family: 6, address: '2001:db8:1234:5678:11:2233:4455:6677', port: 32853 };
  assert.deepEqual(decodeXorAddress(getAttr(msg, ATTR.XOR_MAPPED_ADDRESS), msg.transactionId), mapped);
  assert.deepEqual(encodeXorAddress(mapped, TID), getAttr(msg, ATTR.XOR_MAPPED_ADDRESS));
  assert.equal(verifyIntegrity(msg, SHORT_TERM), true);
  assert.deepEqual(verifyFingerprint(msg), { present: true, valid: true });
});

test('RFC 5769 2.4 long-term credentials (SASLprep before/after) and byte-exact re-encode', () => {
  const msg = decode(RFC5769.longTerm);
  const username = 'マトリックス';
  assert.equal(getAttr(msg, ATTR.USERNAME).toString('utf8'), username);
  assert.equal(getAttr(msg, ATTR.NONCE).toString(), 'f//499k954d6OL34oL9FSTvy64sA');
  assert.equal(getAttr(msg, ATTR.REALM).toString(), 'example.org');
  assert.deepEqual(verifyFingerprint(msg), { present: false, valid: false });
  const key = longTermKey(username, 'example.org', 'TheMatrIX');
  assert.equal(saslprep('The­MªtrⅨ'), 'TheMatrIX');
  assert.deepEqual(longTermKey(username, 'example.org', 'The­MªtrⅨ'), key);
  assert.deepEqual(longTermKey(getAttr(msg, ATTR.USERNAME), getAttr(msg, ATTR.REALM), 'TheMatrIX'), key);
  assert.equal(verifyIntegrity(msg, key), true);
  assert.equal(verifyIntegrity(msg, longTermKey(username, 'example.org', 'thematrix')), false);
  const again = encode({ method: METHOD.BINDING, cls: CLASS.REQUEST, transactionId: msg.transactionId, attributes: [
    { type: ATTR.USERNAME, value: username }, { type: ATTR.NONCE, value: 'f//499k954d6OL34oL9FSTvy64sA' }, { type: ATTR.REALM, value: 'example.org' }] },
  { integrityKey: key });
  assert.deepEqual(again, RFC5769.longTerm);
});

test('encode/decode round trip with integrity, fingerprint, method/class bits', () => {
  for (const [method, cls, type] of [[METHOD.ALLOCATE, CLASS.REQUEST, 0x0003], [METHOD.ALLOCATE, CLASS.SUCCESS, 0x0103], [METHOD.ALLOCATE, CLASS.ERROR, 0x0113],
    [METHOD.SEND, CLASS.INDICATION, 0x0016], [METHOD.DATA, CLASS.INDICATION, 0x0017], [METHOD.CHANNEL_BIND, CLASS.REQUEST, 0x0009], [0xfff, CLASS.ERROR, 0x3fff]]) {
    const tid = randomBytes(12), key = randomBytes(16);
    const buf = encode({ method, cls, transactionId: tid, attributes: [{ type: ATTR.DATA, value: Buffer.from('abcde') }, { type: ATTR.SOFTWARE, value: 'x' }] },
      { integrityKey: key, fingerprint: true });
    assert.equal(buf.readUInt16BE(0), type);
    assert.equal(isStunMessage(buf), true);
    const msg = decode(buf);
    assert.equal(msg.method, method); assert.equal(msg.cls, cls); assert.deepEqual(msg.transactionId, tid);
    assert.equal(getAttr(msg, ATTR.DATA).toString(), 'abcde');
    assert.equal(verifyIntegrity(msg, key), true);
    assert.deepEqual(verifyFingerprint(msg), { present: true, valid: true });
    const flipped = Buffer.from(buf); flipped[24] ^= 1;
    assert.equal(verifyIntegrity(decode(flipped), key), false);
    assert.equal(verifyFingerprint(decode(flipped)).valid, false);
  }
  assert.throws(() => encode({ method: 1, cls: 0, transactionId: Buffer.alloc(11) }), RangeError);
});

test('attributes after MESSAGE-INTEGRITY (except MI-SHA256/FINGERPRINT) and after FINGERPRINT are ignored', () => {
  const tid = randomBytes(12), key = Buffer.from('k');
  const signed = encode({ method: METHOD.ALLOCATE, cls: CLASS.REQUEST, transactionId: tid, attributes: [{ type: ATTR.LIFETIME, value: Buffer.alloc(4) }] }, { integrityKey: key });
  const extra = Buffer.from([0x00, 0x13, 0x00, 0x04, 1, 2, 3, 4]); // DATA appended after MESSAGE-INTEGRITY
  const tampered = Buffer.concat([signed, extra]); tampered.writeUInt16BE(tampered.length - 20, 2);
  const msg = decode(tampered);
  assert.ok(msg); assert.equal(getAttr(msg, ATTR.DATA), undefined); assert.equal(verifyIntegrity(msg, key), true);
  const fp = encode({ method: METHOD.BINDING, cls: CLASS.REQUEST, transactionId: tid }, { fingerprint: true });
  const after = Buffer.concat([fp, extra]); after.writeUInt16BE(after.length - 20, 2);
  assert.deepEqual(decode(after).attributes.map(a => a.type), [ATTR.FINGERPRINT]);
});

test('decode rejects malformed framing without throwing', () => {
  const good = encode({ method: METHOD.BINDING, cls: CLASS.REQUEST, transactionId: randomBytes(12), attributes: [{ type: ATTR.SOFTWARE, value: 'abc' }] });
  const mutate = f => { const b = Buffer.from(good); f(b); return b; };
  assert.equal(decode(good.subarray(0, 19)), null);
  assert.equal(decode(good.subarray(0, good.length - 1)), null);
  assert.equal(decode(mutate(b => { b[0] |= 0x80; })), null);
  assert.equal(decode(mutate(b => { b[4] ^= 1; })), null);
  assert.equal(decode(mutate(b => b.writeUInt16BE(b.readUInt16BE(2) + 2, 2))), null);
  assert.equal(decode(mutate(b => b.writeUInt16BE(9, 22))), null); // attribute overruns message
  assert.equal(decode(mutate(b => b.writeUInt16BE(4, 2))), null);   // header cut inside an attribute
  assert.ok(decode(Buffer.concat([good, Buffer.from('trailing')])), 'trailing datagram bytes beyond Length are ignored');
  for (const v of [undefined, null, 0, 'x', {}, Buffer.alloc(0), new Uint8Array(40)]) assert.equal(decode(v), null);
  assert.ok(decode(new Uint8Array(good)), 'plain Uint8Array input is accepted');
});

test('addresses: IPv4, IPv6, mapped, canonical forms and malformed values', () => {
  const tid = randomBytes(12);
  for (const a of [{ family: 4, address: '203.0.113.7', port: 1 }, { family: 6, address: '2001:db8::1', port: 65535 }, { family: 6, address: '::', port: 3478 },
    { family: 6, address: '::ffff:192.0.2.9', port: 9 }, { family: 6, address: 'fe80::1:2:3:4', port: 7 }]) {
    assert.deepEqual(decodeAddress(encodeAddress(a)), a);
    assert.deepEqual(decodeXorAddress(encodeXorAddress(a, tid), tid), a);
  }
  assert.equal(bytesToIp(ipToBytes('2001:0DB8:0000:0000:0001:0000:0000:0001')), '2001:db8::1:0:0:1');
  assert.equal(bytesToIp(ipToBytes('1:0:2:0:3:0:4:0')), '1:0:2:0:3:0:4:0');
  assert.equal(bytesToIp(ipToBytes('fe80::1%en0')), 'fe80::1');
  assert.equal(bytesToIp(ipToBytes('::ffff:7f00:1')), '::ffff:127.0.0.1');
  assert.equal(ipToBytes('not-an-ip'), null);
  assert.throws(() => encodeAddress({ family: 4, address: '::1', port: 1 }), TypeError);
  assert.equal(decodeXorAddress(Buffer.from([0, 3, 0, 0, 1, 2, 3, 4]), tid), null);
  assert.equal(decodeXorAddress(Buffer.from([0, 1, 0, 0, 1, 2, 3]), tid), null);
  assert.equal(decodeXorAddress(encodeXorAddress({ family: 6, address: '::1', port: 1 }, tid), Buffer.alloc(3)), null);
  assert.equal(decodeAddress(undefined), null);
});

test('error codes, channel data and stream framing', () => {
  assert.deepEqual(decodeErrorCode(errorCodeValue(438, 'Stale Nonce')), { code: 438, reason: 'Stale Nonce' });
  assert.deepEqual(decodeErrorCode(errorCodeValue(508)), { code: 508, reason: '' });
  assert.equal(decodeErrorCode(Buffer.from([0, 0, 4])), null);
  assert.throws(() => errorCodeValue(200), RangeError);

  const cd = encodeChannelData(0x4001, Buffer.from('hello'));
  assert.equal(cd.length, 9); assert.equal(isChannelData(cd), true);
  assert.deepEqual(decodeChannelData(cd), { channel: 0x4001, data: Buffer.from('hello') });
  const padded = encodeChannelData(0x4fff, Buffer.from('hello'), { pad: true });
  assert.equal(padded.length, 12); assert.deepEqual(padded.subarray(9), Buffer.alloc(3));
  assert.equal(decodeChannelData(padded).data.toString(), 'hello');
  assert.equal(decodeChannelData(cd.subarray(0, 8)), null);
  assert.equal(decodeChannelData(Buffer.from([0x50, 0, 0, 0])), null);
  assert.throws(() => encodeChannelData(0x3fff, Buffer.alloc(1)), RangeError);

  const stun = encode({ method: METHOD.REFRESH, cls: CLASS.REQUEST, transactionId: randomBytes(12), attributes: [{ type: ATTR.LIFETIME, value: Buffer.alloc(4) }] });
  const stream = Buffer.concat([padded, stun, encodeChannelData(0x4002, Buffer.alloc(0), { pad: true }), stun.subarray(0, 10)]);
  const framed = frameStreamMessages(stream);
  assert.equal(framed.error, undefined);
  assert.deepEqual(framed.messages.map(m => m.length), [12, stun.length, 4]);
  assert.deepEqual(framed.rest, stun.subarray(0, 10)); assert.equal(framed.need, stun.length);
  assert.equal(frameStreamMessages(Buffer.from([0x40, 0x00])).need, 4);
  assert.equal(frameStreamMessages(Buffer.from([0x40, 0x00, 0x00, 0x05, 1])).need, 12);
  assert.equal(frameStreamMessages(Buffer.from([0x80, 0, 0, 0])).error, 'not-stun-or-channeldata');
  assert.equal(frameStreamMessages(Buffer.from([0, 1, 0, 2, 0x21, 0x12, 0xa4, 0x42])).error, 'bad-stun-length');
  assert.equal(frameStreamMessages(Buffer.from([0, 1, 0, 0, 1, 2, 3, 4])).error, 'bad-magic-cookie');
  assert.equal(MAGIC_COOKIE, 0x2112a442);
});

test('fuzz: random, truncated and bit-flipped input never throws', () => {
  const seeds = [...Object.values(RFC5769), encodeChannelData(0x4000, randomBytes(33), { pad: true })];
  const tid = randomBytes(12);
  const probe = buf => {
    const msg = decode(buf);
    if (msg) {
      assert.ok(msg.raw.length <= buf.length);
      for (const a of msg.attributes) assert.ok(a.offset + 4 + a.value.length <= msg.raw.length);
      verifyIntegrity(msg, 'k'); verifyFingerprint(msg);
      for (const a of msg.attributes) { decodeXorAddress(a.value, msg.transactionId); decodeAddress(a.value); decodeErrorCode(a.value); }
    }
    isStunMessage(buf); isChannelData(buf); decodeChannelData(buf); decodeXorAddress(buf, tid); decodeAddress(buf);
    const f = frameStreamMessages(buf);
    assert.equal(f.messages.reduce((n, m) => n + m.length, 0) + f.rest.length, buf.length);
  };
  for (let i = 0; i < 20000; i++) {
    const seed = seeds[i % seeds.length];
    let buf;
    switch (i % 4) {
      case 0: buf = randomBytes(Math.floor(Math.random() * 120)); break;
      case 1: buf = seed.subarray(0, Math.floor(Math.random() * seed.length)); break;
      case 2: buf = Buffer.from(seed); for (let k = 0; k < 1 + (i % 5); k++) buf[Math.floor(Math.random() * buf.length)] ^= 1 << (i % 8); break;
      default: { // valid header, random TLV soup
        const body = randomBytes(4 * Math.floor(Math.random() * 30));
        buf = Buffer.concat([Buffer.from([0, 1, body.length >> 8, body.length & 0xff, 0x21, 0x12, 0xa4, 0x42]), tid, body]);
      }
    }
    assert.doesNotThrow(() => probe(buf));
  }
});
