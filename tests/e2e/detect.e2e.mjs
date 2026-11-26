// A page with a progressive MP4, an HLS master and a DASH manifest:
// detection, thumbnails, in-popup preview and downloads, in a real browser.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { hasFfmpeg } from '../../scripts/make-fixtures.mjs';
import { launch, listFiles, serve, shot, sleep, waitFor } from './harness.mjs';

const skip = hasFfmpeg() ? false : 'ffmpeg not installed (needed for fixtures)';
const DOWNLOADS = path.join(os.tmpdir(), 'vep-e2e-detect');

const PAGE = `<!doctype html><html><head><title>Sample media page</title></head><body>
<video id="v" src="/media/clip.mp4" controls muted width="320"></video>
<script>
  document.getElementById('v').play().catch(() => {});
  fetch('/media/hls/master.m3u8');
  fetch('/media/dash/manifest.mpd');
</script></body></html>`;

let server, ctx, page, popup;

before(async () => {
  if (skip) return;
  server = await serve({ '/test.html': PAGE });
  ctx = await launch({ downloads: DOWNLOADS });
  page = await ctx.browser.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${server.origin}/test.html`, { waitUntil: 'load' });
  await sleep(4000);
  popup = await ctx.openPopup(server.origin);
});

after(async () => {
  await ctx?.browser.close();
  server?.close();
});

test('the page keeps working with the hooks installed', { skip }, () => {
  assert.deepEqual(page.errors, []);
});

test('detects the MP4, the HLS master and the DASH manifest', { skip }, async () => {
  const kinds = await waitFor(async () => {
    const k = await popup.$$eval('.card .badge[class*="kind-"]', (els) => els.map((e) => e.textContent));
    return ['HLS', 'DASH', 'Arquivo'].every((x) => k.includes(x)) && k;
  });
  assert.ok(kinds, 'expected HLS, DASH and Arquivo cards');
});

test('generates a thumbnail for each item', { skip }, async () => {
  const thumbs = await waitFor(
    async () => (await popup.$$eval('.card .thumb img', (els) => els.filter((e) => e.naturalWidth > 0).length)) >= 3,
    { timeout: 30000 }
  );
  assert.ok(thumbs, 'expected 3 thumbnails');
  await shot(popup, 'popup-list');
});

test('the preview player plays every item', { skip }, async () => {
  const labels = await popup.$$eval('.card', (els) => els.map((e) => e.querySelector('.badge[class*="kind-"]').textContent));
  for (let i = 0; i < labels.length; i++) {
    await (await popup.$$('.card .thumb'))[i].click();
    const st = await waitFor(
      () => popup.evaluate(() => {
        const v = document.getElementById('playerVideo');
        return v.currentTime > 1 && v.videoWidth > 0 && { t: v.currentTime, w: v.videoWidth };
      }),
      { timeout: 12000, interval: 400 }
    );
    assert.ok(st, `preview of ${labels[i]} did not play`);
    if (labels[i] === 'HLS') await shot(popup, 'popup-preview');
  }
  await popup.click('#playerClose');
});

test('downloads all three', { skip }, async () => {
  await popup.click('#selectAll');
  await popup.click('#btnDownloadSelected');
  const jobs = await waitFor(async () => {
    const j = await ctx.sw.evaluate(async () => (await chrome.storage.session.get('vep_jobs')).vep_jobs || []);
    return j.length >= 3 && j.every((x) => x.status === 'done' || x.status === 'error') && j;
  }, { timeout: 30000 });
  assert.ok(jobs, 'jobs did not finish');
  for (const j of jobs) assert.equal(j.status, 'done', `${j.kind}: ${j.error || ''}`);
  await sleep(2500);
  assert.ok(listFiles(DOWNLOADS).length >= 3, 'files on disk');
  assert.deepEqual(popup.errors, []);
});
