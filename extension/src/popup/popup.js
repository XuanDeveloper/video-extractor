import {
  formatBytes,
  formatDuration,
  formatBitrate,
  sanitizeFilename,
  basenameOf,
  hostOf,
} from '../lib/utils.js';
import { attachSource } from '../lib/player.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  tabId: null,
  items: [],
  jobs: [],
  settings: {},
  filter: 'all',
  search: '',
  selected: new Set(),
  quality: new Map(), // itemId -> valor escolhido no <select>
  pageTitle: '',
  renderSig: '',
  thumbsAsked: new Set(),
  preview: null, // { itemId, handle }
};

const PREVIEWABLE = new Set(['file', 'hls', 'dash', 'audio']);

const KIND_LABEL = {
  file: 'Arquivo',
  hls: 'HLS',
  dash: 'DASH',
  audio: 'Áudio',
  capture: 'Captura',
  segment: 'Fragmento',
  other: 'Outro',
};

// ----------------------------------------------------------------- setup

init();

async function init() {
  const params = new URLSearchParams(location.search);
  if (params.get('standalone')) document.body.classList.add('standalone');

  const forced = Number(params.get('tabId'));
  if (forced) {
    state.tabId = forced;
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.tabId = tab?.id ?? null;
  }

  wireUi();
  await refresh();
  setInterval(refresh, 2000);
}

async function send(action, payload = {}) {
  const res = await chrome.runtime.sendMessage({ target: 'bg', action, payload });
  if (!res) throw new Error('Sem resposta do service worker');
  if (!res.ok) throw new Error(res.error || 'Erro desconhecido');
  return res.data;
}

async function refresh() {
  if (state.tabId == null) return;
  try {
    const data = await send('state', { tabId: state.tabId });
    state.items = data.items || [];
    state.jobs = data.jobs || [];
    state.settings = data.settings || {};
    state.pageTitle = data.pageTitle || '';
    state.hiddenCount = data.hiddenCount || 0;
    $('#pageTitle').textContent = data.pageTitle || data.pageUrl || '—';
    applySettingsToForm();
    renderList();
    renderJobs();
  } catch (err) {
    toast(String(err.message || err));
  }
}

function wireUi() {
  $$('.tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab.dataset.tab));
    })
  );

  $('#chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    $$('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderList();
  });

  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value.trim().toLowerCase();
    renderList();
  });

  $('#btnRescan').addEventListener('click', async () => {
    await send('rescan', { tabId: state.tabId });
    toast('Procurando de novo…');
    setTimeout(refresh, 900);
  });

  $('#btnClear').addEventListener('click', async () => {
    closePreview();
    await send('clear', { tabId: state.tabId });
    state.selected.clear();
    refresh();
  });

  $('#btnExpandWindow').addEventListener('click', () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL(`src/popup/popup.html?standalone=1&tabId=${state.tabId}`),
    });
  });

  $('#selectAll').addEventListener('change', (e) => {
    const visible = visibleItems();
    if (e.target.checked) visible.forEach((i) => state.selected.add(i.id));
    else visible.forEach((i) => state.selected.delete(i.id));
    renderList();
  });

  $('#btnDownloadSelected').addEventListener('click', async () => {
    const ids = [...state.selected];
    let started = 0;
    for (const id of ids) {
      const item = state.items.find((i) => i.id === id);
      if (!item) continue;
      try {
        await downloadItem(item);
        started++;
      } catch (err) {
        toast(`${shortTitle(item)}: ${err.message}`);
      }
    }
    if (started) {
      toast(`${started} download(s) na fila`);
      state.selected.clear();
      renderList();
      switchTo('queue');
    }
  });

  $('#btnClearJobs').addEventListener('click', async () => {
    await send('jobs.clear');
    refresh();
  });

  $('#playerClose').addEventListener('click', () => closePreview());
  $('#playerDownload').addEventListener('click', async () => {
    const item = state.items.find((i) => i.id === state.preview?.itemId);
    if (!item) return;
    try {
      await downloadItem(item);
      toast('Download iniciado');
    } catch (err) {
      toast(err.message);
    }
  });
  $('#playerQuality').addEventListener('change', (e) => {
    const value = e.target.value;
    const item = state.items.find((i) => i.id === state.preview?.itemId);
    if (!item || !state.preview?.handle?.setQuality) return;
    state.preview.handle.setQuality(value === 'auto' ? '' : item.probe.variants[Number(value)].url);
    if (value !== 'auto') {
      state.quality.set(item.id, value);
      state.renderSig = '';
      renderList();
    }
  });
  window.addEventListener('pagehide', () => send('preview.rules', { urls: [] }).catch(() => {}));

  bindSetting('#setConcurrency', 'concurrency', 'number');
  bindSetting('#setRetries', 'retries', 'number');
  bindSetting('#setSubfolder', 'downloadSubfolder', 'text');
  bindSetting('#setMaxCapture', 'maxCaptureMB', 'number');
  bindSetting('#setShowSegments', 'showSegments', 'bool');
  bindSetting('#setBadge', 'badge', 'bool');
  bindSetting('#setSaveAs', 'saveAs', 'bool');

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== 'popup') return;
    if (msg.action === 'job.update') {
      const index = state.jobs.findIndex((j) => j.id === msg.payload.id);
      if (index >= 0) state.jobs[index] = msg.payload;
      else state.jobs.unshift(msg.payload);
      renderJobs();
    } else if (msg.action === 'jobs.refresh') {
      refresh();
    }
  });
}

