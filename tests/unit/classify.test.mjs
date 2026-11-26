import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, findMediaUrlsInText, isPrimary, KIND } from '../../extension/src/lib/classify.js';

const kindOf = (url, mimeType = '', extra = {}) => classify({ url, mimeType, ...extra })?.kind ?? null;

test('progressive files and audio', () => {
  assert.equal(kindOf('https://cdn.example.com/movie.mp4'), KIND.FILE);
  assert.equal(kindOf('https://cdn.example.com/clip.webm?sig=abc'), KIND.FILE);
  assert.equal(kindOf('https://cdn.example.com/song.mp3'), KIND.AUDIO);
  assert.equal(kindOf('https://cdn.example.com/stream', 'video/mp4'), KIND.FILE);
  assert.equal(kindOf('https://cdn.example.com/stream', 'audio/aac'), KIND.AUDIO);
});

test('streaming manifests, by extension or by MIME', () => {
  assert.equal(kindOf('https://cdn.example.com/master.m3u8'), KIND.HLS);
  assert.equal(kindOf('https://cdn.example.com/x', 'application/vnd.apple.mpegurl'), KIND.HLS);
  assert.equal(kindOf('https://cdn.example.com/manifest.mpd'), KIND.DASH);
  assert.equal(kindOf('https://cdn.example.com/x', 'application/dash+xml; charset=utf-8'), KIND.DASH);
});

test('segments are segments, not downloads', () => {
  assert.equal(kindOf('https://cdn.example.com/seg-001.m4s'), KIND.SEGMENT);
  assert.equal(kindOf('https://cdn.example.com/seg001.ts', '', { contentLength: 400_000 }), KIND.SEGMENT);
  // A big .ts is a whole MPEG-TS recording.
  assert.equal(kindOf('https://cdn.example.com/recording.ts', '', { contentLength: 300 * 1024 * 1024 }), KIND.FILE);
});

test('proprietary player protocols (UMP/SABR) are never offered as files', () => {
  assert.equal(kindOf('https://rr1.example.com/videoplayback?id=1', 'application/vnd.yt-ump'), KIND.SEGMENT);
  assert.equal(kindOf('https://rr1.example.com/videoplayback?sabr=1&id=1'), KIND.SEGMENT);
  assert.equal(kindOf('https://rr1.example.com/videoplayback?id=1'), KIND.SEGMENT);
});

test('ignores data: URLs and things that are not media', () => {
  assert.equal(kindOf('data:video/mp4;base64,AAAA'), null);
  assert.equal(kindOf('https://example.com/app.js', 'application/javascript'), null);
  assert.equal(kindOf('https://example.com/logo.png', 'image/png'), null);
});

test('isPrimary keeps fragments out of the main list', () => {
  for (const k of [KIND.FILE, KIND.AUDIO, KIND.HLS, KIND.DASH, KIND.CAPTURE]) assert.ok(isPrimary(k), k);
  assert.ok(!isPrimary(KIND.SEGMENT));
});

test('finds media URLs inside JSON and escaped JS strings', () => {
  const text = JSON.stringify({ a: 'https://cdn.example.com/v/720.mp4?t=1', b: 'see https://x.example.com/live/index.m3u8' })
    + ' "https:\\/\\/cdn.example.com\\/a\\/b.mpd" https://example.com/page.html';
  const urls = findMediaUrlsInText(text);
  assert.ok(urls.some((u) => u.includes('720.mp4')));
  assert.ok(urls.some((u) => u.includes('index.m3u8')));
  assert.ok(urls.some((u) => u.includes('b.mpd')));
  assert.ok(!urls.some((u) => u.includes('page.html')));
});
