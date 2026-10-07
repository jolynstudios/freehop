// SPDX-License-Identifier: Apache-2.0
// Run against a built site. Only this test substitutes a local gate; production demos use public trackers.
// Exercises the real room API, peer media, game controls, Hopper lobby and chat.
import {chromium} from 'playwright';
import {createGate} from '../../src/gate/gate.mjs';
import {mkdir, writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const evidence = new URL('../evidence/site-smoke/', import.meta.url);
await mkdir(evidence, {recursive: true});
const gate = await createGate({host: '127.0.0.1', port: 0});
const browser = await chromium.launch({
  headless: true,
  // Exercise the map fallback too; visual WebGL checks run separately.
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
  await a.goto(base + 'maze#abcdefghijklmnopqrstuv', {waitUntil: 'domcontentloaded'});
  await a.getByRole('img', {name: /3D maze/}).waitFor();
  await a.getByRole('button', {name: 'Move right', exact: true}).click();
  assert.match(await a.getByRole('img', {name: /3D maze/}).getAttribute('aria-label'), /Your position: 2, 1/);
  await a.getByRole('button', {name: 'Move up', exact: true}).click();
  assert.match(await a.getByRole('img', {name: /3D maze/}).getAttribute('aria-label'), /Your position: 2, 1/);
  results.push('solo movement and wall collision');
  await a.getByRole('button', {name: 'Switch to map', exact: true}).click();
  await a.getByRole('button', {name: 'Join game room', exact: true}).click();
  await a.getByRole('button', {name: 'Leave call', exact: true}).waitFor();
  await b.goto(a.url(), {waitUntil: 'domcontentloaded'});
  await b.getByRole('button', {name: 'Switch to map', exact: true}).click();
  await b.getByRole('button', {name: 'Join game room', exact: true}).click();
  await Promise.all([a.getByText('2 connected', {exact: true}).waitFor({timeout: 25000}), b.getByText('2 connected', {exact: true}).waitFor({timeout: 25000})]);
  await a.evaluate(() => window.__room.send({type: 'maze-position', x: 5, y: 1}));
  await b.waitForFunction(() => window.__messages.some((m) => m.data?.x === 5 && m.data?.y === 1));
  results.push('two real local-gate peers, encrypted position messages');
  await a.getByRole('button', {name: 'Turn mic on', exact: true}).click();
  await a.getByRole('button', {name: 'Turn camera on', exact: true}).click();
  await b.waitForFunction(
    () => [...document.querySelectorAll('video')].some((v) => v.videoWidth > 0 && v.srcObject?.getVideoTracks().length > 0),
    {},
    {timeout: 20000},
  );
  results.push('camera and microphone toggles; remote video playback');
  await a.getByRole('button', {name: 'Adaptive on', exact: true}).click();
  await a.getByRole('button', {name: 'Adaptive off', exact: true}).waitFor();
  await b.screenshot({path: new URL('maze-connected.png', evidence).pathname, fullPage: true});
  await a.getByRole('button', {name: 'Leave call', exact: true}).click();
  await b.getByText('1 connected', {exact: true}).waitFor();
  results.push('adaptive toggle and peer departure');
  await b.getByRole('button', {name: 'Leave call', exact: true}).click();
  await a.goto(base + 'orbital', {waitUntil: 'domcontentloaded'});
  await a.getByRole('button', {name: 'Move right', exact: true}).waitFor();
  for (let i = 0; i < 6; i++) await a.getByRole('button', {name: 'Move right', exact: true}).click();
  for (let i = 0; i < 3; i++) await a.getByRole('button', {name: 'Move down', exact: true}).click();
  await a.getByText('Beacons collected: 1', {exact: true}).waitFor();
  results.push('Orbital collectible score and target progression');
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