function switchTo(name) {
  const tab = $$('.tab').find((t) => t.dataset.tab === name);
  if (tab) tab.click();
}

function bindSetting(selector, key, type) {
  const el = $(selector);
  el.addEventListener('change', async () => {
    const value = type === 'bool' ? el.checked : type === 'number' ? Number(el.value) : el.value;
    state.settings = await send('settings.set', { [key]: value });
    if (key === 'showSegments') refresh();
  });
}

function applySettingsToForm() {
  const s = state.settings;
  if (document.activeElement && document.activeElement.closest('.settings')) return;
  $('#setConcurrency').value = s.concurrency ?? 6;
  $('#setRetries').value = s.retries ?? 3;
  $('#setSubfolder').value = s.downloadSubfolder ?? '';
  $('#setMaxCapture').value = s.maxCaptureMB ?? 1024;
  $('#setShowSegments').checked = Boolean(s.showSegments);
  $('#setBadge').checked = s.badge !== false;
  $('#setSaveAs').checked = Boolean(s.saveAs);
}

// ---------------------------------------------------------------- render

function visibleItems() {
  return state.items.filter((item) => {
    if (state.filter !== 'all' && item.kind !== state.filter) return false;
    if (!state.search) return true;
    const haystack = `${item.title} ${item.url} ${item.container} ${item.pageTitle}`.toLowerCase();
    return haystack.includes(state.search);
  });
}

function signature(items) {
  return JSON.stringify([
    state.filter,
    state.search,
    [...state.selected],
    [...state.quality],
    state.preview?.itemId || '',
    items.map((i) => [
      i.id, i.title, i.size, i.duration, i.height, i.drm, i.note, i.probeState,
      i.probe?.variants?.length || 0, i.thumbState, i.thumb ? i.thumb.length : 0, i.sources?.length,
      Math.round(i.covered || 0), i.capturing,
    ]),
  ]);
}

function renderList() {
  const list = $('#list');
  const items = visibleItems();

  $('#countMedia').textContent = String(state.items.length);
  $('#empty').style.display = items.length ? 'none' : 'block';
  $('#hiddenInfo').textContent = state.hiddenCount
    ? `${state.hiddenCount} item(ns) inútil(eis) escondido(s): fragmentos, anúncios, sons da página.`
    : '';

  // So redesenha quando algo mudou: evita piscar as miniaturas a cada refresh.
  const sig = signature(items);
  if (sig === state.renderSig) return;
  state.renderSig = sig;

  const scroll = list.scrollTop;
  list.textContent = '';
  for (const item of items) list.appendChild(renderCard(item));
  list.scrollTop = scroll;
  askForThumbs(items);

  const selectedVisible = items.filter((i) => state.selected.has(i.id)).length;
  $('#selectionInfo').textContent = `${selectedVisible} selecionado${selectedVisible === 1 ? '' : 's'}`;
  $('#selectAll').checked = items.length > 0 && selectedVisible === items.length;
  $('#btnDownloadSelected').disabled = selectedVisible === 0;
}

