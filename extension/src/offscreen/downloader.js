// Trabalho pesado: baixar arquivos, segmentos HLS/DASH, descriptografar AES-128
// e montar o arquivo final. Roda no documento offscreen.

import { parseM3U8 } from '../lib/m3u8.js';
import { parseMPD } from '../lib/mpd.js';
import { hexToBytes, mapLimit, retry, sanitizeFilename, basenameOf } from '../lib/utils.js';

const jobs = new Map(); // jobId -> {controller, ruleIds}
const keyCache = new Map();

function report(jobId, changes) {
  chrome.runtime
    .sendMessage({ target: 'bg', action: 'job.progress', payload: { jobId, ...changes } })
    .catch(() => {});
}

export async function installRules(urls, headers) {
  const referer = headers?.referer || headers?.Referer || '';
  const origin = headers?.origin || headers?.Origin || '';
  if (!referer && !origin) return [];
  try {
    const res = await chrome.runtime.sendMessage({
      target: 'bg',
      action: 'dnr.install',
      payload: { urls, referer, origin },
    });
    return res?.data?.ruleIds || [];
  } catch {
    return [];
  }
}

export async function removeRules(ruleIds) {
  if (!ruleIds?.length) return;
  try {
    await chrome.runtime.sendMessage({ target: 'bg', action: 'dnr.remove', payload: { ruleIds } });
  } catch {
    /* ignora */
  }
}

async function fetchBytes(url, { signal, range = null, retries = 3 } = {}) {
  return retry(
    async () => {
      const init = { signal, credentials: 'include', cache: 'no-store' };
      if (range) init.headers = { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` };
      const res = await fetch(url, init);
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} em ${basenameOf(url)}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    retries,
    600
  );
}

async function fetchText(url, { signal, retries = 2 } = {}) {
  return retry(
    async () => {
      const res = await fetch(url, { signal, credentials: 'include', cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
    retries,
    500
  );
}

// ------------------------------------------------------------------ probe

export async function probe({ url, kind, headers }) {
  const ruleIds = await installRules([url], headers);
  try {
    if (kind === 'hls') return await probeHls(url);
    if (kind === 'dash') return await probeDash(url);
    throw new Error('Tipo nao sondavel');
  } finally {
    await removeRules(ruleIds);
  }
}

async function probeHls(url) {
  const text = await fetchText(url);
  const parsed = parseM3U8(text, url);

  if (parsed.type === 'media') {
    return {
      kind: 'hls',
      isMaster: false,
      url,
      duration: parsed.duration,
      isLive: parsed.isLive,
      drm: parsed.drm,
      encrypted: parsed.encrypted,
      segmentCount: parsed.segments.length,
      variants: [
        {
          url,
          label: 'Stream unico',
          height: 0,
          width: 0,
          bandwidth: 0,
          codecs: '',
          duration: parsed.duration,
          segmentCount: parsed.segments.length,
          container: guessContainer(parsed),
        },
      ],
      audioRenditions: [],
      subtitleRenditions: [],
    };
  }

  // Master: busca a duracao a partir da melhor variante (1 requisicao extra).
  let duration = 0;
  let isLive = false;
  let drm = parsed.drm;
  let container = 'ts';
  const best = parsed.variants[0];
  if (best) {
    try {
      const mediaText = await fetchText(best.url);
      const media = parseM3U8(mediaText, best.url);
      duration = media.duration;
      isLive = media.isLive;
      drm = drm || media.drm;
      container = guessContainer(media);
      best.segmentCount = media.segments.length;
    } catch {
      /* variante protegida ou offline */
    }
  }

  const videoVariants = parsed.variants.map((v) => ({
    ...v,
    type: 'video',
    container,
    label: v.height ? `${v.height}p` : v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps` : 'auto',
  }));

  // Faixas de audio separadas viram opcoes selecionaveis (baixadas como arquivo proprio).
  const audioVariants = parsed.audioRenditions
    .filter((a) => a.url)
    .map((a) => ({
      url: a.url,
      type: 'audio',
      container: 'aac',
      lang: a.language,
      label: `Audio - ${a.name || a.language || a.groupId}`,
      height: 0,
      width: 0,
      bandwidth: 0,
      codecs: '',
    }));

  return {
    kind: 'hls',
    isMaster: true,
    url,
    duration,
    isLive,
    drm,
    width: best?.width || 0,
    height: best?.height || 0,
    hasSeparateAudio: audioVariants.length > 0,
    variants: [...videoVariants, ...audioVariants],
    audioRenditions: parsed.audioRenditions,
    subtitleRenditions: parsed.subtitleRenditions,
  };
}

