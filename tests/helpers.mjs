import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXT = path.join(ROOT, 'extension');

/**
 * mse-mux.js is a classic script injected into pages (world MAIN), not a module.
 * Evaluate it with a CommonJS-style `module` so it hands its API back.
 */
export function loadMux() {
  const src = fs.readFileSync(path.join(EXT, 'src/content/mse-mux.js'), 'utf8');
  const mod = { exports: {} };
  new Function('module', src)(mod);
  return mod.exports;
}
