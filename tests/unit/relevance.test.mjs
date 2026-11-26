// The list should show what you can actually download and watch — nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterUseful } from '../../extension/src/background/relevance.js';

let n = 0;
const item = (kind, url, extra = {}) => ({ id: `i${++n}`, kind, url, ...extra });
const visibleUrls = (items, opts) => filterUseful(items, opts).visible.map((i) => i.url);

test('hides fragments, ads and tiny files', () => {
  const items = [
    item('file', 'https://cdn.example.com/movie.mp4', { size: 50e6 }),
    item('segment', 'https://cdn.example.com/seg1.m4s', { size: 1e6 }),
    item('file', 'https://pubads.g.doubleclick.net/ad.mp4', { size: 5e6 }),
    item('file', 'https://example.com/click-sound.mp4', { size: 20e3 }),
  ];
  const { visible, hidden } = filterUseful(items);
  assert.deepEqual(visible.map((i) => i.url), ['https://cdn.example.com/movie.mp4']);
  assert.equal(hidden, 3);
});

test('"show all" brings everything back, tagged with the reason', () => {
  const items = [item('segment', 'https://cdn.example.com/seg1.m4s'), item('file', 'https://cdn.example.com/m.mp4', { size: 9e6 })];
  const { visible, hidden } = filterUseful(items, { showAll: true });
  assert.equal(visible.length, 2);
  assert.equal(hidden, 0);
  assert.equal(visible.find((i) => i.kind === 'segment').hiddenReason, 'fragmento');
});

test('variant playlists of a listed HLS master are folded into it', () => {
  const master = item('hls', 'https://cdn.example.com/master.m3u8', {
    probeState: 'done',
    probe: {
      isMaster: true,
      variants: [{ url: 'https://cdn.example.com/720.m3u8' }, { url: 'https://cdn.example.com/1080.m3u8' }],
      audioRenditions: [{ url: 'https://cdn.example.com/audio.m3u8' }],
    },
  });
  const items = [
    master,
    item('hls', 'https://cdn.example.com/720.m3u8'),
    item('hls', 'https://cdn.example.com/1080.m3u8'),
    item('hls', 'https://cdn.example.com/audio.m3u8'),
  ];
  assert.deepEqual(visibleUrls(items), ['https://cdn.example.com/master.m3u8']);
});

test('the same file under different signed URLs is listed once (largest wins)', () => {
  const items = [
    item('file', 'https://cdn.example.com/v.mp4?sig=a', { size: 3e6 }),
    item('file', 'https://cdn.example.com/v.mp4?sig=b', { size: 40e6 }),
  ];
  assert.deepEqual(visibleUrls(items), ['https://cdn.example.com/v.mp4?sig=b']);
});

test('player captures: DRM, tiny and audio-only-next-to-video are hidden', () => {
  const items = [
    item('capture', 'vep-capture://example.com/g1', { size: 30e6, hasVideo: true }),
    item('capture', 'vep-capture://example.com/g2', { size: 5e6, hasVideo: false }),
    item('capture', 'vep-capture://example.com/g3', { size: 30e6, hasVideo: true, drm: 'Widevine' }),
    item('capture', 'vep-capture://example.com/g4', { size: 10e3, hasVideo: true }),
  ];
  assert.deepEqual(visibleUrls(items), ['vep-capture://example.com/g1']);
});

test('an expired manifest is hidden when a working one exists', () => {
  const items = [
    item('dash', 'https://cdn.example.com/a.mpd', { probeState: 'done' }),
    item('dash', 'https://cdn.example.com/old.mpd', { probeState: 'error' }),
  ];
  assert.deepEqual(visibleUrls(items), ['https://cdn.example.com/a.mpd']);
  // ...but kept when it's the only lead there is.
  assert.equal(visibleUrls([items[1]]).length, 1);
});

test('manifests first, then captures, then files; bigger first within a group', () => {
  const items = [
    item('file', 'https://cdn.example.com/small.mp4', { size: 2e6 }),
    item('file', 'https://cdn.example.com/big.mp4', { size: 90e6 }),
    item('capture', 'vep-capture://example.com/g1', { size: 30e6, hasVideo: true }),
    item('dash', 'https://cdn.example.com/a.mpd', { probeState: 'done' }),
  ];
  assert.deepEqual(visibleUrls(items), [
    'https://cdn.example.com/a.mpd',
    'vep-capture://example.com/g1',
    'https://cdn.example.com/big.mp4',
    'https://cdn.example.com/small.mp4',
  ]);
});
