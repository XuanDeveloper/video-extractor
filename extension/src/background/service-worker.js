// Service worker: orquestra deteccao, estado por aba, sondagem e downloads.

import * as store from './store.js';
import { installSniffer, record } from './sniffer.js';
import { probeManifest } from './probe.js';
import * as jobs from './jobs.js';
import { ensureOffscreen, callOffscreen } from './offscreen.js';
import { KIND } from '../lib/classify.js';
import { hostOf } from '../lib/utils.js';
import { filterUseful } from './relevance.js';

const DEFAULT_SETTINGS = {
  showSegments: false,
  concurrency: 6,
  retries: 3,
  maxCaptureMB: 1024,
  badge: true,
  saveAs: false,
  downloadSubfolder: 'VideoExtractor',
};

let settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  const data = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  return settings;
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

// ---------------------------------------------------------------- bootstrap

installSniffer();
store.ensureLoaded();
jobs.ensureJobsLoaded();
loadSettings();

chrome.runtime.onInstalled.addListener(() => {
  loadSettings();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'vep-scan',
      title: 'Procurar videos nesta pagina',
      contexts: ['page', 'video', 'audio', 'frame'],
    });
    chrome.contextMenus.create({
      id: 'vep-capture-link',
      title: 'Extrair este video com o Video Extractor',
      contexts: ['video', 'audio'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'vep-scan') {
    await rescan(tab.id);
  } else if (info.menuItemId === 'vep-capture-link' && info.srcUrl) {
    record(tab.id, {
      url: info.srcUrl,
      source: 'context-menu',
      resourceType: 'media',
      pageUrl: tab.url,
      pageTitle: tab.title,
    });
  }
  try {
    chrome.action.openPopup?.()?.catch?.(() => {});
  } catch {
    /* openPopup exige gesto do usuario em algumas versoes */
  }
});

// ------------------------------------------------------------ ciclo da aba

chrome.tabs.onRemoved.addListener((tabId) => store.removeTab(tabId));


chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    // Navegacao de verdade: limpa a lista anterior.
    store.clearTab(tabId, { keepPageInfo: false });
    store.setPageInfo(tabId, { pageUrl: changeInfo.url, pageTitle: tab.title || '' });
    updateBadge(tabId);
  } else if (changeInfo.title) {
    store.setPageInfo(tabId, { pageTitle: changeInfo.title });
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => updateBadge(tabId));

store.onChange((tabId) => updateBadge(tabId));

let badgeTimer = null;
function updateBadge(tabId) {
  if (!settings.badge || tabId == null || tabId < 0) return;
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    const count = filterUseful(store.list(tabId).items).visible.length;
    chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#d6353b' }).catch(() => {});
  }, 150);
}

