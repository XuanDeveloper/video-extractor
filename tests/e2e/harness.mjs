// Shared plumbing for the end-to-end tests: a local media server and a browser
// with the unpacked extension loaded.
//
//   BROWSER=/path/to/brave.exe PROFILE=/tmp/profile npm run test:e2e   # run on Brave/Edge
//   SHOTS=docs npm run test:e2e                                         # save screenshots
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { FIXTURES } from '../../scripts/make-fixtures.mjs';
import { EXT, ROOT } from '../helpers.mjs';

export const MEDIA = path.join(FIXTURES, 'media');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mpd': 'application/dash+xml',
  '.m4s': 'video/iso.segment',
  '.js': 'application/javascript',
};

/** Serves `pages` ({'/path': html}) plus everything under tests/fixtures/media, with Range support. */
export async function serve(pages) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (pages[url.pathname]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pages[url.pathname]);
    }
    const file = url.pathname === '/hls.min.js'
      ? path.join(EXT, 'src/vendor/hls.min.js')
      : path.join(MEDIA, decodeURIComponent(url.pathname).replace(/^\/media\//, ''));
    if (!(file.startsWith(MEDIA) || file.startsWith(EXT)) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    const { size } = fs.statSync(file);
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    const range = req.headers.range && /bytes=(\d+)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, {
        'content-type': type,
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': end - start + 1,
      });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** Launches Chrome for Testing (or $BROWSER) with the extension and returns handles to it. */
export async function launch({ downloads }) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.BROWSER || undefined,
    userDataDir: process.env.BROWSER ? process.env.PROFILE : undefined,
    args: [
      // Chrome 137+ ignores --load-extension unless this is turned off.
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--autoplay-policy=no-user-gesture-required',
      ...(process.env.CI ? ['--no-sandbox'] : []),
    ],
  });
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().includes('service-worker.js'),
    { timeout: 20000 }
  );
  const extId = new URL(swTarget.url()).host;
  const sw = await swTarget.worker();
  fs.rmSync(downloads, { recursive: true, force: true });
  fs.mkdirSync(downloads, { recursive: true });
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });

  /** Opens the popup bound to the tab whose URL contains `match`. */
  async function openPopup(match, viewport = { width: 440, height: 900 }) {
    const tabId = await sw.evaluate(async (m) => (await chrome.tabs.query({})).find((t) => t.url?.includes(m))?.id, match);
    const popup = await browser.newPage();
    popup.errors = [];
    popup.on('pageerror', (e) => popup.errors.push(e.message));
    // Retina-sharp screenshots when refreshing the README images.
    await popup.setViewport({ ...viewport, deviceScaleFactor: process.env.SHOTS ? 2 : 1 });
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html?tabId=${tabId}`);
    return popup;
  }

  return { browser, sw, extId, openPopup };
}

/** Saves a screenshot when SHOTS=<dir> is set (used to refresh the README images). */
export async function shot(page, name) {
  if (!process.env.SHOTS) return;
  const dir = path.resolve(ROOT, process.env.SHOTS);
  fs.mkdirSync(dir, { recursive: true });
  // Crop to the popup's real height instead of the whole viewport.
  const height = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
  const { width } = page.viewport();
  await page.screenshot({ path: path.join(dir, `${name}.png`), clip: { x: 0, y: 0, width, height } });
}

export async function waitFor(fn, { timeout = 20000, interval = 500 } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  return last;
}

export function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]
  ).filter((f) => !f.endsWith('.crdownload'));
}
