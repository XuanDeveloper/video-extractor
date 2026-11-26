// Liga um <video> a qualquer fonte detectada: arquivo direto, HLS (hls.js) ou DASH (dash.js).
// Requer window.Hls e window.dashjs carregados por <script> classico (src/vendor).

/**
 * @param {HTMLVideoElement} video
 * @param {{kind:string, url:string, variantUrl?:string, lowQuality?:boolean, autoplay?:boolean}} source
 * @returns {{destroy:Function, setQuality?:Function}}
 */
export function attachSource(video, source) {
  const { kind, url } = source;

  if (kind === 'hls') return attachHls(video, source);
  if (kind === 'dash') return attachDash(video, source);

  // Arquivo progressivo / audio. 'use-credentials' + permissao de host = sem bloqueio de CORS
  // e canvas nao fica "tainted" (permite gerar miniatura).
  video.crossOrigin = 'use-credentials';
  video.src = url;
  return {
    destroy() {
      video.removeAttribute('src');
      video.load();
    },
  };
}

function attachHls(video, { url, variantUrl, lowQuality, autoplay }) {
  const Hls = globalThis.Hls;
  if (Hls && Hls.isSupported()) {
    const hls = new Hls({
      enableWorker: false, // CSP de extensao bloqueia worker via blob:
      startLevel: lowQuality ? 0 : -1,
      capLevelToPlayerSize: Boolean(lowQuality),
      maxBufferLength: lowQuality ? 4 : 30,
      xhrSetup(xhr) {
        xhr.withCredentials = true;
      },
    });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (variantUrl && variantUrl !== url) {
        const index = hls.levels.findIndex((l) => (l.url || []).includes(variantUrl) || l.uri === variantUrl);
        if (index >= 0) hls.currentLevel = index;
      }
      if (autoplay) video.play().catch(() => {});
    });

    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else video.dispatchEvent(new CustomEvent('vep-error', { detail: data.details || 'Erro no HLS' }));
    });

    hls.loadSource(url);
    hls.attachMedia(video);

    return {
      destroy() {
        hls.destroy();
      },
      setQuality(targetUrl) {
        const index = hls.levels.findIndex((l) => (l.url || []).includes(targetUrl) || l.uri === targetUrl);
        hls.currentLevel = index; // -1 = automatico
      },
    };
  }

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = variantUrl || url;
    return {
      destroy() {
        video.removeAttribute('src');
        video.load();
      },
    };
  }

  throw new Error('Este navegador nao reproduz HLS');
}

function attachDash(video, { url, lowQuality, autoplay }) {
  const dashjs = globalThis.dashjs;
  if (!dashjs) throw new Error('dash.js nao carregado');

  const player = dashjs.MediaPlayer().create();
  player.updateSettings({
    debug: { logLevel: dashjs.Debug.LOG_LEVEL_NONE },
    streaming: {
      buffer: { bufferTimeAtTopQuality: lowQuality ? 4 : 30 },
      abr: lowQuality ? { initialBitrate: { video: 100 }, autoSwitchBitrate: { video: false } } : {},
    },
  });
  player.extend('RequestModifier', () => ({
    modifyRequest(request) {
      if (request) request.withCredentials = true;
      return request;
    },
    modifyRequestHeader(xhr) {
      xhr.withCredentials = true;
      return xhr;
    },
  }));
  player.on(dashjs.MediaPlayer.events.ERROR, (e) => {
    video.dispatchEvent(new CustomEvent('vep-error', { detail: e?.error?.message || 'Erro no DASH' }));
  });
  player.initialize(video, url, Boolean(autoplay));

  return {
    destroy() {
      try {
        player.reset();
      } catch {
        /* ignora */
      }
    },
  };
}

/** Resolve quando o evento ocorrer; rejeita em erro ou timeout. */
export function waitForEvent(video, event, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Tempo esgotado (${event})`)), timeout);
    const onOk = () => finish(null);
    const onErr = (e) => finish(new Error(e?.detail || video.error?.message || 'Falha ao carregar a midia'));
    function finish(err) {
      clearTimeout(timer);
      video.removeEventListener(event, onOk);
      video.removeEventListener('error', onErr);
      video.removeEventListener('vep-error', onErr);
      err ? reject(err) : resolve();
    }
    video.addEventListener(event, onOk, { once: true });
    video.addEventListener('error', onErr, { once: true });
    video.addEventListener('vep-error', onErr, { once: true });
  });
}
