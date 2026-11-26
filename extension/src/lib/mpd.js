// Parser de manifests MPEG-DASH (.mpd). Precisa de DOMParser -> roda no documento offscreen.

import { safeUrl } from './utils.js';

/** Converte duracao ISO-8601 (PT1H2M3.5S) em segundos. */
export function parseISODuration(value) {
  if (!value) return 0;
  const m = /^(-)?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(value).trim());
  if (!m) return 0;
  const [, sign, y, mo, d, h, mi, s] = m;
  const total =
    (Number(y) || 0) * 31536000 +
    (Number(mo) || 0) * 2592000 +
    (Number(d) || 0) * 86400 +
    (Number(h) || 0) * 3600 +
    (Number(mi) || 0) * 60 +
    (Number(s) || 0);
  return sign ? -total : total;
}

function childrenByTag(node, tag) {
  return Array.from(node.children || []).filter((c) => c.localName === tag);
}

function firstByTag(node, tag) {
  return childrenByTag(node, tag)[0] || null;
}

function baseUrlOf(node, parentBase) {
  const el = firstByTag(node, 'BaseURL');
  if (!el) return parentBase;
  const txt = (el.textContent || '').trim();
  if (!txt) return parentBase;
  return safeUrl(txt, parentBase) || parentBase;
}

function attr(node, name, fallback = null) {
  if (!node || !node.hasAttribute(name)) return fallback;
  return node.getAttribute(name);
}

function num(node, name, fallback = 0) {
  const v = attr(node, name);
  if (v == null) return fallback;
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

/** Percorre todos os descendentes (getElementsByTagName se comporta mal em XML). */
function descendantsByTag(node, tag) {
  const out = [];
  const stack = [...(node.children || [])];
  while (stack.length) {
    const el = stack.pop();
    if (el.localName === tag) out.push(el);
    if (el.children && el.children.length) stack.push(...el.children);
  }
  return out;
}

function detectDrm(node) {
  const protections = descendantsByTag(node, 'ContentProtection');
  const systems = new Set();
  for (const p of protections) {
    const scheme = (p.getAttribute('schemeIdUri') || '').toLowerCase();
    const value = (p.getAttribute('value') || '').toLowerCase();
    if (scheme.includes('edef8ba9')) systems.add('Widevine');
    else if (scheme.includes('9a04f079')) systems.add('PlayReady');
    else if (scheme.includes('94ce86fb')) systems.add('FairPlay');
    else if (scheme.includes('mpeg:dash:mp4protection')) {
      if (value.includes('cenc') || value.includes('cbcs')) systems.add('CENC');
    } else if (scheme) systems.add(p.getAttribute('schemeIdUri'));
  }
  // CENC sozinho so indica que ha criptografia; o sistema real vem junto.
  if (systems.size > 1) systems.delete('CENC');
  return systems.size ? [...systems].join(', ') : null;
}

/**
 * @param {string|Document} input
 * @param {string} manifestUrl
 */
export function parseMPD(input, manifestUrl) {
  let doc = input;
  if (typeof input === 'string') {
    doc = new DOMParser().parseFromString(input, 'application/xml');
  }
  const err = doc.querySelector && doc.querySelector('parsererror');
  if (err) throw new Error('MPD invalido (XML malformado)');

  const mpd = doc.documentElement;
  if (!mpd || mpd.localName !== 'MPD') throw new Error('Nao parece um manifest DASH');

  const isLive = attr(mpd, 'type', 'static') === 'dynamic';
  const totalDuration = parseISODuration(attr(mpd, 'mediaPresentationDuration'));
  const mpdBase = baseUrlOf(mpd, manifestUrl);
  const drm = detectDrm(mpd);

  const representations = [];

  childrenByTag(mpd, 'Period').forEach((period, periodIndex) => {
    const periodBase = baseUrlOf(period, mpdBase);
    const periodDuration = parseISODuration(attr(period, 'duration')) || totalDuration;

    childrenByTag(period, 'AdaptationSet').forEach((aset) => {
      const asetBase = baseUrlOf(aset, periodBase);
      const contentType =
        attr(aset, 'contentType') ||
        (attr(aset, 'mimeType') || '').split('/')[0] ||
        '';
      const lang = attr(aset, 'lang', '') || '';

      childrenByTag(aset, 'Representation').forEach((rep) => {
        const repBase = baseUrlOf(rep, asetBase);
        const mimeType = attr(rep, 'mimeType') || attr(aset, 'mimeType') || '';
        const type = contentType || mimeType.split('/')[0] || 'video';
        const id = attr(rep, 'id', `${periodIndex}-${representations.length}`);
        const bandwidth = num(rep, 'bandwidth', 0);

        const segmentInfo = buildSegments({
          rep,
          aset,
          period,
          base: repBase,
          repId: id,
          bandwidth,
          periodDuration,
        });

        representations.push({
          id,
          periodIndex,
          type: type === 'audio' ? 'audio' : type === 'text' ? 'text' : 'video',
          mimeType,
          codecs: attr(rep, 'codecs') || attr(aset, 'codecs') || '',
          bandwidth,
          width: num(rep, 'width', num(aset, 'width', 0)),
          height: num(rep, 'height', num(aset, 'height', 0)),
          frameRate: parseFrameRate(attr(rep, 'frameRate') || attr(aset, 'frameRate')),
          audioSamplingRate: num(rep, 'audioSamplingRate', 0),
          lang,
          duration: periodDuration,
          drm: detectDrm(aset) || drm,
          ...segmentInfo,
        });
      });
    });
  });

  representations.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'video' ? -1 : 1;
    return (b.height - a.height) || (b.bandwidth - a.bandwidth);
  });

  return {
    url: manifestUrl,
    isLive,
    duration: totalDuration,
    drm,
    representations,
  };
}

