// Renders the PWA / home-screen icons from public/icon.svg.
//   node scripts/generate-icons.mjs        (run from apps/web; output is committed)
// "any" icons keep the rounded-square artwork. Maskable and Apple icons are full-bleed squares
// (Android masks them, iOS rounds them) with the artwork scaled into the safe zone.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(createRequire(import.meta.url).resolve('next/package.json'));
const sharp = require('sharp');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');
const svg = await readFile(path.join(pub, 'icon.svg'), 'utf8');

/** Full-bleed square: gradient background, inner artwork (without its own rounded background) scaled to `scale`. */
function fullBleed(scale) {
  const inner = svg
    .replace(/<rect width="512" height="512" rx="112" fill="url\(#g\)"\/>/, '')
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '');
  const offset = (512 * (1 - scale)) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f7cf6"/><stop offset="1" stop-color="#1a4fb5"/></linearGradient></defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})">${inner}</g>
</svg>`;
}

const targets = [
  { file: 'icons/icon-192.png', size: 192, src: svg },
  { file: 'icons/icon-512.png', size: 512, src: svg },
  { file: 'icons/maskable-192.png', size: 192, src: fullBleed(0.72) },
  { file: 'icons/maskable-512.png', size: 512, src: fullBleed(0.72) },
  { file: 'apple-touch-icon.png', size: 180, src: fullBleed(0.86) },
  { file: 'favicon-32.png', size: 32, src: svg },
];

for (const t of targets) {
  const png = await sharp(Buffer.from(t.src), { density: 384 }).resize(t.size, t.size).png({ compressionLevel: 9 }).toBuffer();
  await writeFile(path.join(pub, t.file), png);
  console.info(`wrote public/${t.file} (${t.size}x${t.size}, ${png.length} bytes)`);
}
