// Sanity checks that catch the mistakes that only show up after "Load unpacked":
// a file referenced by the manifest that doesn't exist, or versions drifting apart.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const problems = [];

if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
if (manifest.version !== pkg.version) {
  problems.push(`version mismatch: manifest ${manifest.version} vs package.json ${pkg.version}`);
}

const referenced = new Set([
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
]);
for (const file of referenced) {
  if (file && !fs.existsSync(path.join(EXT, file))) problems.push(`missing file: extension/${file}`);
}

// Every relative <script>/<link> in the extension's HTML pages must exist too.
for (const html of ['src/popup/popup.html', 'src/offscreen/offscreen.html']) {
  const text = fs.readFileSync(path.join(EXT, html), 'utf8');
  for (const [, ref] of text.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^(https?:|data:|#)/.test(ref)) continue;
    if (!fs.existsSync(path.join(EXT, path.dirname(html), ref))) problems.push(`missing file: ${ref} (from ${html})`);
  }
}

if (problems.length) {
  console.error(problems.map((p) => '✗ ' + p).join('\n'));
  process.exit(1);
}
console.log(`✓ manifest ok — ${manifest.name} ${manifest.version}, ${referenced.size} files referenced`);
