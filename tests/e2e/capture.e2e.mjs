// MSE capture with a real player (hls.js) that only buffers ~30s of a 90s stream:
// "Capture all" has to fetch the rest, and the saved file must hold video + audio.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { hasFfmpeg } from '../../scripts/make-fixtures.mjs';
import { launch, listFiles, serve, shot, sleep, waitFor } from './harness.mjs';

const skip = hasFfmpeg() ? false : 'ffmpeg not installed (needed for fixtures)';
const DOWNLOADS = path.join(os.tmpdir(), 'vep-e2e-capture');

const PAGE = `<!doctype html><html><head><title>Sample MSE player</title>
<script src="/hls.min.js"></script></head><body>
<video id="v" muted autoplay width="480"></video>
<script>
  const hls = new Hls({ maxBufferLength: 20, maxMaxBufferLength: 30 });
  hls.loadSource('/media/long/index.m3u8');
  hls.attachMedia(document.getElementById('v'));
  hls.on(Hls.Events.MANIFEST_PARSED, () => document.getElementById('v').play());
</script></body></html>`;

let server, ctx, page, popup;

const card = () =>
  popup.evaluate(() => {
    const c = [...document.querySelectorAll('.card')].find((x) => x.querySelector('.kind-capture'));
    return c && {
      badges: [...c.querySelectorAll('.badge')].map((b) => b.textContent),
      buttons: [...c.querySelectorAll('.card-actions button')].map((b) => b.textContent),
      thumb: Boolean(c.querySelector('.thumb img')),
    };
  });
const click = (label) =>
  popup.evaluate((label) => {
    const c = [...document.querySelectorAll('.card')].find((x) => x.querySelector('.kind-capture'));
    const b = [...c.querySelectorAll('.card-actions button')].find((x) => x.textContent.includes(label));
    b?.click();
    return Boolean(b);
  }, label);

before(async () => {
  if (skip) return;
  server = await serve({ '/mse.html': PAGE });
  ctx = await launch({ downloads: DOWNLOADS });
  page = await ctx.browser.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${server.origin}/mse.html`);
  await sleep(6000);
  popup = await ctx.openPopup(`${server.origin}/mse`);
});

after(async () => {
  await ctx?.browser.close();
  server?.close();
});

test('one capture item with video + audio and a thumbnail', { skip }, async () => {
  const c = await waitFor(card);
  assert.ok(c, 'capture card');
  assert.ok(c.badges.some((b) => b.includes('vídeo') && b.includes('áudio')), c.badges.join(' | '));
  assert.ok(c.thumb);
  assert.ok(c.buttons.some((b) => b.includes('Capturar inteiro')), 'offers "Capture all" while partial');
  await shot(popup, 'popup-capture');
});

test('"Capture all" fetches the whole 90s and restores the player', { skip, timeout: 200000 }, async () => {
  assert.ok(await click('Capturar inteiro'));
  await sleep(4000);
  const done = await waitFor(async () => {
    const c = await card();
    return c && !c.badges.includes('CAPTURANDO') && c;
  }, { timeout: 180000, interval: 2000 });
  assert.ok(done, 'capture did not finish');
  const progress = done.badges.find((b) => / de /.test(b));
  assert.match(progress, /^1:(29|3\d) de 1:30$/);
  assert.equal(await page.evaluate(() => document.getElementById('v').playbackRate), 1);
});

test('saves one file with 90s of video + audio that decodes cleanly', { skip, timeout: 120000 }, async () => {
  assert.ok(await click('vídeo + áudio'));
  const toast = await waitFor(
    () => popup.$eval('#toast', (e) => e.classList.contains('show') && e.textContent),
    { timeout: 40000 }
  );
  assert.match(String(toast), /^Salvo/);
  await sleep(4000);
  const files = listFiles(DOWNLOADS);
  assert.equal(files.length, 1, files.join(', '));

  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', files[0]]).toString());
  const types = j.streams.map((s) => s.codec_type);
  assert.ok(Number(j.format.duration) > 88, `duration ${j.format.duration}`);
  assert.ok(types.includes('video') && types.includes('audio'), types.join('+'));
  let errors = '';
  try {
    errors = execFileSync('ffmpeg', ['-v', 'error', '-i', files[0], '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    errors = String(e.stderr);
  }
  assert.equal(errors.trim(), '');
  assert.deepEqual([...page.errors, ...popup.errors], []);
});
