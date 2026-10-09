// SPDX-License-Identifier: Apache-2.0
// NAT classification and port prediction: pure functions over candidate strings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNat, cleanNat, createPredictor, createSampler, parseCandidate, MAX_PREDICTED } from '../src/client/nat.mjs';

const chrome = (port, rport = 54321) => `candidate:842163049 1 udp 1677729535 203.0.113.10 ${port} typ srflx raddr 192.168.1.2 rport ${rport} generation 0 ufrag abcd network-id 1 network-cost 10`;
const firefox = port => `candidate:1 1 UDP 1686052863 203.0.113.10 ${port} typ srflx raddr 192.168.1.2 rport 54321`;
const safari = port => `candidate:842163049 1 udp 1685987071 203.0.113.10 ${port} typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag abcd network-cost 999`;

test('candidate strings from Chromium, Firefox and Safari parse; malformed ones do not', () => {
  assert.deepEqual(parseCandidate(chrome(40001)), { foundation: '842163049', component: '1', protocol: 'udp', priority: 1677729535, address: '203.0.113.10', port: 40001,
    type: 'srflx', raddr: '192.168.1.2', rport: 54321, extensions: ['generation', '0', 'ufrag', 'abcd', 'network-id', '1', 'network-cost', '10'] });
  assert.equal(parseCandidate(firefox(40001)).protocol, 'udp');
  assert.equal(parseCandidate(`a=${safari(40001)}`).rport, 0);
  for (const bad of ['', 'candidate:1 1 udp 1 1.2.3.4 99999 typ host', 'candidate:1 1 udp x 1.2.3.4 1 typ host', 'nonsense', 'candidate:1 1 udp 1 1.2.3.4 5 kind host', 'x'.repeat(2000), null])
    assert.equal(parseCandidate(bad), null, String(bad).slice(0, 40));
});

const sampled = (texts, errors = []) => {
  const sampler = createSampler();
  for (const text of texts) sampler.candidate(text);
  for (const url of errors) sampler.error(url);
  return sampler.result();
};

test('one srflx port for two answering STUN servers is endpoint-independent; failures make it unknown', () => {
  assert.deepEqual(classifyNat({ ...sampled([chrome(40000)]), servers: 2, complete: true }), { type: 'eim', delta: 0 });
  assert.deepEqual(classifyNat({ ...sampled([chrome(40000)]), servers: 1, complete: true }), { type: 'unknown', delta: 0 }, 'one server cannot tell');
  assert.deepEqual(classifyNat({ ...sampled([chrome(40000)], ['stun:b.invalid:3478']), servers: 2, complete: true }), { type: 'unknown', delta: 0 });
  assert.deepEqual(classifyNat({ ...sampled([chrome(40000)]), servers: 2, complete: false }), { type: 'unknown', delta: 0 }, 'gathering still running');
  assert.deepEqual(classifyNat({ samples: [], servers: 3, complete: true }), { type: 'unknown', delta: 0 });
});

test('ports a small regular step apart are sequential, in any arrival order; wide gaps are random', () => {
  assert.deepEqual(classifyNat({ ...sampled([chrome(40003), chrome(40001), chrome(40002)]), servers: 3, complete: true }), { type: 'sequential', delta: 1 });
  assert.deepEqual(classifyNat({ ...sampled([firefox(50002), firefox(50006)]), servers: 2, complete: true }), { type: 'sequential', delta: 4 });
  assert.deepEqual(classifyNat({ ...sampled([safari(41000), safari(41002), safari(41004)]), servers: 3, complete: true }), { type: 'sequential', delta: 2 });
  assert.deepEqual(classifyNat({ ...sampled([chrome(40001), chrome(51234)]), servers: 2, complete: true }), { type: 'random', delta: 0 });
  assert.deepEqual(classifyNat({ ...sampled([chrome(40001), chrome(40001 + 17)]), servers: 2, complete: true }), { type: 'random', delta: 0 });
});