function renderCard(item) {
  const card = document.createElement('div');
  card.className = 'card' + (state.selected.has(item.id) ? ' selected' : '');

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = state.selected.has(item.id);
  check.disabled = Boolean(item.drm);
  check.addEventListener('change', () => {
    if (check.checked) state.selected.add(item.id);
    else state.selected.delete(item.id);
    renderList();
  });
  card.appendChild(check);
  card.appendChild(renderThumb(item));
  if (state.preview?.itemId === item.id) card.classList.add('playing');

  const body = document.createElement('div');
  body.className = 'card-body';
  card.appendChild(body);

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = shortTitle(item);
  title.title = item.title || item.url;
  body.appendChild(title);

  const url = document.createElement('div');
  url.className = 'card-url';
  url.textContent = item.url.startsWith('vep-capture://') ? 'Capturado da memória do player' : item.url;
  body.appendChild(url);

  body.appendChild(renderBadges(item));

  const probe = item.probe;
  if ((item.kind === 'hls' || item.kind === 'dash') && probe?.variants?.length > 1) {
    body.appendChild(renderQualityPicker(item, probe));
  } else if (item.probeState === 'loading') {
    body.appendChild(hint('Lendo manifest…'));
  } else if (item.probeState === 'error') {
    body.appendChild(hint(item.note || 'Não foi possível ler o manifest', 'error'));
  }

  if (item.drm) {
    body.appendChild(hint(`Protegido por DRM (${item.drm}) — download bloqueado.`, 'error'));
  } else if (probe?.hasSeparateAudio || (item.kind === 'dash' && probe?.variants?.some((v) => v.type === 'audio'))) {
    body.appendChild(
      hint('Vídeo e áudio estão em faixas separadas: baixe as duas e junte com ffmpeg.', 'warn')
    );
  }

  if (item.kind === 'capture') {
    const total = item.duration || 0;
    const got = item.covered || 0;
    if (item.capturing) {
      body.appendChild(hint('Tocando acelerado e sem som para receber o vídeo inteiro… Mantenha a aba aberta.', 'warn'));
    } else if (total && got < total - 2) {
      body.appendChild(
        hint(`O player só entregou ${formatDuration(got)} de ${formatDuration(total)}. Clique em "Capturar inteiro" para pegar tudo.`, 'warn')
      );
    } else {
      body.appendChild(hint('Vídeo completo recebido. "Baixar" salva vídeo + áudio num arquivo só.'));
    }
    if (item.overflow) body.appendChild(hint('Limite de memória atingido (ajuste em Opções).', 'error'));
  } else if (probe?.isLive) {
    body.appendChild(hint('Ao vivo: baixa só o trecho disponível na playlist agora.', 'warn'));
  } else if (item.note && item.probeState !== 'error') {
    body.appendChild(hint(item.note));
  }

  body.appendChild(renderActions(item));
  return card;
}

