// Roteador de mensagens do documento offscreen.

import { probe, startDownload, cancelDownload, installRules, removeRules, revokeBlob } from './downloader.js';
import { makeThumb } from './thumbs.js';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  handle(msg.action, msg.payload || {})
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

async function handle(action, payload) {
  switch (action) {
    case 'ping':
      return 'pong';
    case 'probe':
      return probe(payload);
    case 'download.start':
      return startDownload(payload.jobId, payload.spec);
    case 'download.cancel':
      return cancelDownload(payload.jobId);
    case 'blob.revoke':
      return revokeBlob(payload.url);
    case 'thumb': {
      const ruleIds = await installRules([payload.url], payload.headers);
      try {
        return await makeThumb(payload);
      } finally {
        await removeRules(ruleIds);
      }
    }
    default:
      throw new Error(`Acao offscreen desconhecida: ${action}`);
  }
}
