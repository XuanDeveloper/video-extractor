// Executa no mundo isolado: varre o DOM, recebe o que o hook da pagina achou
// e envia tudo para o service worker.

(() => {
  if (window.__vepContentInstalled) return;
  window.__vepContentInstalled = true;

  const MEDIA_RE = /(https?:\/\/[^\s"'<>\\,)\]}]+?\.(?:m3u8|mpd|mp4|m4v|webm|mkv|mov|flv|avi|mp3|m4a|aac|ogg|wav|ts)(?:\?[^\s"'<>\\,)\]}]*)?)/gi;

  const queue = new Map(); // url -> candidato
  const sentUrls = new Set();
  const groups = new Map(); // groupId -> resumo do player capturado
  let flushTimer = null;
  let scanTimer = null;

  function send(action, payload) {
    try {
      return chrome.runtime.sendMessage({ target: 'bg', action, payload }).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  function enqueue(candidate) {
    if (!candidate || !candidate.url) return;
    let abs;
    try {
      abs = new URL(candidate.url, location.href).href;
    } catch {
      return;
    }
    if (!/^https?:/i.test(abs)) return;
    const key = abs.split('#')[0];
    if (sentUrls.has(key)) return;
    const previous = queue.get(key) || {};
    queue.set(key, { ...previous, ...candidate, url: abs });
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 350);
  }

  function flush() {
    flushTimer = null;
    if (!queue.size) return;
    const items = [...queue.values()].slice(0, 80);
    for (const item of items) sentUrls.add(item.url.split('#')[0]);
    queue.clear();
    send('media.found', { items });
  }

  // ------------------------------------------------------------ varredura

  function scanMediaElements() {
    for (const el of document.querySelectorAll('video, audio')) {
      const src = el.currentSrc || el.getAttribute('src') || '';
      if (src && !src.startsWith('blob:')) {
        enqueue({
          url: src,
          source: 'dom',
          resourceType: 'media',
          duration: isFinite(el.duration) ? el.duration : 0,
          width: el.videoWidth || 0,
          height: el.videoHeight || 0,
          poster: el.poster || '',
          title: bestTitleFor(el),
        });
      }
      for (const source of el.querySelectorAll('source')) {
        const s = source.getAttribute('src') || source.getAttribute('data-src');
        if (s) {
          enqueue({
            url: s,
            source: 'dom',
            resourceType: 'media',
            mimeType: source.getAttribute('type') || '',
            title: bestTitleFor(el),
          });
        }
      }
    }
  }

  const DATA_ATTRS = [
    'data-src', 'data-video', 'data-video-src', 'data-url', 'data-mp4', 'data-hls',
    'data-file', 'data-stream', 'data-source', 'data-setup', 'data-config', 'content',
  ];

  function scanAttributes() {
    const selector = DATA_ATTRS.map((a) => `[${a}]`).join(',');
    let count = 0;
    for (const el of document.querySelectorAll(selector)) {
      if (count > 2000) break;
      count++;
      for (const attr of DATA_ATTRS) {
        const value = el.getAttribute(attr);
        if (!value || value.length > 5000) continue;
        if (/\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|flv|mp3|m4a|aac|ogg|wav)(\?|$)/i.test(value)) {
          enqueue({ url: value, source: 'dom-attr', title: bestTitleFor(el) });
        } else if (value.includes('http') && value.length < 5000) {
          scanText(value, 'dom-attr');
        }
      }
    }
  }

  function scanJsonLd() {
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try {
        data = JSON.parse(node.textContent);
      } catch {
        continue;
      }
      walkJsonLd(data);
    }
  }

  function walkJsonLd(node, depth = 0) {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      node.forEach((n) => walkJsonLd(n, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;
    const type = node['@type'];
    if (type === 'VideoObject' || type === 'AudioObject' || (Array.isArray(type) && type.includes('VideoObject'))) {
      const url = node.contentUrl || node.embedUrl;
      if (url) {
        enqueue({
          url,
          source: 'json-ld',
          title: node.name || document.title,
          poster: typeof node.thumbnailUrl === 'string' ? node.thumbnailUrl : '',
          duration: isoDurationToSeconds(node.duration),
        });
      }
    }
    for (const value of Object.values(node)) walkJsonLd(value, depth + 1);
  }

  function isoDurationToSeconds(value) {
    if (!value || typeof value !== 'string') return 0;
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(value.trim());
    if (!m) return 0;
    return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
  }

  function scanInlineScripts() {
    let budget = 60;
    for (const node of document.querySelectorAll('script:not([src])')) {
      if (budget-- <= 0) break;
      const text = node.textContent;
      if (!text || text.length > 600_000) continue;
      if (!/m3u8|mpd|\.mp4|\.webm|\.flv|videoplayback/i.test(text)) continue;
      scanText(text, 'inline-script');
    }
  }

  function scanText(text, source) {
    MEDIA_RE.lastIndex = 0;
    let m;
    let found = 0;
    while ((m = MEDIA_RE.exec(text)) !== null && found < 40) {
      const url = m[1].replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
      enqueue({ url, source });
      found++;
    }
  }

  function bestTitleFor(el) {
    const candidates = [
      el.getAttribute && el.getAttribute('title'),
      el.getAttribute && el.getAttribute('aria-label'),
      el.closest && el.closest('[data-title]')?.getAttribute('data-title'),
      document.querySelector('meta[property="og:title"]')?.getAttribute('content'),
      document.title,
    ];
    return (candidates.find((c) => c && c.trim()) || '').trim().slice(0, 180);
  }

  function fullScan() {
    try {
      scanMediaElements();
      scanAttributes();
      scanJsonLd();
      scanInlineScripts();
      postToPage('scan-elements', {});
    } catch {
      /* paginas hostis */
    }
  }

  function scheduleScan(delay = 600) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(fullScan, delay);
  }

  // --------------------------------------------------- ponte com a pagina

  function postToPage(type, data) {
    window.postMessage({ channel: 'vep-control', type, data }, '*');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== 'vep-page') return;
    const { type, data } = msg;

    switch (type) {
      case 'ready':
        pushConfig();
        break;
      case 'media':
        enqueue({ ...data, source: data.source || 'page-hook' });
        break;
      case 'mse-group':
        groups.set(data.groupId, data);
        reportGroup(data);
        break;
      case 'capture-result': {
        const waiter = pendingSaves.get(data.groupId);
        if (waiter) {
          pendingSaves.delete(data.groupId);
          waiter(data);
        }
        break;
      }
      case 'capture-full-done':
        send('capture.status', { url: captureUrl(data.groupId), capturing: false, reason: data.reason });
        break;
      default:
        break;
    }
  });

  const captureUrl = (groupId) => `vep-capture://${location.host}/${groupId}`;
  const pendingSaves = new Map();

  // So reporta o que pode ser util: grupos com algum dado (o filtro final e no worker).
  function reportGroup(g) {
    if (!g.bytes) return;
    const hasVideo = g.tracks.some((t) => t.kind === 'video');
    send('capture.ready', {
      url: captureUrl(g.groupId),
      container: 'webm',
      mimeType: g.tracks.map((t) => t.mimeType).join(' + '),
      size: g.bytes,
      duration: g.duration,
      covered: g.covered,
      width: g.width,
      height: g.height,
      thumb: g.thumb,
      drm: g.drm ? 'EME' : null,
      capturing: g.capturing,
      overflow: g.overflow,
      tracks: g.tracks,
      hasVideo,
      title: g.title,
    });
  }

  async function pushConfig() {
    let maxCaptureMB = 1024;
    try {
      const data = await chrome.storage.local.get('settings');
      if (data?.settings?.maxCaptureMB) maxCaptureMB = data.settings.maxCaptureMB;
    } catch {
      /* ignora */
    }
    postToPage('config', { captureMSE: true, maxCaptureBytes: maxCaptureMB * 1024 * 1024 });
  }

  // -------------------------------------------------- mensagens da extensao

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== 'content') return;
    const groupId = msg.payload?.groupId;
    // Varios frames recebem a mensagem: so responde quem tem o player.
    if (groupId && !groups.has(groupId)) return;

    if (msg.action === 'capture.save') {
      const timer = setTimeout(() => {
        pendingSaves.delete(groupId);
        sendResponse({ ok: false, error: 'A pagina nao respondeu' });
      }, 120_000);
      pendingSaves.set(groupId, (result) => {
        clearTimeout(timer);
        sendResponse({ ok: true, data: result });
      });
      postToPage('save-capture', { groupId, filename: msg.payload.filename });
      return true;
    }
    if (msg.action === 'capture.full') {
      postToPage('capture-full', { groupId, rate: msg.payload.rate });
      sendResponse({ ok: true });
      return false;
    }
    if (msg.action === 'capture.stop') {
      postToPage('capture-stop', { groupId });
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  window.addEventListener('vep:rescan', () => {
    sentUrls.clear();
    fullScan();
  });

  // ------------------------------------------------------------- arranque

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.addedNodes.length) {
        scheduleScan(800);
        return;
      }
    }
  });

  function start() {
    send('page.info', { pageUrl: location.href, pageTitle: document.title });
    fullScan();
    try {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
      /* ignora */
    }
    // Players costumam montar a fonte depois do load.
    [1200, 3000, 6000].forEach((t) => setTimeout(fullScan, t));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  window.addEventListener('pagehide', flush);
  pushConfig();
})();
