// HLS and DASH parsers, including the DRM detection that blocks protected content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { parseM3U8 } from '../../extension/src/lib/m3u8.js';
import { parseISODuration, parseMPD } from '../../extension/src/lib/mpd.js';

const BASE = 'https://cdn.example.com/show/';
const xml = (s) => new DOMParser().parseFromString(s, 'text/xml');

test('HLS master: variants, audio renditions, relative URLs', () => {
  const p = parseM3U8(
    [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",URI="audio/en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud"',
      '360p.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"',
      'https://other.example.com/1080p.m3u8',
    ].join('\n'),
    BASE + 'master.m3u8'
  );
  assert.equal(p.type, 'master');
  const byHeight = Object.fromEntries(p.variants.map((v) => [v.height, v]));
  assert.deepEqual(Object.keys(byHeight).sort(), ['1080', '360']);
  assert.equal(byHeight[360].url, BASE + '360p.m3u8');
  assert.equal(byHeight[1080].url, 'https://other.example.com/1080p.m3u8');
  assert.equal(p.audioRenditions[0].url, BASE + 'audio/en.m3u8');
});

test('HLS media playlist: segments, duration, AES-128 key', () => {
  const p = parseM3U8(
    [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001',
      '#EXTINF:4.0,',
      'seg0.ts',
      '#EXTINF:3.5,',
      'seg1.ts',
      '#EXT-X-ENDLIST',
    ].join('\n'),
    BASE + 'index.m3u8'
  );
  assert.equal(p.type, 'media');
  assert.equal(p.encrypted, true);
  assert.equal(p.segments.length, 2);
  assert.equal(p.segments[1].url, BASE + 'seg1.ts');
  assert.ok(Math.abs(p.duration - 7.5) < 1e-9);
  assert.equal(p.segments[0].key?.method, 'AES-128');
  assert.ok(!p.drm, 'AES-128 with a reachable key is not DRM');
});

test('HLS with SAMPLE-AES is flagged as DRM', () => {
  const p = parseM3U8(
    ['#EXTM3U', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://abc",KEYFORMAT="com.apple.streamingkeydelivery"', '#EXTINF:4,', 's.ts'].join('\n'),
    BASE + 'index.m3u8'
  );
  assert.ok(p.drm);
});

test('rejects text that is not a playlist', () => {
  assert.throws(() => parseM3U8('<html></html>', BASE));
});

test('ISO 8601 durations', () => {
  assert.equal(parseISODuration('PT1H2M3.5S'), 3723.5);
  assert.equal(parseISODuration('PT90S'), 90);
  assert.equal(parseISODuration(''), 0);
});

const MPD = (protection = '') => `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">${protection}
      <SegmentTemplate initialization="v-$RepresentationID$-init.m4s" media="v-$RepresentationID$-$Number$.m4s" startNumber="1" duration="3" timescale="1"/>
      <Representation id="360" bandwidth="800000" width="640" height="360" codecs="avc1.64001e"/>
      <Representation id="720" bandwidth="2500000" width="1280" height="720" codecs="avc1.64001f"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <SegmentTemplate initialization="a-init.m4s" media="a-$Number$.m4s" startNumber="1" duration="3" timescale="1"/>
      <Representation id="aac" bandwidth="128000" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>
</MPD>`;

test('DASH: representations and SegmentTemplate expansion', () => {
  const p = parseMPD(xml(MPD()), BASE + 'manifest.mpd');
  assert.equal(p.duration, 12);
  const reps = p.representations;
  assert.equal(reps.length, 3);
  const v720 = reps.find((r) => r.height === 720);
  assert.equal(v720.init.url, BASE + 'v-720-init.m4s');
  assert.equal(v720.segments.length, 4);
  assert.equal(v720.segments[3].url, BASE + 'v-720-4.m4s');
  assert.ok(!p.drm);
});

test('DASH with Widevine ContentProtection is flagged as DRM', () => {
  const prot = '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>';
  const p = parseMPD(xml(MPD(prot)), BASE + 'manifest.mpd');
  assert.match(String(p.drm), /widevine/i);
});