// --------------------------------------------------------------- mensagens

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return; // nao e para nos
  handleMessage(msg, sender)
    .then((result) => sendResponse({ ok: true, data: result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

async function handleMessage(msg, sender) {
  const { action, payload = {} } = msg;
  const senderTabId = sender?.tab?.id;

  switch (action) {
    // ----- vindo do content script
    case 'page.info': {
      if (senderTabId == null) return null;
      store.setPageInfo(senderTabId, { pageUrl: payload.pageUrl, pageTitle: payload.pageTitle });
      return null;
    }

    case 'media.found': {
      if (senderTabId == null) return null;
      await store.ensureLoaded();
      let added = 0;
      for (const candidate of payload.items || []) {
        const res = record(senderTabId, {
          ...candidate,
          pageUrl: candidate.pageUrl || sender.tab.url,
          pageTitle: candidate.pageTitle || sender.tab.title,
        });
        if (res?.isNew) added++;
      }
      return { added };
    }

    case 'capture.ready': {
      if (senderTabId == null) return null;
      const live = {
        size: payload.size || 0,
        duration: payload.duration || 0,
        covered: payload.covered || 0,
        width: payload.width || 0,
        height: payload.height || 0,
        capturing: Boolean(payload.capturing),
        overflow: Boolean(payload.overflow),
        hasVideo: Boolean(payload.hasVideo),
        tracks: payload.tracks || [],
        drm: payload.drm || null,
        mimeType: payload.mimeType || '',
      };
      if (payload.thumb) live.thumb = payload.thumb;
      const added = store.upsert(senderTabId, {
        url: payload.url,
        kind: KIND.CAPTURE,
        container: 'webm',
        title: payload.title || sender.tab.title || '',
        pageUrl: sender.tab.url,
        pageTitle: sender.tab.title,
        source: 'mse-capture',
        ...live,
      });
      // A captura cresce enquanto o video toca: upsert nao sobrescreve campos, entao forcamos.
      if (added && !added.isNew) store.patch(senderTabId, added.item.id, live);
      return null;
    }

    case 'capture.status': {
      if (senderTabId == null) return null;
      const id = store.idFor(payload.url);
      if (store.get(senderTabId, id)) store.patch(senderTabId, id, { capturing: Boolean(payload.capturing) });
      return null;
    }

    // ----- vindo do popup
    case 'state': {
      await store.ensureLoaded();
      await jobs.ensureJobsLoaded();
      const tabId = payload.tabId;
      const data = store.list(tabId);
      const { visible, hidden } = filterUseful(data.items, { showAll: settings.showSegments });
      return {
        ...data,
        items: visible,
        hiddenCount: hidden,
        jobs: jobs.listJobs(),
        settings,
      };
    }

    case 'probe':
      return probeManifest(payload.tabId, payload.itemId, { force: payload.force });

    case 'rescan':
      return rescan(payload.tabId);

    case 'clear':
      store.clearTab(payload.tabId);
      updateBadge(payload.tabId);
      return null;

    case 'thumbs.request':
      requestThumbs(payload.tabId, payload.ids || []);
      return null;

    case 'preview.rules':
      return setPreviewRules(payload);

    case 'item.remove':
      store.removeItem(payload.tabId, payload.itemId);
      return null;

    case 'download':
      return startDownload(payload);

    case 'jobs.list':
      await jobs.ensureJobsLoaded();
      return jobs.listJobs();

    case 'job.cancel':
      return jobs.cancelJob(payload.jobId);

    case 'jobs.clear':
      jobs.clearFinishedJobs();
      return null;

    case 'settings.get':
      return settings;

    case 'settings.set':
      return saveSettings(payload);

    case 'capture.save':
      // A captura MSE vive no contexto da pagina: pedimos a ela que salve.
      return chrome.tabs.sendMessage(payload.tabId, {
        target: 'content',
        action: 'capture.save',
        payload,
      });

    case 'capture.full':
    case 'capture.stop': {
      const res = await chrome.tabs.sendMessage(payload.tabId, { target: 'content', action, payload });
      const id = store.idFor(`vep-capture://${payload.host}/${payload.groupId}`);
      if (store.get(payload.tabId, id)) store.patch(payload.tabId, id, { capturing: action === 'capture.full' });
      return res;
    }

    // ----- vindo do offscreen
    case 'job.progress':
      jobs.handleProgress(payload);
      return null;

    case 'download.save':
      return saveBlobDownload(payload);

    case 'dnr.install':
      return installHeaderRules(payload);

    case 'dnr.remove':
      return removeHeaderRules(payload.ruleIds || []);

    default:
      throw new Error(`Acao desconhecida: ${action}`);
  }
}

// Salva no disco um blob: URL criado pelo offscreen e libera a memoria ao terminar.
async function saveBlobDownload({ url, filename, saveAs }) {
  const downloadId = await chrome.downloads.download({
    url,
    filename,
    saveAs: Boolean(saveAs),
    conflictAction: 'uniquify',
  });
  const listener = (delta) => {
    if (delta.id !== downloadId || !delta.state) return;
    if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
      chrome.downloads.onChanged.removeListener(listener);
      setTimeout(() => callOffscreen('blob.revoke', { url }).catch(() => {}), 2000);
    }
  };
  chrome.downloads.onChanged.addListener(listener);
  return { downloadId };
}

// ------------------------------------------------------------- miniaturas

const THUMB_KINDS = new Set([KIND.FILE, KIND.HLS, KIND.DASH]);
const THUMB_CONCURRENCY = 2;
const thumbQueue = [];
let thumbsRunning = 0;

function requestThumbs(tabId, ids) {
  for (const id of ids) {
    const item = store.get(tabId, id);
    if (!item || item.thumb || item.drm || !THUMB_KINDS.has(item.kind)) continue;
    if (item.thumbState === 'queued' || item.thumbState === 'loading' || item.thumbState === 'error') continue;
    store.patch(tabId, id, { thumbState: 'queued' });
    thumbQueue.push({ tabId, id });
  }
  pumpThumbs();
}

function pumpThumbs() {
  while (thumbsRunning < THUMB_CONCURRENCY && thumbQueue.length) {
    const { tabId, id } = thumbQueue.shift();
    const item = store.get(tabId, id);
    if (!item) continue;
    thumbsRunning++;
    store.patch(tabId, id, { thumbState: 'loading' });

    const headers = { ...(item.requestHeaders || {}) };
    if (!headers.referer && item.pageUrl) headers.referer = item.pageUrl;

    callOffscreen('thumb', { kind: item.kind, url: item.url, headers }, { timeout: 60_000 })
      .then((res) => {
        if (!res?.ok) throw new Error(res?.error || 'falhou');
        const d = res.data;
        store.patch(tabId, id, {
          thumb: d.thumb,
          thumbState: 'done',
          duration: item.duration || d.duration || 0,
          width: item.width || d.width || 0,
          height: item.height || d.height || 0,
        });
      })
      .catch(() => store.patch(tabId, id, { thumbState: 'error' }))
      .finally(() => {
        thumbsRunning--;
        pumpThumbs();
      });
  }
}

// Regras de Referer enquanto o player do popup toca (substitui as anteriores).
let previewRuleIds = [];
async function setPreviewRules({ urls = [], referer = '', origin = '' }) {
  await removeHeaderRules(previewRuleIds);
  previewRuleIds = [];
  if (!urls.length) return { ruleIds: [] };
  const res = await installHeaderRules({ urls, referer, origin });
  previewRuleIds = res.ruleIds || [];
  return res;
}

async function rescan(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => window.dispatchEvent(new CustomEvent('vep:rescan')),
    });
  } catch {
    /* paginas restritas */
  }
  return store.list(tabId).items.length;
}