function renderBadges(item) {
  const wrap = document.createElement('div');
  wrap.className = 'badges';

  const add = (text, cls = '') => {
    if (!text) return;
    const b = document.createElement('span');
    b.className = `badge ${cls}`.trim();
    b.textContent = text;
    wrap.appendChild(b);
  };

  add(KIND_LABEL[item.kind] || item.kind, `kind-${item.kind}`);
  if (item.container && item.kind !== 'capture') add(item.container.toUpperCase());
  if (item.drm) add(`DRM ${item.drm}`, 'drm');
  if (item.probe?.isLive) add('AO VIVO', 'live');

  const height = item.height || item.probe?.height;
  if (height) add(`${height}p`);
  const duration = item.duration || item.probe?.duration;
  if (item.kind === 'capture') {
    const kinds = (item.tracks || []).map((t) => (t.kind === 'audio' ? 'áudio' : 'vídeo'));
    if (kinds.length) add(kinds.join(' + '));
    if (duration) add(`${formatDuration(item.covered || 0)} de ${formatDuration(duration)}`);
    if (item.capturing) add('CAPTURANDO', 'live');
  } else if (duration) {
    add(formatDuration(duration));
  }
  if (item.size) add(formatBytes(item.size));
  if (item.probe?.variants?.length > 1) add(`${item.probe.variants.length} qualidades`);
  if (item.method && item.method !== 'GET') add(item.method);
  add(hostOf(item.url) || '');
  add(item.sources?.[0] || '');

  return wrap;
}

function renderQualityPicker(item, probe) {
  const wrap = document.createElement('div');
  wrap.className = 'quality';

  const select = document.createElement('select');
  probe.variants.forEach((variant, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    const bits = [variant.label];
    if (variant.width && variant.height) bits.push(`${variant.width}x${variant.height}`);
    if (variant.bandwidth) bits.push(formatBitrate(variant.bandwidth));
    if (variant.codecs) bits.push(variant.codecs.split(',')[0]);
    option.textContent = bits.filter(Boolean).join(' · ');
    select.appendChild(option);
  });
  select.value = state.quality.get(item.id) ?? '0';
  select.addEventListener('change', () => {
    state.quality.set(item.id, select.value);
    if (state.preview?.itemId === item.id) {
      state.preview.handle?.setQuality?.(probe.variants[Number(select.value)].url);
      $('#playerQuality').value = select.value;
    }
  });
  wrap.appendChild(select);

  return wrap;
}

function hint(text, cls = '') {
  const el = document.createElement('div');
  el.className = `hint ${cls}`.trim();
  el.textContent = text;
  return el;
}

function renderActions(item) {
  const wrap = document.createElement('div');
  wrap.className = 'card-actions';

  const button = (label, handler, title = '') => {
    const b = document.createElement('button');
    b.className = 'mini';
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', handler);
    wrap.appendChild(b);
    return b;
  };

  const dl = button(item.kind === 'capture' ? '⬇ Baixar (vídeo + áudio)' : '⬇ Baixar', async (e) => {
    e.target.disabled = true;
    try {
      await downloadItem(item);
      if (item.kind !== 'capture') {
        // capturas sao salvas direto pela pagina e mostram o proprio aviso
        toast('Download iniciado');
        switchTo('queue');
      }
    } catch (err) {
      toast(err.message);
    } finally {
      e.target.disabled = false;
    }
  });
  if (item.drm) {
    dl.disabled = true;
    dl.title = 'Conteúdo com DRM';
  }

  if (item.kind === 'capture') {
    const groupId = item.url.split('/').pop();
    const host = item.url.split('/')[2];
    if (item.capturing) {
      button('■ Parar', async () => {
        await send('capture.stop', { tabId: state.tabId, groupId, host });
        refresh();
      });
    } else if (item.duration && (item.covered || 0) < item.duration - 2) {
      button('⏩ Capturar inteiro', async () => {
        try {
          await send('capture.full', { tabId: state.tabId, groupId, host, rate: 16 });
          toast('Capturando… o vídeo vai tocar acelerado e sem som');
          refresh();
        } catch (err) {
          toast(err.message);
        }
      }, 'Toca o vídeo acelerado (16x) e sem som para o player baixar tudo');
    }
  }

  if (!item.url.startsWith('vep-capture://')) {
    button('Copiar URL', () => {
      navigator.clipboard.writeText(item.url);
      toast('URL copiada');
    });
    button('ffmpeg', () => {
      navigator.clipboard.writeText(ffmpegCommand(item));
      toast('Comando ffmpeg copiado');
    }, 'Copia um comando ffmpeg equivalente');
    button('Abrir', () => chrome.tabs.create({ url: item.url }));
  }

  if ((item.kind === 'hls' || item.kind === 'dash') && item.probeState !== 'loading') {
    button('⟳ Reler', async () => {
      await send('probe', { tabId: state.tabId, itemId: item.id, force: true });
      refresh();
    });
  }

  button('✕', async () => {
    if (state.preview?.itemId === item.id) closePreview();
    await send('item.remove', { tabId: state.tabId, itemId: item.id });
    state.selected.delete(item.id);
    refresh();
  }, 'Remover da lista');

  return wrap;
}

