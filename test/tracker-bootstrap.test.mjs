// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {TrackerClient} from '../src/client/tracker-client.mjs';

test('a missed introduction gets bounded early retries instead of waiting for the tracker interval', async () => {
  const messages = [];
  class Socket {
    readyState = 0;
    constructor() { queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    send(text) { messages.push(JSON.parse(text)); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  let needsIntroduction = true;
  const tracker = new TrackerClient('wss://tracker.example', {
    room: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    peer: 'A'.repeat(22),
    hello: async () => 'sealed-hello',
    needsIntroduction: () => needsIntroduction,
    bootstrapMs: [10, 25, 40],
    announceMs: 120000,
    WebSocketImpl: Socket,
  });
  try {
    tracker.connect();
    await new Promise(resolve => setTimeout(resolve, 32));
    assert.equal(messages.filter(m => m.offers).length, 3, 'initial announce plus two recovery attempts');
    needsIntroduction = false;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(messages.filter(m => m.offers).length, 3, 'retries stop once another member is known');
  } finally {
    tracker.close();
  }
});