function guessContainer(mediaPlaylist) {
  if (mediaPlaylist.initSegment) return 'mp4';
  const first = mediaPlaylist.segments[0];
  if (!first) return 'ts';
  if (/\.(mp4|m4s|m4v|cmfv|cmfa)(\?|$)/i.test(first.url)) return 'mp4';
  if (/\.aac(\?|$)/i.test(first.url)) return 'aac';
  return 'ts';
}

async function probeDash(url) {
  const text = await fetchText(url);
  const parsed = parseMPD(text, url);
  const video = parsed.representations.filter((r) => r.type === 'video');
  const best = video[0];
  return {
    kind: 'dash',
    url,
    duration: parsed.duration,
    isLive: parsed.isLive,
    drm: parsed.drm,
    width: best?.width || 0,
    height: best?.height || 0,
    variants: parsed.representations.map((r) => ({
      url: parsed.url,
      representationId: r.id,
      periodIndex: r.periodIndex,
      type: r.type,
      label:
        r.type === 'video'
          ? `${r.height ? r.height + 'p' : 'video'}${r.frameRate ? ' ' + Math.round(r.frameRate) + 'fps' : ''}`
          : `audio ${r.lang || ''} ${r.bandwidth ? Math.round(r.bandwidth / 1000) + 'k' : ''}`.trim(),
      height: r.height,
      width: r.width,
      bandwidth: r.bandwidth,
      codecs: r.codecs,
      lang: r.lang,
      drm: r.drm,
      segmentCount: r.segments.length,
      container: (r.mimeType || '').includes('webm') ? 'webm' : 'mp4',
      duration: r.duration,
    })),
    audioRenditions: [],
    subtitleRenditions: [],
  };
}

// -------------------------------------------------------------- downloads

export async function startDownload(jobId, spec) {
  if (jobs.has(jobId)) throw new Error('Job ja em andamento');
  const controller = new AbortController();
  jobs.set(jobId, { controller, ruleIds: [] });

  run(jobId, spec, controller.signal)
    .then((result) => {
      report(jobId, {
        status: 'done',
        stage: 'Concluido',
        progress: 100,
        filename: result?.filename || spec.filename,
        note: result?.note || '',
      });
    })
    .catch((err) => {
      const canceled = err?.name === 'AbortError';
      report(jobId, {
        status: canceled ? 'canceled' : 'error',
        stage: canceled ? 'Cancelado' : 'Erro',
        error: canceled ? '' : String(err?.message || err),
      });
    })
    .finally(async () => {
      const entry = jobs.get(jobId);
      if (entry) await removeRules(entry.ruleIds);
      jobs.delete(jobId);
    });

  return { started: true };
}

export function cancelDownload(jobId) {
  const entry = jobs.get(jobId);
  if (entry) entry.controller.abort();
  return { canceled: Boolean(entry) };
}

async function run(jobId, spec, signal) {
  const entry = jobs.get(jobId);
  const urlsForRules = [spec.url || spec.manifestUrl || spec.variantUrl].filter(Boolean);
  entry.ruleIds = await installRules(urlsForRules, spec.headers);

  report(jobId, { status: 'running', stage: 'Preparando', progress: 0 });

  switch (spec.type) {
    case 'file':
      return downloadFile(jobId, spec, signal);
    case 'hls':
      return downloadHls(jobId, spec, signal);
    case 'dash':
      return downloadDash(jobId, spec, signal);
    default:
      throw new Error(`Tipo de download nao suportado: ${spec.type}`);
  }
}

