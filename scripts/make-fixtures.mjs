// Generates the synthetic test media (color bars + sine tone) used by the tests.
// Nothing copyrighted, nothing downloaded: everything comes out of ffmpeg's lavfi.
//
//   node scripts/make-fixtures.mjs          # only what's missing
//   node scripts/make-fixtures.mjs --force  # regenerate everything
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const force = process.argv.includes('--force');

const SRC = ['-f', 'lavfi', '-i', 'testsrc2=size=854x480:rate=30:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=20'];
const FRAG = ['-movflags', 'frag_keyframe+empty_moov+default_base_moof'];

/** [output, ffmpeg args...]; a function runs instead of ffmpeg. */
const JOBS = [
  // Remuxer inputs: what an MSE player appends to its SourceBuffers.
  ['mux/v_av1.mp4', ...SRC, '-map', '0:v', '-c:v', 'libsvtav1', '-preset', '12', '-g', '60', ...FRAG],
  ['mux/v_av1_720.mp4', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=20', '-c:v', 'libsvtav1', '-preset', '12', '-g', '60', ...FRAG],
  ['mux/a_opus.webm', ...SRC, '-map', '1:a', '-c:a', 'libopus', '-b:a', '96k', '-f', 'webm', '-cluster_time_limit', '2000'],
  ['mux/v_h264.mp4', ...SRC, '-map', '0:v', '-c:v', 'libx264', '-bf', '2', '-g', '60', '-pix_fmt', 'yuv420p', ...FRAG],
  ['mux/a_aac.mp4', ...SRC, '-map', '1:a', '-c:a', 'aac', ...FRAG],
  ['mux/v_vp9.webm', ...SRC, '-map', '0:v', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-g', '60', '-f', 'webm'],

  // Page media for the end-to-end tests.
  ['media/clip.mp4', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart'],
  ['media/hls/index.m3u8', '-i', '{media/clip.mp4}', '-c', 'copy', '-f', 'hls', '-hls_time', '3', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', '{media/hls}/seg%03d.ts'],
  ['media/hls/master.m3u8', () =>
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.640028,mp4a.40.2"\nindex.m3u8\n'],
  ['media/dash/manifest.mpd', '-i', '{media/clip.mp4}', '-c', 'copy', '-f', 'dash', '-seg_duration', '3', '-use_template', '1', '-use_timeline', '1'],
  // 90s stream: the player only buffers ~30s of it, so "Capture all" has to fetch the rest.
  ['media/long/index.m3u8', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=90', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=90',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_filename', '{media/long}/s%03d.ts'],
];

export function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function makeFixtures({ only } = {}) {
  if (!hasFfmpeg()) throw new Error('ffmpeg not found on PATH — it is needed to generate test media');
  for (const [out, ...rest] of JOBS) {
    if (only && !out.startsWith(only)) continue;
    const target = path.join(FIXTURES, out);
    if (!force && fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (typeof rest[0] === 'function') {
      fs.writeFileSync(target, rest[0]());
    } else {
      const args = rest.map((a) => a.replace(/\{([^}]+)\}/g, (_, p) => path.join(FIXTURES, p)));
      // Run from the output folder: on Windows the DASH muxer drops segments in the cwd otherwise.
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args, path.basename(target)], { stdio: 'inherit', cwd: path.dirname(target) });
    }
    console.log('  fixture', out);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  makeFixtures();
  console.log('fixtures ready in', path.relative(process.cwd(), FIXTURES) || '.');
}