// --------------------------------------------------------------- downloads

async function startDownload(payload) {
  await ensureOffscreen();
  const spec = {
    ...payload.spec,
    concurrency: settings.concurrency,
    retries: settings.retries,
    subfolder: settings.downloadSubfolder,
  };
  return jobs.startJob(spec);
}

// Referer/Origin nao podem ser definidos por fetch(); usamos declarativeNetRequest.
let ruleIdSeq = 9000;

async function installHeaderRules({ urls = [], referer = '', origin = '', cookie = '' }) {
  const hosts = [...new Set(urls.map(hostOf).filter(Boolean))];
  if (!hosts.length || (!referer && !origin)) return { ruleIds: [] };

  const requestHeaders = [];
  if (referer) requestHeaders.push({ header: 'referer', operation: 'set', value: referer });
  if (origin) requestHeaders.push({ header: 'origin', operation: 'set', value: origin });
  if (cookie) requestHeaders.push({ header: 'cookie', operation: 'set', value: cookie });
  if (!requestHeaders.length) return { ruleIds: [] };

  const rules = hosts.map((host) => ({
    id: ++ruleIdSeq,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders },
    condition: {
      requestDomains: [host],
      resourceTypes: ['xmlhttprequest', 'other', 'media'],
      tabIds: [chrome.tabs.TAB_ID_NONE],
    },
  }));

  try {
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules });
    return { ruleIds: rules.map((r) => r.id) };
  } catch (err) {
    // Sem DNR o download segue: muitos servidores nao exigem Referer.
    return { ruleIds: [], warning: String(err?.message || err) };
  }
}

async function removeHeaderRules(ruleIds) {
  if (!ruleIds.length) return null;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds });
  } catch {
    /* ignora */
  }
  return null;
}