function parseFrameRate(value) {
  if (!value) return 0;
  if (String(value).includes('/')) {
    const [a, b] = String(value).split('/').map(Number);
    return b ? Math.round((a / b) * 100) / 100 : 0;
  }
  return Number(value) || 0;
}

function buildSegments({ rep, aset, period, base, repId, bandwidth, periodDuration }) {
  const template =
    firstByTag(rep, 'SegmentTemplate') ||
    firstByTag(aset, 'SegmentTemplate') ||
    firstByTag(period, 'SegmentTemplate');
  const list = firstByTag(rep, 'SegmentList') || firstByTag(aset, 'SegmentList');
  const segBase = firstByTag(rep, 'SegmentBase') || firstByTag(aset, 'SegmentBase');

  if (template) {
    return fromTemplate(template, base, repId, bandwidth, periodDuration);
  }
  if (list) {
    const initEl = firstByTag(list, 'Initialization');
    const init = initEl && attr(initEl, 'sourceURL')
      ? { url: safeUrl(attr(initEl, 'sourceURL'), base), range: attr(initEl, 'range') }
      : null;
    const segments = childrenByTag(list, 'SegmentURL').map((s) => ({
      url: safeUrl(attr(s, 'media') || '', base) || base,
      range: attr(s, 'mediaRange'),
    }));
    return { mode: 'list', init, segments };
  }
  if (segBase) {
    const initEl = firstByTag(segBase, 'Initialization');
    return {
      mode: 'single',
      init: initEl ? { url: base, range: attr(initEl, 'range') } : null,
      segments: [{ url: base, range: null }],
    };
  }
  // Sem informacao de segmentacao: BaseURL e o arquivo inteiro.
  return { mode: 'single', init: null, segments: [{ url: base, range: null }] };
}

function fromTemplate(template, base, repId, bandwidth, periodDuration) {
  const media = attr(template, 'media', '');
  const initPattern = attr(template, 'initialization');
  const timescale = num(template, 'timescale', 1) || 1;
  const startNumber = num(template, 'startNumber', 1);
  const segDuration = num(template, 'duration', 0);
  const timeline = firstByTag(template, 'SegmentTimeline');

  const fill = (pattern, vars) =>
    safeUrl(
      String(pattern).replace(/\$(\w+)(?:%0(\d+)d)?\$/g, (full, name, pad) => {
        if (name === '') return '$';
        let value = vars[name];
        if (value == null) return full;
        value = String(value);
        if (pad) value = value.padStart(Number(pad), '0');
        return value;
      }).replace(/\$\$/g, '$'),
      base
    );

  const baseVars = { RepresentationID: repId, Bandwidth: bandwidth };
  const init = initPattern ? { url: fill(initPattern, baseVars), range: null } : null;

  const segments = [];
  if (timeline) {
    let time = 0;
    let number = startNumber;
    for (const s of childrenByTag(timeline, 'S')) {
      const t = attr(s, 't');
      if (t != null) time = Number(t);
      const d = num(s, 'd', 0);
      const r = num(s, 'r', 0);
      const repeat = r < 0 ? estimateRepeat(periodDuration, timescale, time, d) : r;
      for (let i = 0; i <= repeat; i++) {
        segments.push({
          url: fill(media, { ...baseVars, Number: number, Time: time }),
          range: null,
        });
        time += d;
        number++;
      }
    }
  } else if (segDuration > 0) {
    const count = Math.ceil((periodDuration * timescale) / segDuration);
    for (let i = 0; i < count; i++) {
      segments.push({
        url: fill(media, { ...baseVars, Number: startNumber + i, Time: i * segDuration }),
        range: null,
      });
    }
  }

  return { mode: 'template', init, segments };
}

function estimateRepeat(periodDuration, timescale, startTime, d) {
  if (!periodDuration || !d) return 0;
  const remaining = periodDuration * timescale - startTime;
  return Math.max(0, Math.ceil(remaining / d) - 1);
}