// ------------------------------------------------------------ miniaturas

function renderThumb(item) {
  const btn = document.createElement('button');
  btn.className = 'thumb';
  const canPreview = PREVIEWABLE.has(item.kind) && !item.drm;
  btn.disabled = !canPreview;
  btn.title = canPreview ? 'Assistir preview' : item.drm ? 'Protegido por DRM' : 'Sem preview';

  const imageUrl = item.thumb || item.poster;
  if (imageUrl) {
    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = '';
    img.addEventListener('error', () => img.remove());
    btn.appendChild(img);
  } else {
    const label = document.createElement('span');
    const loading = item.thumbState === 'queued' || item.thumbState === 'loading';
    label.className = 'thumb-label' + (loading ? ' loading' : '');
    label.textContent =
      item.kind === 'audio' ? '\u266A ÁUDIO'
      : item.kind === 'capture' ? 'MSE'
      : item.drm ? 'DRM'
      : loading ? '…'
      : (item.container || KIND_LABEL[item.kind] || '').toUpperCase();
    btn.appendChild(label);
  }

  if (canPreview) {
    const play = document.createElement('span');
    play.className = 'play';
    btn.appendChild(play);
  }

  const duration = item.duration || item.probe?.duration;
  if (item.probe?.isLive || duration) {
    const dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = item.probe?.isLive ? 'AO VIVO' : formatDuration(duration);
    btn.appendChild(dur);
  }

  if (canPreview) btn.addEventListener('click', () => openPreview(item));
  return btn;
}

function askForThumbs(items) {
  const ids = items
    .filter((i) => !i.thumb && !i.poster && !i.drm && ['file', 'hls', 'dash'].includes(i.kind))
    .filter((i) => !i.thumbState || i.thumbState === 'idle')
    .map((i) => i.id)
    .filter((id) => !state.thumbsAsked.has(id))
    .slice(0, 12);
  if (!ids.length) return;
  ids.forEach((id) => state.thumbsAsked.add(id));
  send('thumbs.request', { tabId: state.tabId, ids }).catch(() => {});
}

// --------------------------------------------------------------- preview

async function openPreview(item) {
  closePreview({ keepPane: true });

  const pane = $('#player');
  const video = $('#playerVideo');
  const status = $('#playerStatus');
  pane.hidden = false;
  pane.scrollIntoView({ block: 'nearest' });
  $('#playerTitle').textContent = shortTitle(item);
  $('#playerInfo').textContent = '';
  video.poster = item.thumb || item.poster || '';
  setStatus('Carregando…');

  // Referer da pagina original para CDNs que exigem.
  const variant = chosenVariant(item);
  const referer = item.requestHeaders?.referer || item.pageUrl || '';
  const urls = [item.url, ...(item.probe?.variants || []).map((v) => v.url)].filter(Boolean);
  try {
    await send('preview.rules', { urls, referer, origin: originOf(referer) });
  } catch {
    /* segue sem regras */
  }

  fillPlayerQuality(item, variant);

  const token = Symbol('preview');
  let handle;
  try {
    handle = attachSource(video, {
      kind: item.kind === 'audio' ? 'file' : item.kind,
      url: item.url,
      variantUrl: variant?.type === 'audio' ? undefined : variant?.url,
      autoplay: true,
    });
  } catch (err) {
    setStatus(err.message, true);
    return;
  }
  state.preview = { itemId: item.id, handle, token };
  state.renderSig = '';
  renderList();

  const isCurrent = () => state.preview?.token === token;
  const onReady = () => {
    if (!isCurrent()) return;
    setStatus('');
    const bits = [];
    if (video.videoWidth) bits.push(`${video.videoWidth}x${video.videoHeight}`);
    if (isFinite(video.duration) && video.duration > 0) bits.push(formatDuration(video.duration));
    $('#playerInfo').textContent = bits.join(' · ');
  };
  video.onloadeddata = onReady;
  video.onresize = onReady;
  video.onerror = () => isCurrent() && setStatus(mediaErrorText(video), true);
  video.addEventListener('vep-error', (e) => isCurrent() && setStatus(e.detail || 'Erro ao reproduzir', true));
  video.play().catch(() => {
    /* autoplay pode ser bloqueado: o usuario clica em play */
  });

  function setStatus(text, isError = false) {
    status.hidden = !text;
    status.textContent = text;
    status.classList.toggle('error', isError);
  }
}

