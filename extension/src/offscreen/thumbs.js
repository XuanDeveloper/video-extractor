// Gera miniaturas (JPEG pequeno em data URL) a partir de um quadro do video.

import { attachSource, waitForEvent } from '../lib/player.js';

const WIDTH = 192;
const HEIGHT = 108;

export async function makeThumb({ kind, url }) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.width = WIDTH;
  video.height = HEIGHT;
  document.body.appendChild(video);

  let handle = null;
  try {
    handle = attachSource(video, { kind, url, lowQuality: true });
    if (video.readyState < 1) await waitForEvent(video, 'loadedmetadata', 25000);

    const duration = isFinite(video.duration) ? video.duration : 0;
    // ~10% do video (max 8s): evita a tela preta comum no primeiro quadro.
    // Se o quadro sair preto (fade-in, abertura), tenta mais adiante.
    const targets = duration > 2 ? [Math.min(duration * 0.1, 8), Math.min(duration * 0.3, 30)] : [0];
    let thumb = null;
    for (const target of targets) {
      thumb = await frameAt(video, target);
      if (!thumb.black) break;
    }

    return {
      thumb: thumb.dataUrl,
      duration,
      width: video.videoWidth || 0,
      height: video.videoHeight || 0,
    };
  } finally {
    try {
      handle?.destroy();
    } catch {
      /* ignora */
    }
    video.remove();
  }
}

/**
 * Posiciona o video e garante que um quadro decodificado esteja disponivel.
 * Com MSE (hls.js/dash.js) o "seeked" chega antes do quadro: tocar mudo por um
 * instante forca o decoder a entregar imagem.
 */
async function frameAt(video, target) {
  if (target > 0 && Math.abs(video.currentTime - target) > 0.05) {
    video.currentTime = target;
    await waitForEvent(video, 'seeked', 20000);
  }
  if (video.readyState < 2) await waitForEvent(video, 'loadeddata', 20000);

  const start = video.currentTime;
  await video.play().catch(() => {});
  await waitUntil(() => video.currentTime >= start + 0.15 || video.ended, 6000);
  video.pause();

  const dataUrl = grabFrame(video);
  return { dataUrl, black: isMostlyBlack(video) };
}

function waitUntil(predicate, timeout) {
  return new Promise((resolve) => {
    const started = Date.now();
    (function tick() {
      if (predicate() || Date.now() - started > timeout) return resolve();
      setTimeout(tick, 50);
    })();
  });
}

function isMostlyBlack(video) {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 18;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, 32, 18);
  const { data } = ctx.getImageData(0, 0, 32, 18);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
  return sum / (data.length / 4) / 3 < 12;
}

function grabFrame(video) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) throw new Error('Sem trilha de video');

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // "contain": mostra o quadro inteiro, com faixas pretas se a proporcao diferir.
  const scale = Math.min(WIDTH / vw, HEIGHT / vh);
  const w = vw * scale;
  const h = vh * scale;
  ctx.drawImage(video, (WIDTH - w) / 2, (HEIGHT - h) / 2, w, h);
  return canvas.toDataURL('image/jpeg', 0.72);
}
