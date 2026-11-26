// Remuxer (MSE buffers -> one WebM/MKV) against scenarios shaped like real players:
// YouTube-style AV1-in-fMP4 + Opus-in-WebM, seeks, quality switches, truncated captures.
// Every output is checked with ffprobe and fully decoded with ffmpeg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FIXTURES, hasFfmpeg, makeFixtures } from '../../scripts/make-fixtures.mjs';
import { loadMux } from '../helpers.mjs';

const skip = hasFfmpeg() ? false : 'ffmpeg not installed';
const mux = loadMux();
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'vep-mux-'));

const read = (f) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'mux', f)));
const cat = (arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) out.set(a, o), (o += a.length);
  return out;
};

/** Splits fragmented MP4 into init (ftyp+moov) and fragments (moof+mdat), as MSE receives them. */
function splitMp4(b) {
  const boxes = [];
  for (let o = 0; o + 8 <= b.length; ) {
    const size = ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
    boxes.push({ type: String.fromCharCode(...b.subarray(o + 4, o + 8)), bytes: b.subarray(o, o + size) });
    o += size;
  }
  const init = cat(boxes.filter((x) => x.type === 'ftyp' || x.type === 'moov').map((x) => x.bytes));
  const frags = [];
  boxes.forEach((x, i) => x.type === 'moof' && frags.push(cat([x.bytes, boxes[i + 1].bytes])));
  return { init, frags };
}

function probe(file) {
  const j = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_name,codec_type', '-of', 'json', file]).toString()
  );
  let errors = '';
  try {
    errors = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    errors = String(e.stderr);
  }
  return {
    format: j.format.format_name,
    duration: Number(j.format.duration),
    codecs: j.streams.map((s) => s.codec_name),
    types: j.streams.map((s) => s.codec_type),
    decodeErrors: errors.trim().split('\n').filter(Boolean).length,
  };
}

function remux(name, captures) {
  const r = mux.remux(captures);
  const file = path.join(OUT, `${name}.${r.ext}`);
  fs.writeFileSync(file, cat(r.chunks));
  return { r, p: probe(file) };
}

const one = (bytes) => ({ runs: [{ parts: [{ bytes, offset: 0 }] }] });
const near = (actual, expected, tol = 0.6) =>
  assert.ok(Math.abs(actual - expected) <= tol, `duration ${actual.toFixed(2)}s, expected ~${expected}s`);

test('remuxer', { skip }, async (t) => {
  makeFixtures({ only: 'mux/' });
  const av1 = read('v_av1.mp4');
  const opus = read('a_opus.webm');
  const s = splitMp4(av1);

  await t.test('AV1 in fMP4 + Opus in WebM become one WebM', () => {
    const { r, p } = remux('av1-opus', [one(av1), one(opus)]);
    assert.equal(r.ext, 'webm');
    assert.deepEqual(p.codecs.sort(), ['av1', 'opus']);
    near(p.duration, 20);
    assert.equal(p.decodeErrors, 0);
  });

  await t.test('overlapping, out-of-order parts after a seek', () => {
    const video = {
      runs: [{
        parts: [
          { bytes: cat([s.init, ...s.frags.slice(5)]), offset: 0 },
          { bytes: cat([s.init, ...s.frags.slice(0, 7)]), offset: 0 },
        ],
      }],
    };
    const { r, p } = remux('seek', [video, one(opus)]);
    near(p.duration, 20);
    assert.equal(r.tracks[0].gaps, 0);
    assert.equal(p.decodeErrors, 0);
  });

  await t.test('quality switch mid-stream (480p -> 720p)', () => {
    const hi = splitMp4(read('v_av1_720.mp4'));
    const half = Math.floor(s.frags.length / 2);
    const video = {
      runs: [
        { parts: [{ bytes: cat([s.init, ...s.frags.slice(0, half)]), offset: 0 }] },
        { parts: [{ bytes: cat([hi.init, ...hi.frags.slice(half)]), offset: 0 }] },
      ],
    };
    const { r, p } = remux('abr', [video, one(opus)]);
    near(p.duration, 20);
    assert.equal(r.tracks[0].gaps, 0);
    assert.equal(p.decodeErrors, 0);
  });

  await t.test('H.264 with B-frames + AAC become MKV', () => {
    const { r, p } = remux('h264-aac', [one(read('v_h264.mp4')), one(read('a_aac.mp4'))]);
    assert.equal(r.ext, 'mkv');
    assert.deepEqual(p.codecs.sort(), ['aac', 'h264']);
    near(p.duration, 20);
    assert.equal(p.decodeErrors, 0);
  });

  await t.test('VP9 WebM + Opus WebM', () => {
    const { p } = remux('vp9-opus', [one(read('v_vp9.webm')), one(opus)]);
    assert.ok(p.codecs.includes('vp9'));
    near(p.duration, 20);
    assert.equal(p.decodeErrors, 0);
  });

  await t.test('partial capture cut in the middle of a box', () => {
    const partial = cat([s.init, ...s.frags.slice(0, 3)]);
    const { p } = remux('truncated', [one(partial.subarray(0, partial.length - 5000)), one(opus.subarray(0, 60000))]);
    assert.ok(p.duration > 1);
    assert.equal(p.decodeErrors, 0);
  });

  await t.test('audio only', () => {
    const { p } = remux('audio-only', [one(opus)]);
    assert.ok(!p.types.includes('video'));
    near(p.duration, 20);
  });
});
