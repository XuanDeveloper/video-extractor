// Utilidades compartilhadas (service worker, offscreen e popup).

export function uid(prefix = 'm') {
  return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** Hash estavel de string -> id curto (usado para deduplicar por URL). */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function safeUrl(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

/** Remove partes volateis da URL para deduplicar. */
const RANGE_PARAMS = ['range', 'rn', 'rbuf', 'bytestart', 'byteend', 'bytes'];

export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const p of RANGE_PARAMS) u.searchParams.delete(p);
    return u.href;
  } catch {
    return url;
  }
}

export function pathname(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url).split('?')[0];
  }
}

export function extOf(url) {
  const p = pathname(url);
  const i = p.lastIndexOf('.');
  if (i < 0) return '';
  return p.slice(i + 1).toLowerCase().split('/')[0];
}

export function basenameOf(url) {
  const p = pathname(url);
  const name = p.split('/').filter(Boolean).pop() || 'video';
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// eslint-disable-next-line no-control-regex -- control chars are illegal in filenames
const ILLEGAL_FILENAME = /[\x00-\x1f\x7f\\/:*?"<>|]/g;

export function sanitizeFilename(name, fallback = 'video') {
  let out = String(name || '')
    .replace(ILLEGAL_FILENAME, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 150)
    .trim();
  if (!out) out = fallback;
  return out;
}

export function formatBytes(bytes) {
  if (bytes == null || !isFinite(bytes) || bytes <= 0) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatDuration(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds <= 0) return '--';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function formatBitrate(bps) {
  if (!bps || !isFinite(bps)) return '';
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  return `${Math.round(bps / 1e3)} kbps`;
}

export function concatBuffers(chunks) {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c instanceof Uint8Array ? c : new Uint8Array(c), off);
    off += c.byteLength;
  }
  return out;
}

/** Parser de lista de atributos no formato HLS: A=1,B="x,y",C=0x00 */
export function parseAttrList(input) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let m;
  while ((m = re.exec(input)) !== null) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    let value = m[2];
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[m[1].toUpperCase()] = value;
  }
  return out;
}

export function hexToBytes(hex) {
  const clean = String(hex).replace(/^0x/i, '');
  const out = new Uint8Array(Math.ceil(clean.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16) || 0;
  }
  return out;
}

/** Executa tarefas com limite de concorrencia, preservando a ordem dos resultados. */
export async function mapLimit(items, limit, worker, onProgress) {
  const results = new Array(items.length);
  let index = 0;
  let done = 0;
  let aborted = null;

  async function run() {
    while (index < items.length && !aborted) {
      const i = index++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        aborted = err;
        return;
      }
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }

  const runners = [];
  const parallel = Math.max(1, Math.min(limit, items.length || 1));
  for (let i = 0; i < parallel; i++) runners.push(run());
  await Promise.all(runners);
  if (aborted) throw aborted;
  return results;
}

export async function retry(fn, attempts = 3, delayMs = 500) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (err && err.name === 'AbortError') throw err;
      if (i < attempts - 1) await sleep(delayMs * (i + 1));
    }
  }
  throw lastErr;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
