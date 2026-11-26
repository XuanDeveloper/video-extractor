// Decide o que aparece na lista. A meta: mostrar so o que o usuario consegue
// de fato baixar e assistir. O resto continua guardado e aparece em
// Opcoes > "Mostrar tudo (inclui fragmentos)".

import { KIND, isPrimary } from '../lib/classify.js';

const AD_HOST =
  /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|imasdk\.googleapis\.com|2mdn\.net|adnxs\.com|amazon-adsystem\.com|moatads\.com|teads\.tv|spotxchange\.com|spotx\.tv|springserve\.com|innovid\.com|serving-sys\.com|adsrvr\.org|criteo\.(com|net)|taboola\.com|outbrain\.com|pubmatic\.com|rubiconproject\.com|smartadserver\.com|fwmrm\.net|freewheel\.tv|tremorhub\.com|adform\.net|yieldmo\.com|vidazoo\.com|aniview\.com)$/i;

const MIN_FILE_BYTES = 150 * 1024; // sons de interface, gifs em mp4, pixels de rastreio
const MIN_CAPTURE_BYTES = 256 * 1024;

function host(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function pathKey(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

/** @returns {string|null} motivo para esconder, ou null se for util */
function hideReason(item, ctx) {
  if (!isPrimary(item.kind)) return 'fragmento';
  if (AD_HOST.test(host(item.url))) return 'anuncio';

  if (item.kind === KIND.CAPTURE) {
    if (item.drm) return 'drm';
    if ((item.size || 0) < MIN_CAPTURE_BYTES) return 'pequeno';
    if (!item.hasVideo && ctx.captureWithVideo) return 'audio-de-captura';
    return null;
  }

  if ((item.kind === KIND.FILE || item.kind === KIND.AUDIO) && item.size && item.size < MIN_FILE_BYTES) {
    return 'pequeno';
  }

  // Sub-playlists (variantes/faixas) de um master ja listado.
  if (item.kind === KIND.HLS && ctx.childPlaylists.has(item.url)) return 'parte-de-playlist';

  // Mesmo arquivo com URLs assinadas diferentes: fica so o maior/mais recente.
  if (item.kind === KIND.FILE || item.kind === KIND.AUDIO) {
    const best = ctx.bestByPath.get(pathKey(item.url));
    if (best && best !== item.id) return 'duplicado';
  }

  // Manifest que falhou (expirado/403) quando existe outro do mesmo tipo funcionando.
  if ((item.kind === KIND.HLS || item.kind === KIND.DASH) && item.probeState === 'error') {
    if (ctx.workingManifests > 0) return 'manifest-com-erro';
  }
  return null;
}

function priority(item) {
  if (item.kind === KIND.HLS && item.probe?.isMaster) return 0;
  if (item.kind === KIND.DASH) return 0;
  if (item.kind === KIND.CAPTURE) return 1;
  if (item.kind === KIND.HLS) return 1;
  if (item.kind === KIND.FILE) return 2;
  return 3;
}

export function filterUseful(items, { showAll = false } = {}) {
  const childPlaylists = new Set();
  let workingManifests = 0;
  const bestByPath = new Map();
  const bestSize = new Map();
  let captureWithVideo = false;

  for (const item of items) {
    if (item.kind === KIND.CAPTURE && item.hasVideo && (item.size || 0) >= MIN_CAPTURE_BYTES && !item.drm) {
      captureWithVideo = true;
    }
    if ((item.kind === KIND.HLS || item.kind === KIND.DASH) && item.probeState === 'done') workingManifests++;
    if (item.kind === KIND.HLS && item.probe?.isMaster) {
      for (const v of item.probe.variants || []) if (v.url && v.url !== item.url) childPlaylists.add(v.url);
      for (const a of item.probe.audioRenditions || []) if (a.url) childPlaylists.add(a.url);
      for (const t of item.probe.subtitleRenditions || []) if (t.url) childPlaylists.add(t.url);
    }
    if (item.kind === KIND.FILE || item.kind === KIND.AUDIO) {
      const key = pathKey(item.url);
      const size = item.size || 0;
      if (!bestByPath.has(key) || size > bestSize.get(key)) {
        bestByPath.set(key, item.id);
        bestSize.set(key, size);
      }
    }
  }

  const ctx = { childPlaylists, workingManifests, bestByPath, captureWithVideo };
  const visible = [];
  let hidden = 0;
  for (const item of items) {
    const reason = hideReason(item, ctx);
    if (reason && !showAll) {
      hidden++;
      continue;
    }
    visible.push(reason ? { ...item, hiddenReason: reason } : item);
  }
  visible.sort((a, b) => priority(a) - priority(b) || (b.size || 0) - (a.size || 0));
  return { visible, hidden };
}