test('only UDP IPv4 srflx candidates count; sockets that disagree make it unknown', () => {
  const ignored = sampled(['candidate:1 1 udp 2122260223 10.0.0.1 5000 typ host', 'candidate:2 1 udp 1 2001:db8::1 40001 typ srflx raddr :: rport 0',
    'candidate:3 1 tcp 1 203.0.113.10 9 typ srflx raddr 10.0.0.1 rport 9 tcptype active', 'candidate:4 1 udp 1 203.0.113.10 40002 typ relay raddr 1.2.3.4 rport 1']);
  assert.deepEqual(ignored.samples, []);
  const twoSockets = sampled([chrome(40000, 1111), chrome(40000, 1111), chrome(45000, 2222), chrome(45001, 2222)]);
  assert.deepEqual(classifyNat({ ...twoSockets, servers: 2, complete: true }), { type: 'unknown', delta: 0 });
});

test('a peer\'s advertised NAT is validated before use', () => {
  assert.deepEqual(cleanNat({ type: 'sequential', delta: 3 }), { type: 'sequential', delta: 3 });
  assert.deepEqual(cleanNat({ type: 'eim', delta: 0 }), { type: 'eim', delta: 0 });
  assert.deepEqual(cleanNat({ type: 'random' }), { type: 'random', delta: 0 });
  for (const bad of [null, 'eim', { type: 'unknown', delta: 0 }, { type: 'sequential', delta: 0 }, { type: 'sequential', delta: 17 }, { type: 'sequential', delta: 1.5 }, { type: 'eim', delta: 2 }, { type: 'full-cone' }])
    assert.equal(cleanNat(bad), null, JSON.stringify(bad));
});

const init = (text, ufrag = 'abcd') => ({ candidate: text, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: ufrag });

test('predictions continue a sequential peer\'s ports from its highest srflx port, keeping the media line and ufrag', () => {
  const predict = createPredictor({ count: 3 });
  const first = predict(init(chrome(40002)), { type: 'sequential', delta: 2 });
  assert.deepEqual(first.map(c => parseCandidate(c.candidate).port), [40004, 40006, 40008]);
  assert.ok(first.every(c => c.sdpMid === '0' && c.sdpMLineIndex === 0 && c.usernameFragment === 'abcd'));
  const parsed = parseCandidate(first[0].candidate);
  assert.equal(parsed.type, 'srflx'); assert.equal(parsed.foundation, '842163049p1'); assert.equal(parsed.priority, 1677729534);
  assert.deepEqual(parsed.extensions, ['generation', '0', 'ufrag', 'abcd', 'network-id', '1', 'network-cost', '10']);
  // A later real candidate raises the base; nothing already sent or real is repeated.
  const second = predict(init(chrome(40006)), { type: 'sequential', delta: 2 });
  assert.deepEqual(second.map(c => parseCandidate(c.candidate).port), [40010, 40012]);
});

test('prediction is bounded and only for sequential peers and UDP IPv4 srflx candidates', () => {
  const predict = createPredictor({ count: 16 });
  assert.equal(predict(init(chrome(40000)), { type: 'eim', delta: 0 }).length, 0);
  assert.equal(predict(init(chrome(40000)), null).length, 0);
  assert.equal(predict(init('candidate:1 1 udp 2122260223 10.0.0.1 5000 typ host'), { type: 'sequential', delta: 1 }).length, 0);
  let total = 0;
  for (const port of [40000, 40100, 40200]) total += predict(init(chrome(port)), { type: 'sequential', delta: 1 }).length;
  assert.equal(total, MAX_PREDICTED, 'at most 16 per generation');
  assert.equal(predict(init(chrome(40000), 'next'), { type: 'sequential', delta: 1 }).length, 16, 'a new generation starts fresh');
  const top = createPredictor({ count: 8 })(init(chrome(65533)), { type: 'sequential', delta: 1 });
  assert.deepEqual(top.map(c => parseCandidate(c.candidate).port), [65534, 65535]);
  assert.equal(createPredictor({ count: 99 })(init(chrome(1000), 'x'), { type: 'sequential', delta: 1 }).length, MAX_PREDICTED);
});
