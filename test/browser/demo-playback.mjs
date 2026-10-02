// SPDX-License-Identifier: Apache-2.0
// Manual website regression: serve website/build, then pass its /freehop/ URL.
// Uses public trackers and fake capture devices, with normal Chromium autoplay policy.
// Force a playback denial on either joiner; RTP counters alone must not count as playback.
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {playwright, CHROMIUM_MEDIA_ARGS, waitUntil} from './lab.mjs';

const base = process.argv[2] ?? 'http://localhost:3000/freehop/';
const blocked = process.argv[3] === 'second' ? 1 : 0;
const evidence = new URL('../evidence/', import.meta.url);
await mkdir(evidence, {recursive: true});
const browsers = [], pages = [];
const report = {base, blockedJoiner: blocked + 1, checks: []};
const audioState = page => page.locator('audio').evaluateAll(elements => elements.map(el => ({
  paused: el.paused, tracks: el.srcObject?.getAudioTracks().length, time: el.currentTime
})));
try {
  for (let i = 0; i < 2; i++) {
    const browser = await playwright.chromium.launch({args: CHROMIUM_MEDIA_ARGS.filter(arg => !arg.startsWith('--autoplay-policy'))});
    browsers.push(browser);
    const context = await browser.newContext({permissions: ['camera', 'microphone']});
    const page = await context.newPage(); pages.push(page);
    if (i === blocked) await page.addInitScript(() => {
      window.testBlockRemoteAudio = true;
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (this instanceof HTMLAudioElement && window.testBlockRemoteAudio) {
          this.autoplay = false; this.pause();
          return Promise.reject(new DOMException('Simulated browser autoplay denial', 'NotAllowedError'));
        }
        return play.call(this);
      };
    });
  }
  const url = base + 'demo#' + randomBytes(16).toString('base64url');
  for (const page of pages) {
    await page.goto(url);
    await page.getByRole('button', {name: 'Microphone only', exact: true}).click();
    await page.waitForFunction(() => window.freehopDemo?.phase === 'live');
  }
  const bothHaveMedia = async kind => Promise.all(pages.map(page => page.evaluate(async kind => {
    const stats = await window.freehopDemo.stats();
    return stats.links.some(link => link.media.inbound[kind]?.packets > 50 && link.media.outbound[kind]?.packets > 50);
  }, kind))).then(results => results.every(Boolean));
  assert.ok(await waitUntil(() => bothHaveMedia('audio'), {timeoutMs: 90000}), 'Two-way audio RTP');
  report.before = await Promise.all(pages.map(audioState));
  assert.equal(report.before[blocked][0].paused, true);
  report.checks.push('Audio arrives in both directions even while one receiver cannot play it');

  const page = pages[blocked];
  const enable = page.getByRole('button', {name: 'Enable sound', exact: true});
  await enable.waitFor();
  await page.setViewportSize({width: 390, height: 900});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({path: new URL(`demo-playback-${blocked}-mobile.png`, evidence).pathname, fullPage: true});
  await page.evaluate(() => {window.testBlockRemoteAudio = false;});
  await enable.click();
  await page.waitForFunction(() => {const audio = document.querySelector('audio'); return audio && !audio.paused && audio.currentTime > 0;});
  await enable.waitFor({state: 'hidden'});
  report.checks.push('Enable sound recovers playback from a user gesture');

  await Promise.all(pages.map(p => p.evaluate(() => {window.audioBeforeCamera = document.querySelector('audio').srcObject;})));
  for (const p of pages) {
    await p.getByRole('button', {name: 'Turn camera on', exact: true}).click();
    await p.waitForFunction(() => window.freehopDemo.cam);
  }
  assert.ok(await waitUntil(() => bothHaveMedia('video'), {timeoutMs: 30000}), 'Two-way video arrives after cameras start');
  report.after = await Promise.all(pages.map(audioState));
  assert.ok(report.after.every(list => list.length === 1 && !list[0].paused && list[0].tracks === 1));
  for (const p of pages) assert.equal(await p.evaluate(() => document.querySelector('audio').srcObject === window.audioBeforeCamera), true);
  report.checks.push('Camera negotiation preserves the already-playing audio attachment');

  await page.locator('audio').evaluate(el => el.pause());
  await page.getByRole('button', {name: 'Retry sound', exact: true}).click();
  await page.waitForFunction(() => !document.querySelector('audio').paused);
  report.checks.push('An unexpected playback pause offers recovery too');
  for (const p of pages) await p.getByRole('button', {name: 'Leave', exact: true}).click();
  report.passed = true;
} finally {
  await writeFile(new URL(`demo-playback-${blocked}.json`, evidence), JSON.stringify(report, null, 2));
  for (const browser of browsers) await browser.close();
}
console.log(JSON.stringify(report, null, 2));
