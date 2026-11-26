// Classificacao de midia a partir de URL / MIME / cabecalhos.

export const KIND = {
  FILE: 'file',        // arquivo progressivo (mp4, webm, mkv...)
  HLS: 'hls',          // playlist m3u8
  DASH: 'dash',        // manifest mpd
  SEGMENT: 'segment',  // fragmento de stream (ts, m4s, aac...)
  AUDIO: 'audio',      // audio progressivo
  IMAGE_SEQ: 'other',
  OTHER: 'other',
  CAPTURE: 'capture',  // gravado via MediaSource (blob)
};

const VIDEO_EXT = new Set([
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'flv', 'f4v', 'wmv', 'mpg', 'mpeg',
  '3gp', '3g2', 'ogv', 'ts', 'mts', 'm2ts', 'vob', 'asf', 'rm', 'rmvb', 'divx',
]);

const AUDIO_EXT = new Set([
  'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'wma', 'weba',
]);

const SEGMENT_EXT = new Set(['ts', 'm4s', 'm4f', 'mp4f', 'dash', 'cmfv', 'cmfa', 'fmp4', 'seg']);

const PLAYLIST_EXT = new Set(['m3u8', 'm3u']);
const DASH_EXT = new Set(['mpd']);
const SMOOTH_EXT = new Set(['ism', 'isml']);

const VIDEO_MIME = /^(video\/|application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml|x-matroska|octet-stream-video))/i;
const AUDIO_MIME = /^audio\//i;
const HLS_MIME = /(mpegurl|m3u8)/i;
const DASH_MIME = /(dash\+xml|vnd\.mpeg\.dash\.mpd)/i;

/** Heuristica para URLs sem extensao (ex.: /videoplayback?..., /segment/123). */
const URL_HINTS = [
  { re: /\/videoplayback(\?|$)/i, kind: KIND.SEGMENT, container: 'mp4' },
  { re: /\/master\.(m3u8|txt)/i, kind: KIND.HLS, container: 'm3u8' },
  { re: /[?&](format|ext)=(mp4|webm)/i, kind: KIND.FILE },
  { re: /\/manifest(\.mpd)?(\?|$)/i, kind: KIND.DASH, container: 'mpd' },
  { re: /\/(hls|playlist)\/.*\.(m3u8)/i, kind: KIND.HLS, container: 'm3u8' },
  { re: /\/(chunk|frag|seg|segment)[-_/\d]/i, kind: KIND.SEGMENT },
  { re: /\/range\/\d+-\d+/i, kind: KIND.SEGMENT },
];

export function extFromUrl(url) {
  try {
    const p = new URL(url).pathname;
    const i = p.lastIndexOf('.');
    if (i < 0) return '';
    return p.slice(i + 1).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * @returns {{kind:string, container:string, confidence:number} | null}
 */
export function classify({ url, mimeType = '', contentLength = 0, resourceType = '' }) {
  if (!url || url.startsWith('data:')) return null;
  const mime = (mimeType || '').split(';')[0].trim().toLowerCase();
  const ext = extFromUrl(url);

  // Protocolos proprietarios de streaming (ex.: UMP/SABR do YouTube): pedacos que
  // so o player do site sabe montar. A captura do player cobre esses casos.
  if (/vnd\.yt-ump|x-protobuf/.test(mime) || /[?&](sabr|ump)=1\b/.test(url)) {
    return { kind: KIND.SEGMENT, container: '', confidence: 0.95 };
  }

  if (HLS_MIME.test(mime) || PLAYLIST_EXT.has(ext)) {
    return { kind: KIND.HLS, container: 'm3u8', confidence: 0.95 };
  }
  if (DASH_MIME.test(mime) || DASH_EXT.has(ext)) {
    return { kind: KIND.DASH, container: 'mpd', confidence: 0.95 };
  }
  if (SMOOTH_EXT.has(ext) || /\/manifest\b/i.test(url) && /smooth/i.test(url)) {
    return { kind: KIND.OTHER, container: 'ism', confidence: 0.6 };
  }

  if (SEGMENT_EXT.has(ext) && ext !== 'ts') {
    return { kind: KIND.SEGMENT, container: ext, confidence: 0.9 };
  }
  if (ext === 'ts') {
    // .ts pode ser um arquivo MPEG-TS inteiro ou um fragmento HLS.
    const isSegment = contentLength > 0 && contentLength < 25 * 1024 * 1024;
    return { kind: isSegment ? KIND.SEGMENT : KIND.FILE, container: 'ts', confidence: 0.7 };
  }

  if (VIDEO_EXT.has(ext)) return { kind: KIND.FILE, container: ext, confidence: 0.95 };
  if (AUDIO_EXT.has(ext)) return { kind: KIND.AUDIO, container: ext, confidence: 0.9 };

  if (VIDEO_MIME.test(mime)) {
    return { kind: KIND.FILE, container: containerFromMime(mime) || ext || 'mp4', confidence: 0.85 };
  }
  if (AUDIO_MIME.test(mime)) {
    return { kind: KIND.AUDIO, container: containerFromMime(mime) || ext || 'mp3', confidence: 0.8 };
  }

  if (resourceType === 'media') {
    return { kind: KIND.FILE, container: ext || 'mp4', confidence: 0.6 };
  }

  for (const hint of URL_HINTS) {
    if (hint.re.test(url)) {
      return { kind: hint.kind, container: hint.container || ext || '', confidence: 0.5 };
    }
  }

  return null;
}

export function containerFromMime(mime) {
  const m = (mime || '').toLowerCase();
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('webm')) return 'webm';
  if (m.includes('matroska')) return 'mkv';
  if (m.includes('ogg')) return 'ogv';
  if (m.includes('quicktime')) return 'mov';
  if (m.includes('x-flv')) return 'flv';
  if (m.includes('mp2t')) return 'ts';
  if (m.includes('mpeg') && m.startsWith('audio')) return 'mp3';
  if (m.includes('aac')) return 'aac';
  if (m.includes('wav')) return 'wav';
  return '';
}

/** Deve aparecer na lista principal do popup? Fragmentos ficam escondidos por padrao. */
export function isPrimary(kind) {
  return kind === KIND.FILE || kind === KIND.HLS || kind === KIND.DASH || kind === KIND.AUDIO || kind === KIND.CAPTURE;
}

/** Varre texto arbitrario (HTML/JSON) em busca de URLs de midia. */
// Aceita barras escapadas de JSON (`https:\/\/cdn\/a\/b.mp4`), comuns em respostas de API.
const URL_IN_TEXT = /(https?:\\?\/\\?\/(?:[^\s"'<>\\,)\]}]|\\\/)+?\.(?:m3u8|mpd|mp4|m4v|webm|mkv|mov|flv|avi|mp3|m4a|aac|ogg|wav|ts)(?:\?(?:[^\s"'<>\\,)\]}]|\\\/)*)?)/gi;

export function findMediaUrlsInText(text, limit = 60) {
  const found = new Set();
  if (!text || typeof text !== 'string') return [];
  let m;
  URL_IN_TEXT.lastIndex = 0;
  while ((m = URL_IN_TEXT.exec(text)) !== null && found.size < limit) {
    const url = m[1].replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
    found.add(url);
  }
  return [...found];
}
