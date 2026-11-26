// Parser de playlists HLS (RFC 8216) suficiente para extracao/download.

import { parseAttrList, safeUrl } from './utils.js';

export const DRM_METHODS = new Set(['SAMPLE-AES', 'SAMPLE-AES-CTR', 'SAMPLE-AES-CENC', 'ISO-23001-7']);

/**
 * @param {string} text conteudo bruto do .m3u8
 * @param {string} baseUrl URL absoluta da playlist
 */
export function parseM3U8(text, baseUrl) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) {
    throw new Error('Nao parece uma playlist HLS valida');
  }

  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  return isMaster ? parseMaster(lines, baseUrl) : parseMedia(lines, baseUrl);
}

function parseMaster(lines, baseUrl) {
  const variants = [];
  const audioRenditions = [];
  const subtitleRenditions = [];
  let pending = null;
  let sessionDrm = null;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-SESSION-KEY')) {
      const attrs = parseAttrList(line.slice(line.indexOf(':') + 1));
      if (attrs.METHOD && attrs.METHOD !== 'NONE') sessionDrm = describeKey(attrs);
    } else if (line.startsWith('#EXT-X-MEDIA')) {
      const attrs = parseAttrList(line.slice(line.indexOf(':') + 1));
      const item = {
        type: attrs.TYPE,
        groupId: attrs['GROUP-ID'],
        name: attrs.NAME || attrs.LANGUAGE || attrs['GROUP-ID'],
        language: attrs.LANGUAGE || '',
        isDefault: attrs.DEFAULT === 'YES',
        url: attrs.URI ? safeUrl(attrs.URI, baseUrl) : null,
        channels: attrs.CHANNELS || '',
      };
      if (attrs.TYPE === 'AUDIO') audioRenditions.push(item);
      else if (attrs.TYPE === 'SUBTITLES' || attrs.TYPE === 'CLOSED-CAPTIONS') subtitleRenditions.push(item);
    } else if (line.startsWith('#EXT-X-STREAM-INF')) {
      pending = parseAttrList(line.slice(line.indexOf(':') + 1));
    } else if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
      pending = null; // ignora trick-play
    } else if (!line.startsWith('#') && pending) {
      const res = (pending.RESOLUTION || '').split('x');
      variants.push({
        url: safeUrl(line, baseUrl),
        bandwidth: Number(pending.BANDWIDTH || pending['AVERAGE-BANDWIDTH'] || 0),
        averageBandwidth: Number(pending['AVERAGE-BANDWIDTH'] || 0),
        width: Number(res[0]) || 0,
        height: Number(res[1]) || 0,
        codecs: pending.CODECS || '',
        frameRate: Number(pending['FRAME-RATE'] || 0),
        audioGroup: pending.AUDIO || '',
        subtitleGroup: pending.SUBTITLES || '',
      });
      pending = null;
    }
  }

  variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  return {
    type: 'master',
    url: baseUrl,
    variants,
    audioRenditions,
    subtitleRenditions,
    drm: sessionDrm,
  };
}

function parseMedia(lines, baseUrl) {
  const segments = [];
  let currentKey = null;
  let initSegment = null;
  let duration = 0;
  let targetDuration = 0;
  let mediaSequence = 0;
  let isLive = true;
  let byteRangeOffset = 0;
  let pendingDuration = 0;
  let pendingByteRange = null;
  let pendingDiscontinuity = false;
  let drm = null;
  let seq = 0;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-TARGETDURATION')) {
      targetDuration = Number(line.split(':')[1]) || 0;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      mediaSequence = Number(line.split(':')[1]) || 0;
      seq = mediaSequence;
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      isLive = false;
    } else if (line.startsWith('#EXT-X-KEY')) {
      const attrs = parseAttrList(line.slice(line.indexOf(':') + 1));
      if (!attrs.METHOD || attrs.METHOD === 'NONE') {
        currentKey = null;
      } else {
        currentKey = {
          method: attrs.METHOD,
          uri: attrs.URI ? safeUrl(attrs.URI, baseUrl) : null,
          iv: attrs.IV || null,
          keyFormat: attrs.KEYFORMAT || 'identity',
        };
        const described = describeKey(attrs);
        if (described) drm = described;
      }
    } else if (line.startsWith('#EXT-X-MAP')) {
      const attrs = parseAttrList(line.slice(line.indexOf(':') + 1));
      initSegment = {
        url: safeUrl(attrs.URI, baseUrl),
        byteRange: attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE, 0) : null,
      };
    } else if (line.startsWith('#EXTINF')) {
      pendingDuration = parseFloat(line.slice(8).split(',')[0]) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE')) {
      pendingByteRange = parseByteRange(line.split(':')[1], byteRangeOffset);
      byteRangeOffset = pendingByteRange.offset + pendingByteRange.length;
    } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      pendingDiscontinuity = true;
    } else if (!line.startsWith('#')) {
      const url = safeUrl(line, baseUrl);
      if (url) {
        segments.push({
          url,
          duration: pendingDuration,
          sequence: seq,
          key: currentKey,
          byteRange: pendingByteRange,
          discontinuity: pendingDiscontinuity,
        });
        duration += pendingDuration;
      }
      seq++;
      pendingDuration = 0;
      pendingByteRange = null;
      pendingDiscontinuity = false;
    }
  }

  return {
    type: 'media',
    url: baseUrl,
    segments,
    initSegment,
    duration,
    targetDuration,
    mediaSequence,
    isLive,
    drm,
    encrypted: segments.some((s) => s.key),
  };
}

function parseByteRange(value, defaultOffset) {
  const [lenStr, offStr] = String(value).trim().split('@');
  const length = Number(lenStr) || 0;
  const offset = offStr != null ? Number(offStr) : defaultOffset;
  return { length, offset };
}

/** Retorna descricao de DRM se a chave nao for AES-128 "identity" (clear key padrao HLS). */
function describeKey(attrs) {
  const method = (attrs.METHOD || '').toUpperCase();
  const format = (attrs.KEYFORMAT || 'identity').toLowerCase();
  if (!method || method === 'NONE') return null;
  if (format.includes('widevine')) return 'Widevine';
  if (format.includes('playready') || format.includes('microsoft')) return 'PlayReady';
  if (format.includes('fairplay') || format.startsWith('com.apple.streamingkeydelivery')) return 'FairPlay';
  if (DRM_METHODS.has(method)) return method;
  return null; // AES-128 identity: criptografia padrao HLS, chave entregue junto do manifest
}
