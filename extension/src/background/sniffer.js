// Observa o trafego da aba (GET/POST/fetch/XHR/media) procurando midia.

import { classify, KIND, findMediaUrlsInText } from '../lib/classify.js';
import * as store from './store.js';
import { probeManifest } from './probe.js';

// Cabecalhos usados para repetir a requisicao no download.
// Cookie/Authorization nao sao guardados: o fetch da extensao ja vai com credentials: 'include'.
const REPLAY_HEADERS = new Set(['referer', 'origin', 'user-agent', 'x-requested-with']);
const pendingHeaders = new Map(); // requestId -> {headers, method, body, tabId}
const PENDING_TTL = 60_000;

const IGNORED_SCHEMES = /^(chrome|chrome-extension|devtools|about|edge|moz-extension):/i;

function cleanupPending() {
  const now = Date.now();
  for (const [id, entry] of pendingHeaders) {
    if (now - entry.at > PENDING_TTL) pendingHeaders.delete(id);
  }
}

function headerValue(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === lower) return h.value || '';
  }
  return '';
}

function pickReplayHeaders(headers) {
  const out = {};
  if (!headers) return out;
  for (const h of headers) {
    const name = h.name.toLowerCase();
    if (REPLAY_HEADERS.has(name) && h.value) out[name] = h.value;
  }
  return out;
}

function decodeRequestBody(requestBody) {
  if (!requestBody) return '';
  try {
    if (requestBody.formData) {
      return Object.entries(requestBody.formData)
        .map(([k, v]) => `${k}=${[].concat(v).join(',')}`)
        .join('&');
    }
    if (requestBody.raw && requestBody.raw.length) {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      return requestBody.raw
        .map((part) => (part.bytes ? decoder.decode(new Uint8Array(part.bytes)) : ''))
        .join('')
        .slice(0, 200_000);
    }
  } catch {
    /* ignora corpos binarios */
  }
  return '';
}

export function installSniffer() {
  const filter = { urls: ['<all_urls>'] };

  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0 || IGNORED_SCHEMES.test(details.url)) return;
      cleanupPending();

      const body = details.method !== 'GET' ? decodeRequestBody(details.requestBody) : '';
      pendingHeaders.set(details.requestId, {
        at: Date.now(),
        method: details.method,
        body,
        tabId: details.tabId,
        url: details.url,
      });

      // URLs de midia escondidas dentro do corpo de um POST (players que enviam JSON).
      if (body) {
        for (const found of findMediaUrlsInText(body, 20)) {
          record(details.tabId, {
            url: found,
            mimeType: '',
            resourceType: 'other',
            source: 'post-body',
            method: details.method,
            note: 'Encontrado no corpo da requisicao',
          });
        }
      }

      record(details.tabId, {
        url: details.url,
        mimeType: '',
        resourceType: details.type,
        source: 'network',
        method: details.method,
        requireHighConfidence: true,
      });
    },
    filter,
    ['requestBody']
  );

  const beforeSendExtra = ['requestHeaders'];
  try {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        const entry = pendingHeaders.get(details.requestId);
        if (entry) entry.headers = pickReplayHeaders(details.requestHeaders);
      },
      filter,
      chrome.webRequest.OnBeforeSendHeadersOptions?.EXTRA_HEADERS
        ? [...beforeSendExtra, 'extraHeaders']
        : beforeSendExtra
    );
  } catch {
    chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
      const entry = pendingHeaders.get(details.requestId);
      if (entry) entry.headers = pickReplayHeaders(details.requestHeaders);
    }, filter, beforeSendExtra);
  }

  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (details.tabId < 0 || IGNORED_SCHEMES.test(details.url)) return;
      const headers = details.responseHeaders || [];
      const contentType = headerValue(headers, 'content-type');
      const contentLength = Number(headerValue(headers, 'content-length')) || 0;
      const contentRange = headerValue(headers, 'content-range');
      const disposition = headerValue(headers, 'content-disposition');

      let totalSize = contentLength;
      if (contentRange) {
        const m = /\/(\d+)\s*$/.exec(contentRange);
        if (m) totalSize = Number(m[1]);
      }

      const entry = pendingHeaders.get(details.requestId);
      record(details.tabId, {
        url: details.url,
        mimeType: contentType,
        resourceType: details.type,
        size: totalSize,
        source: 'network',
        method: entry?.method || details.method || 'GET',
        requestHeaders: entry?.headers || null,
        title: filenameFromDisposition(disposition),
        isPartial: Boolean(contentRange),
      });

      pendingHeaders.delete(details.requestId);
    },
    filter,
    ['responseHeaders']
  );

  chrome.webRequest.onErrorOccurred.addListener((details) => {
    pendingHeaders.delete(details.requestId);
  }, filter);
}

function filenameFromDisposition(value) {
  if (!value) return '';
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(value);
  if (star) {
    try {
      return decodeURIComponent(star[1].replace(/"/g, '').trim());
    } catch {
      /* segue */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(value);
  return plain ? plain[1].trim() : '';
}

/**
 * Classifica e registra uma URL observada.
 */
export function record(tabId, input) {
  if (tabId == null || tabId < 0) return null;
  const { url } = input;
  if (!url || IGNORED_SCHEMES.test(url)) return null;

  const result = classify({
    url,
    mimeType: input.mimeType,
    contentLength: input.size,
    resourceType: input.resourceType,
  });
  if (!result) return null;
  if (input.requireHighConfidence && result.confidence < 0.9) return null;

  // Respostas parciais (Range) de arquivo progressivo: o tamanho real vem do Content-Range.
  const added = store.upsert(tabId, {
    url,
    kind: result.kind,
    container: result.container,
    mimeType: input.mimeType || '',
    size: input.size || 0,
    width: input.width || 0,
    height: input.height || 0,
    duration: input.duration || 0,
    title: input.title || '',
    pageUrl: input.pageUrl || '',
    pageTitle: input.pageTitle || '',
    method: input.method || 'GET',
    requestHeaders: input.requestHeaders || null,
    poster: input.poster || '',
    source: input.source || 'network',
    note: input.note || '',
  });

  if (!added) return null;

  // Manifests sao sondados automaticamente para descobrir qualidades/duracao.
  if (added.isNew && (result.kind === KIND.HLS || result.kind === KIND.DASH)) {
    probeManifest(tabId, added.item.id).catch(() => {});
  }

  return added;
}