function fillPlayerQuality(item, variant) {
  const select = $('#playerQuality');
  select.textContent = '';
  const variants = (item.probe?.variants || []).filter((v) => v.type !== 'audio');
  const canSwitch = item.kind === 'hls' && variants.length > 1;
  select.hidden = !canSwitch;
  if (!canSwitch) return;

  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = 'Automático';
  select.appendChild(auto);
  item.probe.variants.forEach((v, index) => {
    if (v.type === 'audio') return;
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = v.label;
    select.appendChild(option);
  });
  select.value =
    state.quality.has(item.id) && variant?.type !== 'audio' ? state.quality.get(item.id) : 'auto';
}

function closePreview({ keepPane = false } = {}) {
  const video = $('#playerVideo');
  video.pause();
  video.onerror = null;
  video.onloadeddata = null;
  video.onresize = null;
  try {
    state.preview?.handle?.destroy();
  } catch {
    /* ignora */
  }
  video.removeAttribute('src');
  video.removeAttribute('poster');
  video.load();
  const hadPreview = Boolean(state.preview);
  state.preview = null;
  if (!keepPane) {
    $('#player').hidden = true;
    send('preview.rules', { urls: [] }).catch(() => {});
  }
  if (hadPreview) {
    state.renderSig = '';
    renderList();
  }
}

