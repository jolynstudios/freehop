// SPDX-License-Identifier: Apache-2.0
// Run against a built site. Only this test substitutes a local gate; production demos use public trackers.
// Exercises the real room API, peer media, live call controls, Hopper lobby and chat.
import {chromium} from 'playwright';
import {createGate} from '../../src/gate/gate.mjs';
import {mkdir, writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const evidence = new URL('../evidence/site-smoke/', import.meta.url);
await mkdir(evidence, {recursive: true});
const gate = await createGate({host: '127.0.0.1', port: 0});
const browser = await chromium.launch({
  headless: true,
  // Rendering is checked separately; this test exercises calling controls.
  args: ['--disable-webgl', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({viewport: {width: 1440, height: 1000}, permissions: ['camera', 'microphone'], reducedMotion: 'reduce'});
const errors = [];
const results = [];
context.setDefaultNavigationTimeout(60000);
await context.route('**/lib/client/peerlane.mjs', async (route) => {
  await route.fulfill({
    contentType: 'text/javascript',
    body: `export * from './room.mjs';export {PHASE} from './peer.mjs';export {deriveRoom,randomId} from './crypto.mjs';import {join as originalJoin} from './room.mjs';export async function join(options){const room=await originalJoin({...options,gates:[${JSON.stringify(gate.url())}],stun:[]});window.__room=room;window.__messages=[];room.on('message',message=>window.__messages.push(message));return room;}`,
  });
});
const [a, b] = await Promise.all([context.newPage(), context.newPage()]);
for (const page of [a, b]) page.on('pageerror', (e) => errors.push(e.message));
const base = (process.argv[2] || 'http://127.0.0.1:4173/freehop/').replace(/\/?$/, '/');
try {
  await a.goto(base + 'demo', {waitUntil: 'domcontentloaded'});
  await a.getByRole('button', {name: /Join with camera and microphone/}).click();
  await a.getByRole('button', {name: 'Leave', exact: true}).waitFor();
  await b.goto(a.url(), {waitUntil: 'domcontentloaded'});
  await b.getByRole('button', {name: /Join with camera and microphone/}).click();
  for (const page of [a, b]) {
    await page.waitForFunction(() => !!window.__room);
    let received = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      received = await page.evaluate(async () => {
        const stats = await window.__room.stats();
        return stats.links.some((link) => link.media?.inbound?.video?.frames > 0 && link.media?.inbound?.audio?.packets > 0);
      });
      if (received) break;
      await page.waitForTimeout(250);
    }
    assert.ok(received, 'Remote audio and video must arrive');
  }
  results.push('live demo: two real peers receive audio and video');
  await a.evaluate(() => window.__room.send({type: 'sdk-check', ready: true}));
  await b.waitForFunction(() => window.__messages.some((m) => m.data?.type === 'sdk-check'));
  await a.getByRole('button', {name: 'Mute microphone', exact: true}).click();
  await a.getByRole('button', {name: 'Unmute microphone', exact: true}).waitFor();
  await a.getByRole('button', {name: 'Turn camera off', exact: true}).click();
  await a.getByRole('button', {name: 'Turn camera on', exact: true}).waitFor();
  results.push('live demo: messages, microphone and camera controls');
  await a.screenshot({path: new URL('live-call.png', evidence).pathname, fullPage: true});
  await a.getByRole('button', {name: 'Leave', exact: true}).click();
  await b.getByRole('button', {name: 'Leave', exact: true}).click();
  await a.goto(base + 'hopper', {waitUntil: 'domcontentloaded'});
  await a.getByRole('button', {name: 'Create squad room', exact: true}).click();
  await a.locator('#hopper-name').fill('Builder One');
  await a.screenshot({path: new URL('hopper-lobby.png', evidence).pathname, fullPage: true});
  const invite = a.url();
  await a.getByRole('button', {name: 'Join now', exact: true}).click();
  await a.getByRole('button', {name: 'Leave the room', exact: true}).waitFor({timeout: 25000});
  await b.goto(invite, {waitUntil: 'domcontentloaded'});
  await b.locator('#hopper-name').fill('Builder Two');
  await b.getByRole('button', {name: 'Join now', exact: true}).click();
  await b.getByRole('button', {name: 'Leave the room', exact: true}).waitFor({timeout: 25000});
  await a.getByRole('button', {name: 'Chat', exact: true}).click();
  await a.locator('#hopper-chat').fill('Ready to build');
  await a.getByRole('button', {name: 'Send message', exact: true}).click();
  await b.getByText('Ready to build', {exact: true}).waitFor({timeout: 25000});
  results.push('Hopper lobby, two-person call and chat delivery');
  await a.screenshot({path: new URL('hopper-call.png', evidence).pathname, fullPage: true});
  await a.getByRole('button', {name: 'Leave the room', exact: true}).click();
  await b.getByRole('button', {name: 'Leave the room', exact: true}).click();
  await a.getByRole('button', {name: 'Rejoin', exact: true}).click();
  await a.getByRole('button', {name: 'Leave the room', exact: true}).waitFor();
  await a.getByRole('button', {name: 'Leave the room', exact: true}).click();
  results.push('Hopper leave/rejoin flow');
  assert.equal(errors.length, 0, JSON.stringify(errors));
} catch (e) {
  console.error(e);
  await a.screenshot({path: new URL('interaction-failure.png', evidence).pathname, fullPage: true, timeout: 5000}).catch(() => {});
  process.exitCode = 1;
} finally {
  console.log(JSON.stringify({results, errors}, null, 2));
  await writeFile(new URL('interactions.json', evidence).pathname, JSON.stringify({results, errors}, null, 2));
  await browser.close();
  await gate.close();
}
