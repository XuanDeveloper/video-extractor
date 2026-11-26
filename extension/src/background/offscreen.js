// Ponte com o documento offscreen (fetch/DOMParser/Blob/crypto fora do service worker).

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
let creating = null;

async function hasDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    return contexts.length > 0;
  }
  return false;
}

export async function ensureOffscreen() {
  if (await hasDocument()) return;
  if (creating) {
    await creating;
    return;
  }
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['BLOBS', 'DOM_PARSER', 'WORKERS'],
      justification:
        'Baixar, descriptografar (AES-128 HLS) e juntar segmentos de video, e interpretar manifests DASH com DOMParser.',
    })
    .catch((err) => {
      if (!String(err).includes('Only a single offscreen')) throw err;
    });
  try {
    await creating;
  } finally {
    creating = null;
  }
}

/** Envia uma mensagem ao documento offscreen e aguarda a resposta. */
export async function callOffscreen(action, payload = {}, { timeout = 0 } = {}) {
  await ensureOffscreen();
  const message = { target: 'offscreen', action, payload };
  const send = chrome.runtime.sendMessage(message);
  if (!timeout) return send;
  return Promise.race([
    send,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Tempo esgotado na operacao offscreen')), timeout)),
  ]);
}