function mediaErrorText(video) {
  const code = video.error?.code;
  if (code === 4) return 'Formato não suportado pelo navegador (o download ainda pode funcionar).';
  if (code === 2) return 'Erro de rede ao carregar o vídeo.';
  if (code === 3) return 'Erro ao decodificar o vídeo.';
  return 'Não foi possível reproduzir.';
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

// -------------------------------------------------------------- download

function chosenVariant(item) {
  const probe = item.probe;
  if (!probe?.variants?.length) return null;
  const index = Number(state.quality.get(item.id) ?? 0);
  return probe.variants[index] || probe.variants[0];
}

function buildFilename(item, variant) {
  const base =
    item.title ||
    state.pageTitle ||
    item.pageTitle ||
    basenameOf(item.url).replace(/\.[a-z0-9]+$/i, '');
  const quality = variant?.label ? ` ${variant.label}` : item.height ? ` ${item.height}p` : '';
  return sanitizeFilename(`${base}${quality}`, 'video');
}

async function downloadItem(item) {
  if (item.drm) throw new Error(`Bloqueado: DRM ${item.drm}`);

  if (item.kind === 'capture' || item.url.startsWith('vep-capture://')) {
    const res = await send('capture.save', {
      tabId: state.tabId,
      groupId: item.url.split('/').pop(),
      filename: buildFilename(item, null),
    });
    const result = res?.data || res;
    if (!result) throw new Error('A página não respondeu (recarregue a aba)');
    if (result.fallback) throw new Error(`Não deu para juntar (${result.error}); salvei as faixas separadas`);
    if (!result.ok) throw new Error(result.error || 'Falha ao salvar');
    toast(`Salvo: ${result.ext.toUpperCase()} com ${result.tracks.map((t) => t.type).join(' + ')}, ${formatDuration(result.duration)}`);
    return;
  }

  const variant = chosenVariant(item);
  const headers = item.requestHeaders || {};
  if (!headers.referer && item.pageUrl) headers.referer = item.pageUrl;

  let spec;
  if (item.kind === 'hls') {
    spec = {
      type: 'hls',
      manifestUrl: item.url,
      variantUrl: variant?.url || item.url,
      container: variant?.container || 'ts',
      filename: buildFilename(item, variant),
      headers,
      saveAs: Boolean(state.settings.saveAs),
    };
  } else if (item.kind === 'dash') {
    spec = {
      type: 'dash',
      manifestUrl: item.url,
      representationId: variant?.representationId,
      periodIndex: variant?.periodIndex,
      container: variant?.container || 'mp4',
      filename: buildFilename(item, variant),
      headers,
      saveAs: Boolean(state.settings.saveAs),
    };
  } else {
    spec = {
      type: 'file',
      url: item.url,
      container: item.container || 'mp4',
      expectedSize: item.size || 0,
      filename: buildFilename(item, null),
      headers,
      saveAs: Boolean(state.settings.saveAs),
    };
  }

  await send('download', { spec });
}

function ffmpegCommand(item) {
  const variant = chosenVariant(item);
  const url = variant?.url || item.url;
  const out = `${buildFilename(item, variant)}.${variant?.container || item.container || 'mp4'}`;
  const referer = item.requestHeaders?.referer || item.pageUrl || '';
  const headerArg = referer ? ` -headers "Referer: ${referer}\\r\\n"` : '';
  return `ffmpeg${headerArg} -i "${url}" -c copy "${out}"`;
}

// ------------------------------------------------------------------ jobs

function renderJobs() {
  const wrap = $('#jobs');
  const active = state.jobs.filter((j) => j.status === 'running' || j.status === 'queued').length;
  $('#countQueue').textContent = String(active);
  $('#jobsEmpty').style.display = state.jobs.length ? 'none' : 'block';

  wrap.textContent = '';
  for (const job of state.jobs) wrap.appendChild(renderJob(job));
}

function renderJob(job) {
  const el = document.createElement('div');
  el.className = `job ${job.status}`;

  const head = document.createElement('div');
  head.className = 'job-head';

  const title = document.createElement('div');
  title.className = 'job-title';
  title.textContent = job.title;
  title.title = job.sourceUrl || '';
  head.appendChild(title);

  if (job.status === 'running' || job.status === 'queued') {
    const cancel = document.createElement('button');
    cancel.className = 'mini';
    cancel.textContent = 'Cancelar';
    cancel.addEventListener('click', async () => {
      await send('job.cancel', { jobId: job.id });
      refresh();
    });
    head.appendChild(cancel);
  }
  el.appendChild(head);

  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('span');
  fill.style.width = `${job.status === 'done' ? 100 : job.progress || 0}%`;
  bar.appendChild(fill);
  el.appendChild(bar);

  const meta = document.createElement('div');
  meta.className = 'job-meta';

  const left = document.createElement('span');
  left.textContent = job.error
    ? job.error
    : job.segmentsTotal
      ? `${job.stage} · ${job.segmentsDone}/${job.segmentsTotal} segmentos`
      : job.stage || job.status;
  meta.appendChild(left);

  const right = document.createElement('span');
  right.textContent = job.received ? formatBytes(job.received) : '';
  meta.appendChild(right);
  el.appendChild(meta);

  if (job.note) {
    const note = document.createElement('div');
    note.className = 'hint warn';
    note.textContent = job.note;
    el.appendChild(note);
  }

  return el;
}

// ----------------------------------------------------------------- toast

let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function shortTitle(item) {
  if (item.title) return item.title;
  const name = basenameOf(item.url);
  if (name && name !== '/' && !/^\d+$/.test(name)) return name;
  return `${KIND_LABEL[item.kind] || 'Mídia'} · ${hostOf(item.url)}`;
}