async function downloadFile(jobId, spec, signal) {
  report(jobId, { stage: 'Baixando arquivo' });
  const res = await fetch(spec.url, { signal, credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length')) || spec.expectedSize || 0;
  const parts = [];
  let received = 0;

  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    let lastTick = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      received += value.length;
      const now = Date.now();
      if (now - lastTick > 250) {
        lastTick = now;
        report(jobId, {
          received,
          total,
          progress: total ? Math.min(99, Math.round((received / total) * 100)) : 0,
          stage: 'Baixando arquivo',
        });
      }
    }
  } else {
    parts.push(new Uint8Array(await res.arrayBuffer()));
    received = parts[0].length;
  }

  const mime = res.headers.get('content-type') || 'application/octet-stream';
  const blob = new Blob(parts, { type: mime.split(';')[0] });
  const filename = await save(blob, spec, spec.container || 'mp4');
  report(jobId, { received, total: received, progress: 100 });
  return { filename };
}

async function downloadHls(jobId, spec, signal) {
  report(jobId, { stage: 'Lendo playlist' });
  const playlistUrl = spec.variantUrl || spec.manifestUrl;
  let text = await fetchText(playlistUrl, { signal });
  let parsed = parseM3U8(text, playlistUrl);

  if (parsed.type === 'master') {
    const chosen =
      parsed.variants.find((v) => v.url === spec.variantUrl) || parsed.variants[0];
    if (!chosen) throw new Error('Nenhuma variante encontrada no master');
    text = await fetchText(chosen.url, { signal });
    parsed = parseM3U8(text, chosen.url);
  }

  if (parsed.drm) {
    throw new Error(`Stream protegido por DRM (${parsed.drm}). Download nao suportado.`);
  }
  if (!parsed.segments.length) throw new Error('Playlist sem segmentos');

  const limit = spec.segmentLimit || 0;
  const segments = limit > 0 ? parsed.segments.slice(0, limit) : parsed.segments;

  report(jobId, {
    stage: parsed.isLive ? 'Baixando (live: trecho disponivel)' : 'Baixando segmentos',
    segmentsTotal: segments.length,
    segmentsDone: 0,
  });

  const parts = [];
  if (parsed.initSegment?.url) {
    const init = await fetchBytes(parsed.initSegment.url, {
      signal,
      range: parsed.initSegment.byteRange,
      retries: spec.retries,
    });
    parts.push(new Blob([init]));
  }

  let received = parts.length ? parts[0].size : 0;
  const results = await mapLimit(
    segments,
    spec.concurrency || 6,
    async (segment) => {
      if (signal.aborted) throw abortError();
      let bytes = await fetchBytes(segment.url, {
        signal,
        range: segment.byteRange,
        retries: spec.retries,
      });
      if (segment.key) bytes = await decryptSegment(bytes, segment, signal);
      received += bytes.length;
      return new Blob([bytes]);
    },
    (done, total) => {
      report(jobId, {
        segmentsDone: done,
        segmentsTotal: total,
        received,
        progress: Math.min(99, Math.round((done / total) * 100)),
      });
    }
  );

  parts.push(...results);
  const container = parsed.initSegment ? 'mp4' : guessContainer(parsed);
  report(jobId, { stage: 'Montando arquivo', progress: 99 });

  const blob = new Blob(parts, { type: container === 'mp4' ? 'video/mp4' : 'video/mp2t' });
  const filename = await save(blob, spec, container);

  return {
    filename,
    note:
      container === 'ts'
        ? 'Saida em .ts (MPEG-TS). Para converter sem recodificar: ffmpeg -i arquivo.ts -c copy arquivo.mp4'
        : '',
  };
}

async function decryptSegment(bytes, segment, signal) {
  const { key } = segment;
  const method = (key.method || '').toUpperCase();
  if (method !== 'AES-128') {
    throw new Error(`Criptografia nao suportada: ${key.method}`);
  }
  if (!key.uri) throw new Error('Chave AES-128 sem URI');

  let cryptoKey = keyCache.get(key.uri);
  if (!cryptoKey) {
    const raw = await fetchBytes(key.uri, { signal, retries: 3 });
    cryptoKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
    keyCache.set(key.uri, cryptoKey);
  }

  let iv;
  if (key.iv) {
    iv = hexToBytes(key.iv);
  } else {
    iv = new Uint8Array(16);
    const view = new DataView(iv.buffer);
    view.setUint32(12, segment.sequence >>> 0, false);
  }

  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, bytes);
  return new Uint8Array(plain);
}

