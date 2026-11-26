// Executa no MUNDO DA PAGINA (world: MAIN).
// Intercepta fetch/XHR, MediaSource/blob e elementos de midia para achar o que
// o service worker nao enxerga (streams montados em memoria, URLs em JSON, etc).

(() => {
  if (window.__vepPageHookInstalled) return;
  window.__vepPageHookInstalled = true;

  const CHANNEL = 'vep-page';
  const MEDIA_RE = /(https?:\/\/[^\s"'<>\\,)\]}]+?\.(?:m3u8|mpd|mp4|m4v|webm|mkv|mov|flv|avi|mp3|m4a|aac|ogg|wav|ts)(?:\?[^\s"'<>\\,)\]}]*)?)/gi;
  const INSPECTABLE_TYPE = /(json|javascript|text\/plain|text\/html|xml)/i;
  const MAX_BODY_INSPECT = 2 * 1024 * 1024;

  let config = { captureMSE: true, maxCaptureBytes: 1024 * 1024 * 1024 };

  const seen = new Set();

  function post(type, data) {
    try {
      window.postMessage({ channel: CHANNEL, type, data }, '*');
    } catch {
      /* dados nao clonaveis */
    }
  }

  function reportUrl(url, extra = {}) {
    if (!url || typeof url !== 'string') return;
    if (url.startsWith('data:')) return;
    let abs;
    try {
      abs = new URL(url, location.href).href;
    } catch {
      return;
    }
    const key = abs.split('#')[0];
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 3000) seen.clear();
    post('media', { url: abs, ...extra });
  }

  function scanText(text, origin) {
    if (!text || typeof text !== 'string') return;
    const sample = text.length > MAX_BODY_INSPECT ? text.slice(0, MAX_BODY_INSPECT) : text;
    MEDIA_RE.lastIndex = 0;
    let m;
    let found = 0;
    while ((m = MEDIA_RE.exec(sample)) !== null && found < 40) {
      const cleaned = m[1]
        .replace(/\\\//g, '/')
        .replace(/\\u0026/gi, '&')
        .replace(/&amp;/g, '&');
      reportUrl(cleaned, { source: origin });
      found++;
    }
  }

  // -------------------------------------------------------------- fetch

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (...args) {
      const req = args[0];
      const url = typeof req === 'string' ? req : req && req.url;
      const init = args[1];
      const method = (init && init.method) || (req && req.method) || 'GET';

      if (init && typeof init.body === 'string') scanText(init.body, 'fetch-request');

      const promise = nativeFetch.apply(this, args);
      promise
        .then((res) => {
          try {
            if (!res || !res.ok) return;
            reportUrl(url, { source: 'fetch', method });
            const type = res.headers.get('content-type') || '';
            if (INSPECTABLE_TYPE.test(type)) {
              res
                .clone()
                .text()
                .then((text) => scanText(text, 'fetch-response'))
                .catch(() => {});
            }
          } catch {
            /* ignora */
          }
        })
        .catch(() => {});
      return promise;
    };
  }

  // ---------------------------------------------------------------- XHR

  const XhrOpen = XMLHttpRequest.prototype.open;
  const XhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__vepUrl = url;
    this.__vepMethod = method;
    return XhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (typeof body === 'string') scanText(body, 'xhr-request');
    this.addEventListener('load', () => {
      try {
        reportUrl(this.__vepUrl, { source: 'xhr', method: this.__vepMethod });
        const type = this.getResponseHeader('content-type') || '';
        if (!INSPECTABLE_TYPE.test(type)) return;
        if (this.responseType === '' || this.responseType === 'text') {
          scanText(this.responseText, 'xhr-response');
        } else if (this.responseType === 'json' && this.response) {
          scanText(JSON.stringify(this.response), 'xhr-response');
        }
      } catch {
        /* ignora */
      }
    });
    return XhrSend.call(this, body);
  };

  // ------------------------------------------- MediaSource / blob capture
  //
  // Cada MediaSource (= um player) vira um "grupo". Cada SourceBuffer dele e uma
  // faixa (video, audio). Os bytes entregues ao player sao guardados em "partes"
  // que sempre comecam pelo segmento de inicializacao, para poderem ser lidas
  // de forma independente pelo remuxador (mse-mux.js) na hora de salvar.

  const groups = new Map(); // groupId -> grupo
  const groupBySource = new Map(); // MediaSource -> grupo
  let groupSeq = 0;
  let totalCaptured = 0;

  const NativeMediaSource = window.MediaSource;
  const nativeCreateObjectURL = URL.createObjectURL.bind(URL);

  function groupFor(ms) {
    let g = groupBySource.get(ms);
    if (!g) {
      g = {
        id: `ms${++groupSeq}`,
        ms,
        blobUrl: '',
        tracks: [],
        title: '',
        thumb: '',
        thumbAt: 0,
        fullCapture: null,
        reportTimer: null,
        lastReport: 0,
      };
      groupBySource.set(ms, g);
      groups.set(g.id, g);
    }
    return g;
  }

  URL.createObjectURL = function (obj) {
    const url = nativeCreateObjectURL(obj);
    try {
      if (NativeMediaSource && obj instanceof NativeMediaSource) {
        groupFor(obj).blobUrl = url;
      }
    } catch {
      /* ignora */
    }
    return url;
  };

  function hashBytes(b) {
    let h = 0x811c9dc5;
    const step = Math.max(1, Math.floor(b.length / 4096));
    for (let i = 0; i < b.length; i += step) {
      h ^= b[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `${b.length}:${h}`;
  }

  const str4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  /** Tamanho do segmento de inicializacao no inicio do append (0 = nao ha init). */
  function initLength(b) {
    if (b.length >= 8 && (str4(b, 4) === 'ftyp' || str4(b, 4) === 'moov')) {
      let o = 0;
      while (o + 8 <= b.length) {
        const size = ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
        const type = str4(b, o + 4);
        if (type === 'moof' || type === 'mdat' || size < 8) break;
        o += size;
        if (type === 'moov') break;
      }
      return Math.min(o, b.length);
    }
    if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
      for (let i = 4; i + 4 <= b.length; i++) {
        if (b[i] === 0x1f && b[i + 1] === 0x43 && b[i + 2] === 0xb6 && b[i + 3] === 0x75) return i;
      }
      return b.length;
    }
    return 0;
  }

  function newPart(track, run, offset) {
    const part = { chunks: run.init ? [run.init] : [], offset, bytes: 0 };
    run.parts.push(part);
    track.current = { run, part };
    return part;
  }

  function recordAppend(sb, data) {
    const track = sb.__vepTrack;
    if (!track || track.group.overflow) return;
    const view =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
    if (!view.length) return;
    const copy = view.slice();
    let offset = 0;
    try {
      offset = sb.timestampOffset || 0;
    } catch {
      /* ignora */
    }

    const initLen = initLength(copy);
    if (initLen > 0) {
      const init = copy.subarray(0, initLen);
      const key = hashBytes(init);
      let run = track.runs.get(key);
      if (!run) {
        run = { init: init.slice(), parts: [] };
        track.runs.set(key, run);
      }
      newPart(track, run, offset);
      if (copy.length > initLen) track.current.part.chunks.push(copy.subarray(initLen));
    } else {
      if (!track.current) return; // dados antes de qualquer init: impossivel interpretar
      if (track.current.part.offset !== offset) newPart(track, track.current.run, offset);
      track.current.part.chunks.push(copy);
    }
    track.current.part.bytes += copy.length;
    track.bytes += copy.length;
    totalCaptured += copy.length;
    if (totalCaptured > config.maxCaptureBytes) {
      track.group.overflow = true;
      post('mse-overflow', { groupId: track.group.id });
    }
  }

  function updateCoverage(track) {
    try {
      const b = track.sb.buffered;
      for (let i = 0; i < b.length; i++) addRange(track.ranges, b.start(i), b.end(i));
    } catch {
      /* SourceBuffer removido */
    }
  }

  function addRange(ranges, start, end) {
    ranges.push([start, end]);
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1] + 0.25) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    ranges.length = 0;
    ranges.push(...merged);
  }

  const covered = (ranges) => ranges.reduce((n, r) => n + (r[1] - r[0]), 0);

  if (NativeMediaSource) {
    const nativeAddSourceBuffer = NativeMediaSource.prototype.addSourceBuffer;
    NativeMediaSource.prototype.addSourceBuffer = function (mimeType) {
      const sb = nativeAddSourceBuffer.call(this, mimeType);
      try {
        const group = groupFor(this);
        const track = {
          group,
          sb,
          mimeType,
          kind: /^audio\//i.test(mimeType) ? 'audio' : 'video',
          runs: new Map(),
          current: null,
          bytes: 0,
          ranges: [],
        };
        group.tracks.push(track);
        sb.__vepTrack = track;
        sb.addEventListener('updateend', () => {
          updateCoverage(track);
          scheduleReport(group);
        });
      } catch {
        /* ignora */
      }
      return sb;
    };
  }

  if (window.SourceBuffer) {
    const nativeAppend = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (data) {
      try {
        if (config.captureMSE && data) recordAppend(this, data);
      } catch {
        /* nunca quebrar o player */
      }
      return nativeAppend.call(this, data);
    };

    // Depois de abort() o proximo append pode comecar no meio de uma caixa:
    // abre uma parte nova (com o init) para nao corromper a leitura.
    const nativeAbort = SourceBuffer.prototype.abort;
    SourceBuffer.prototype.abort = function (...args) {
      try {
        const track = this.__vepTrack;
        if (track && track.current) newPart(track, track.current.run, this.timestampOffset || 0);
      } catch {
        /* ignora */
      }
      return nativeAbort.apply(this, args);
    };
  }

  // DRM (EME): o que chega ao SourceBuffer esta criptografado. Marcamos e nao oferecemos.
  if (window.HTMLMediaElement && HTMLMediaElement.prototype.setMediaKeys) {
    const nativeSetMediaKeys = HTMLMediaElement.prototype.setMediaKeys;
    HTMLMediaElement.prototype.setMediaKeys = function (keys) {
      if (keys) this.__vepDrm = true;
      return nativeSetMediaKeys.call(this, keys);
    };
  }

  function elementFor(group) {
    if (!group.blobUrl) return null;
    for (const el of document.querySelectorAll('video, audio')) {
      if (el.src === group.blobUrl || el.currentSrc === group.blobUrl) return el;
    }
    return null;
  }

  function grabThumb(el) {
    try {
      if (!(el instanceof HTMLVideoElement) || !el.videoWidth || el.readyState < 2) return '';
      const canvas = document.createElement('canvas');
      canvas.width = 192;
      canvas.height = 108;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 192, 108);
      const scale = Math.min(192 / el.videoWidth, 108 / el.videoHeight);
      const w = el.videoWidth * scale;
      const h = el.videoHeight * scale;
      ctx.drawImage(el, (192 - w) / 2, (108 - h) / 2, w, h);
      return canvas.toDataURL('image/jpeg', 0.7);
    } catch {
      return '';
    }
  }

  function scheduleReport(group) {
    if (group.reportTimer) return;
    const wait = Math.max(0, 1000 - (Date.now() - group.lastReport));
    group.reportTimer = setTimeout(() => {
      group.reportTimer = null;
      group.lastReport = Date.now();
      post('mse-group', summarizeGroup(group));
    }, wait);
  }

  function summarizeGroup(group) {
    const el = elementFor(group);
    let duration = 0;
    try {
      duration = isFinite(group.ms.duration) ? group.ms.duration : 0;
    } catch {
      /* ignora */
    }
    if (!duration && el && isFinite(el.duration)) duration = el.duration;

    if (el && !group.thumb && Date.now() - group.thumbAt > 5000) {
      group.thumbAt = Date.now();
      group.thumb = grabThumb(el);
    }
    if (!group.title) group.title = bestTitle();

    const tracks = group.tracks.filter((t) => t.bytes > 0);
    const coveredAll = tracks.length ? Math.min(...tracks.map((t) => covered(t.ranges))) : 0;
    return {
      groupId: group.id,
      title: group.title,
      thumb: group.thumb,
      duration,
      covered: coveredAll,
      bytes: tracks.reduce((n, t) => n + t.bytes, 0),
      tracks: tracks.map((t) => ({ kind: t.kind, mimeType: t.mimeType, bytes: t.bytes, covered: covered(t.ranges) })),
      width: el?.videoWidth || 0,
      height: el?.videoHeight || 0,
      drm: Boolean(el && (el.__vepDrm || el.mediaKeys)),
      overflow: Boolean(group.overflow),
      capturing: Boolean(group.fullCapture),
    };
  }

  function bestTitle() {
    const og = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
    return (og || document.title || 'captura').trim().slice(0, 150);
  }

  function saveGroup(groupId, filename) {
    const group = groups.get(groupId);
    if (!group) return;
    const summary = summarizeGroup(group);
    if (summary.drm) {
      post('capture-result', { groupId, ok: false, error: 'Conteudo protegido por DRM' });
      return;
    }
    const tracks = group.tracks.filter((t) => t.bytes > 0);
    if (!tracks.length) {
      post('capture-result', { groupId, ok: false, error: 'Nada capturado ainda: de play no video' });
      return;
    }

    const base = (filename || summary.title || 'captura').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 150);
    const captures = tracks.map((t) => ({
      runs: [...t.runs.values()].map((run) => ({
        parts: run.parts.map((p) => ({ bytes: concat(p.chunks), offset: p.offset })),
      })),
    }));

    try {
      const mux = window.__vepMux;
      if (!mux) throw new Error('remuxador indisponivel');
      const result = mux.remux(captures);
      download(new Blob(result.chunks, { type: result.mime }), `${base}.${result.ext}`);
      post('capture-result', {
        groupId,
        ok: true,
        ext: result.ext,
        duration: result.duration,
        tracks: result.tracks,
        warnings: result.warnings,
      });
    } catch (err) {
      // Plano B: entrega as faixas cruas, separadas (juntar com ffmpeg).
      tracks.forEach((t) => {
        const parts = [...t.runs.values()].flatMap((r) => r.parts.flatMap((p) => p.chunks));
        const ext = /webm/i.test(t.mimeType) ? 'webm' : 'mp4';
        download(new Blob(parts, { type: t.mimeType.split(';')[0] }), `${base} (${t.kind}).${ext}`);
      });
      post('capture-result', { groupId, ok: false, fallback: true, error: String(err?.message || err) });
    }
  }

  function concat(chunks) {
    let n = 0;
    for (const c of chunks) n += c.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  function download(blob, name) {
    const url = nativeCreateObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 120_000);
  }

  /**
   * "Capturar inteiro": volta ao inicio e toca acelerado e mudo, para o player
   * buscar o video todo. Restaura o estado do usuario no fim.
   */
  function startFullCapture(groupId, rate) {
    const group = groups.get(groupId);
    const el = group && elementFor(group);
    if (!el) {
      post('capture-result', { groupId, ok: false, error: 'Player nao encontrado na pagina' });
      return;
    }
    if (group.fullCapture) return;
    const saved = { time: el.currentTime, rate: el.playbackRate, muted: el.muted, paused: el.paused };
    group.fullCapture = { saved };

    const finish = (reason) => {
      if (!group.fullCapture) return;
      clearInterval(group.fullCapture.timer);
      group.fullCapture = null;
      try {
        el.pause();
        el.playbackRate = saved.rate;
        el.muted = saved.muted;
        el.currentTime = saved.time;
        if (!saved.paused) el.play().catch(() => {});
      } catch {
        /* ignora */
      }
      post('mse-group', summarizeGroup(group));
      post('capture-full-done', { groupId, reason });
    };
    group.fullCapture.finish = finish;

    try {
      el.muted = true;
      el.currentTime = 0;
      el.playbackRate = rate || 16;
      el.play().catch(() => {});
    } catch {
      finish('erro');
      return;
    }

    // Velocidade adaptativa: se o player fica esperando dados, desacelera
    // (16x -> 8x -> 4x -> 2x). So desiste se nem o tempo nem os bytes avancam por 45s.
    let currentRate = rate || 16;
    let lastTime = -1;
    let lastBytes = -1;
    let stalledTicks = 0;
    let idleTicks = 0;
    group.fullCapture.timer = setInterval(() => {
      const d = isFinite(el.duration) ? el.duration : 0;
      // Para antes do fim: alguns sites (YouTube) pulam para o proximo video ao terminar.
      if (d && el.currentTime >= d - 0.6) return finish('fim');
      if (el.ended) return finish('fim');
      if (!el.isConnected || !el.src) return finish('player-sumiu');
      if (el.playbackRate !== currentRate) el.playbackRate = currentRate; // o site pode ter revertido
      if (!el.muted) el.muted = true;
      if (el.paused) el.play().catch(() => {});

      const bytes = group.tracks.reduce((n, t) => n + t.bytes, 0);
      const timeMoved = Math.abs(el.currentTime - lastTime) > 0.01;
      stalledTicks = timeMoved ? 0 : stalledTicks + 1;
      idleTicks = timeMoved || bytes !== lastBytes ? 0 : idleTicks + 1;
      lastTime = el.currentTime;
      lastBytes = bytes;

      if (stalledTicks >= 10 && currentRate > 2) {
        currentRate = Math.max(2, currentRate / 2);
        stalledTicks = 0;
      }
      if (idleTicks > 90) return finish('travou');
      scheduleReport(group);
    }, 500);
    scheduleReport(group);
  }

  function stopFullCapture(groupId) {
    groups.get(groupId)?.fullCapture?.finish('cancelado');
  }

  // --------------------------------------------- elementos <video>/<audio>

  function reportMediaElement(el) {
    if (!el) return;
    const src = el.currentSrc || el.src || '';
    if (src && !src.startsWith('blob:')) {
      reportUrl(src, {
        source: 'element',
        duration: el.duration,
        width: el.videoWidth || 0,
        height: el.videoHeight || 0,
        poster: el.poster || '',
      });
    }
    for (const source of el.querySelectorAll ? el.querySelectorAll('source') : []) {
      if (source.src) reportUrl(source.src, { source: 'element', mimeType: source.type || '' });
    }
    if (src.startsWith('blob:')) {
      post('blob-element', {
        blobUrl: src,
        duration: el.duration,
        width: el.videoWidth || 0,
        height: el.videoHeight || 0,
        poster: el.poster || '',
      });
    }
  }

  const mediaElementProto = window.HTMLMediaElement && HTMLMediaElement.prototype;
  if (mediaElementProto) {
    const descriptor = Object.getOwnPropertyDescriptor(mediaElementProto, 'src');
    if (descriptor && descriptor.set) {
      Object.defineProperty(mediaElementProto, 'src', {
        ...descriptor,
        set(value) {
          descriptor.set.call(this, value);
          try {
            if (typeof value === 'string' && !value.startsWith('blob:')) {
              reportUrl(value, { source: 'element-src' });
            }
          } catch {
            /* ignora */
          }
        },
      });
    }
    document.addEventListener(
      'loadedmetadata',
      (e) => {
        if (e.target instanceof HTMLMediaElement) reportMediaElement(e.target);
      },
      true
    );
    document.addEventListener(
      'play',
      (e) => {
        if (e.target instanceof HTMLMediaElement) reportMediaElement(e.target);
      },
      true
    );
  }

  // ------------------------------------------------------------ controle

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.channel !== 'vep-control') return;
    switch (msg.type) {
      case 'config':
        config = { ...config, ...msg.data };
        break;
      case 'save-capture':
        saveGroup(msg.data.groupId, msg.data.filename);
        break;
      case 'capture-full':
        startFullCapture(msg.data.groupId, msg.data.rate);
        break;
      case 'capture-stop':
        stopFullCapture(msg.data.groupId);
        break;
      case 'list-captures':
        groups.forEach((g) => post('mse-group', summarizeGroup(g)));
        break;
      case 'scan-elements':
        document.querySelectorAll('video, audio').forEach(reportMediaElement);
        break;
      default:
        break;
    }
  });

  post('ready', {});
})();
