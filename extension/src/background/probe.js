// Sonda manifests (HLS/DASH) para descobrir qualidades, duracao e DRM.

import * as store from './store.js';
import { callOffscreen } from './offscreen.js';
import { KIND } from '../lib/classify.js';

const inFlight = new Map();

export async function probeManifest(tabId, itemId, { force = false } = {}) {
  const item = store.get(tabId, itemId);
  if (!item) return null;
  if (item.kind !== KIND.HLS && item.kind !== KIND.DASH) return null;
  if (!force && item.probeState === 'done') return item.probe;

  const key = `${tabId}:${itemId}`;
  if (inFlight.has(key)) return inFlight.get(key);

  store.patch(tabId, itemId, { probeState: 'loading', note: '' });

  const task = (async () => {
    try {
      const res = await callOffscreen(
        'probe',
        {
          url: item.url,
          kind: item.kind,
          headers: item.requestHeaders || {},
        },
        { timeout: 45_000 }
      );
      if (!res || !res.ok) throw new Error(res?.error || 'Falha ao ler o manifest');

      const probe = res.data;
      store.patch(tabId, itemId, {
        probeState: 'done',
        probe,
        duration: probe.duration || item.duration || 0,
        width: probe.width || item.width || 0,
        height: probe.height || item.height || 0,
        drm: probe.drm || null,
        note: probe.isLive ? 'Transmissao ao vivo' : '',
      });
      return probe;
    } catch (err) {
      store.patch(tabId, itemId, {
        probeState: 'error',
        note: String(err?.message || err).slice(0, 200),
      });
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, task);
  return task;
}
