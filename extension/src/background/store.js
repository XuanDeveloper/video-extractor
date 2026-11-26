// Registro de midia encontrada, por aba. Persiste em chrome.storage.session
// para sobreviver ao desligamento do service worker.

import { hashString, normalizeUrl } from '../lib/utils.js';
import { isPrimary } from '../lib/classify.js';

const MAX_ITEMS_PER_TAB = 400;
const STORAGE_KEY = 'vep_tabs';

/** @type {Map<number, {pageUrl:string, pageTitle:string, items:Map<string, object>}>} */
const tabs = new Map();

let loaded = false;
let saveTimer = null;
const listeners = new Set();

export async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const data = await chrome.storage.session.get(STORAGE_KEY);
    const raw = data[STORAGE_KEY];
    if (raw) {
      for (const [tabIdStr, saved] of Object.entries(raw)) {
        const tabId = Number(tabIdStr);
        const tab = getTab(tabId);
        tab.pageUrl = tab.pageUrl || saved.pageUrl || '';
        tab.pageTitle = tab.pageTitle || saved.pageTitle || '';
        // Itens detectados enquanto o storage era lido tem prioridade.
        for (const item of saved.items || []) {
          if (!tab.items.has(item.id)) tab.items.set(item.id, item);
        }
      }
    }
  } catch {
    /* storage.session indisponivel: segue so em memoria */
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const out = {};
    for (const [tabId, tab] of tabs) {
      out[tabId] = {
        pageUrl: tab.pageUrl,
        pageTitle: tab.pageTitle,
        items: [...tab.items.values()],
      };
    }
    try {
      await chrome.storage.session.set({ [STORAGE_KEY]: out });
    } catch {
      /* ignora */
    }
  }, 400);
}

function getTab(tabId) {
  let tab = tabs.get(tabId);
  if (!tab) {
    tab = { pageUrl: '', pageTitle: '', items: new Map() };
    tabs.set(tabId, tab);
  }
  return tab;
}

export function idFor(url) {
  return 'm' + hashString(normalizeUrl(url));
}

/**
 * Adiciona ou funde um item de midia.
 * @returns {{item:object, isNew:boolean}|null}
 */
export function upsert(tabId, partial) {
  if (tabId == null || tabId < 0 || !partial || !partial.url) return null;
  const tab = getTab(tabId);
  const id = partial.id || idFor(partial.url);
  const existing = tab.items.get(id);

  if (existing) {
    let changed = false;
    for (const [k, v] of Object.entries(partial)) {
      if (v == null || v === '' || k === 'id') continue;
      if (k === 'sources') continue;
      if (existing[k] == null || existing[k] === '' || existing[k] === 0) {
        existing[k] = v;
        changed = true;
      }
    }
    if (partial.source && !existing.sources.includes(partial.source)) {
      existing.sources.push(partial.source);
      changed = true;
    }
    existing.lastSeen = Date.now();
    if (changed) {
      scheduleSave();
      notify(tabId);
    }
    return { item: existing, isNew: false };
  }

  if (tab.items.size >= MAX_ITEMS_PER_TAB) {
    // descarta o fragmento mais antigo para abrir espaco
    const oldestSegment = [...tab.items.values()]
      .filter((i) => !isPrimary(i.kind))
      .sort((a, b) => a.firstSeen - b.firstSeen)[0];
    if (oldestSegment) tab.items.delete(oldestSegment.id);
    else return null;
  }

  const item = {
    id,
    url: partial.url,
    kind: partial.kind || 'other',
    container: partial.container || '',
    mimeType: partial.mimeType || '',
    size: partial.size || 0,
    duration: partial.duration || 0,
    width: partial.width || 0,
    height: partial.height || 0,
    title: partial.title || '',
    pageUrl: partial.pageUrl || tab.pageUrl || '',
    pageTitle: partial.pageTitle || tab.pageTitle || '',
    method: partial.method || 'GET',
    requestHeaders: partial.requestHeaders || null,
    poster: partial.poster || '',
    sources: [partial.source || 'network'],
    probe: partial.probe || null,
    probeState: partial.probeState || 'idle',
    drm: partial.drm || null,
    note: partial.note || '',
    firstSeen: Date.now(),
    lastSeen: Date.now(),
  };
  tab.items.set(id, item);
  scheduleSave();
  notify(tabId);
  return { item, isNew: true };
}

export function patch(tabId, id, changes) {
  const tab = tabs.get(tabId);
  if (!tab) return null;
  const item = tab.items.get(id);
  if (!item) return null;
  Object.assign(item, changes, { lastSeen: Date.now() });
  scheduleSave();
  notify(tabId);
  return item;
}

export function get(tabId, id) {
  return tabs.get(tabId)?.items.get(id) || null;
}

export function findAnywhere(id) {
  for (const [tabId, tab] of tabs) {
    const item = tab.items.get(id);
    if (item) return { tabId, item };
  }
  return null;
}

export function list(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return { pageUrl: '', pageTitle: '', items: [] };
  return {
    pageUrl: tab.pageUrl,
    pageTitle: tab.pageTitle,
    items: [...tab.items.values()].sort((a, b) => b.firstSeen - a.firstSeen),
  };
}

export function countPrimary(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return 0;
  let n = 0;
  for (const item of tab.items.values()) if (isPrimary(item.kind)) n++;
  return n;
}

export function setPageInfo(tabId, { pageUrl, pageTitle }) {
  const tab = getTab(tabId);
  if (pageUrl) tab.pageUrl = pageUrl;
  if (pageTitle) tab.pageTitle = pageTitle;
  scheduleSave();
}

export function clearTab(tabId, { keepPageInfo = true } = {}) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  tab.items.clear();
  if (!keepPageInfo) {
    tab.pageUrl = '';
    tab.pageTitle = '';
  }
  scheduleSave();
  notify(tabId);
}

export function removeTab(tabId) {
  tabs.delete(tabId);
  scheduleSave();
}

export function removeItem(tabId, id) {
  const tab = tabs.get(tabId);
  if (tab && tab.items.delete(id)) {
    scheduleSave();
    notify(tabId);
  }
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(tabId) {
  for (const fn of listeners) {
    try {
      fn(tabId);
    } catch {
      /* ignora */
    }
  }
}