async function downloadDash(jobId, spec, signal) {
  report(jobId, { stage: 'Lendo manifest' });
  const text = await fetchText(spec.manifestUrl, { signal });
  const parsed = parseMPD(text, spec.manifestUrl);

  const rep =
    parsed.representations.find(
      (r) => r.id === spec.representationId && (spec.periodIndex == null || r.periodIndex === spec.periodIndex)
    ) || parsed.representations.find((r) => r.type === 'video') || parsed.representations[0];

  if (!rep) throw new Error('Nenhuma representacao encontrada no manifest');
  if (rep.drm || parsed.drm) {
    throw new Error(`Stream protegido por DRM (${rep.drm || parsed.drm}). Download nao suportado.`);
  }
  if (!rep.segments.length) throw new Error('Representacao sem segmentos');

  const parts = [];
  let received = 0;

  if (rep.init?.url) {
    const init = await fetchBytes(rep.init.url, {
      signal,
      range: parseRange(rep.init.range),
      retries: spec.retries,
    });
    received += init.length;
    parts.push(new Blob([init]));
  }

  report(jobId, { stage: 'Baixando segmentos', segmentsTotal: rep.segments.length, segmentsDone: 0 });

  const results = await mapLimit(
    rep.segments,
    spec.concurrency || 6,
    async (segment) => {
      if (signal.aborted) throw abortError();
      const bytes = await fetchBytes(segment.url, {
        signal,
        range: parseRange(segment.range),
        retries: spec.retries,
      });
      received += bytes.length;
      return new Blob([bytes]);
    },
    (done, total) => {
      report(jobId, {
        segmentsDone: done,
        segmentsTotal: total,
        received,
        progress: Math.min(99, Math.round((done / total) * 100)),
      });
    }
  );

  parts.push(...results);
  report(jobId, { stage: 'Montando arquivo', progress: 99 });

  const container = (rep.mimeType || '').includes('webm') ? 'webm' : 'mp4';
  const blob = new Blob(parts, { type: rep.mimeType || 'video/mp4' });
  const filename = await save(blob, spec, container);

  return {
    filename,
    note:
      rep.type === 'video'
        ? 'DASH separa video e audio. Baixe tambem a faixa de audio e junte: ffmpeg -i video.mp4 -i audio.m4a -c copy saida.mp4'
        : '',
  };
}

function parseRange(range) {
  if (!range) return null;
  const [start, end] = String(range).split('-').map(Number);
  if (!isFinite(start) || !isFinite(end)) return null;
  return { offset: start, length: end - start + 1 };
}

function abortError() {
  const err = new Error('Cancelado');
  err.name = 'AbortError';
  return err;
}

async function save(blob, spec, container) {
  const base = sanitizeFilename(spec.filename || 'video');
  const ext = container || 'mp4';
  const name = base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
  const subfolder = spec.subfolder ? `${sanitizeFilename(spec.subfolder)}/` : '';
  const url = URL.createObjectURL(blob);

  // Documentos offscreen so tem chrome.runtime: quem chama chrome.downloads e o
  // service worker (mesma origem da extensao, entao ele enxerga este blob: URL).
  const res = await chrome.runtime.sendMessage({
    target: 'bg',
    action: 'download.save',
    payload: { url, filename: `${subfolder}${name}`, saveAs: Boolean(spec.saveAs) },
  });
  if (!res?.ok) {
    URL.revokeObjectURL(url);
    throw new Error(res?.error || 'Falha ao salvar o arquivo');
  }
  // rede de seguranca caso o aviso de conclusao nunca chegue
  setTimeout(() => URL.revokeObjectURL(url), 30 * 60 * 1000);
  return name;
}

export function revokeBlob(url) {
  URL.revokeObjectURL(url);
  return null;
}

