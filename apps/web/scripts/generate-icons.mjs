// Generates every brand image from the official Al-Rasiyat logo.   node scripts/generate-icons.mjs  (in apps/web)
//
// Inputs (committed):
//   assets/brand/alrasiyat-logo-source.jpeg  official raster logo (gold #C0903D on white)
//   public/brand/logo-mark.svg              vector trace of the mark + Arabic wordmark (no Latin line)
// Outputs (committed): app icons (any + maskable), apple-touch-icon, favicon, monochrome badge,
//   icon.svg. The full lockup is the mark + "ALRASIYAT" set in type (components/logo.tsx). Replace logo-mark.svg with an official vector when one
//   is available and re-run this script.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(createRequire(import.meta.url).resolve('next/package.json'));
const sharp = require('sharp');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');
const GOLD = '#C0903D';
const mark = await readFile(path.join(pub, 'brand/logo-mark.svg'), 'utf8');
const [, vw, vh] = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(mark).map(Number);
const markInner = mark.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

/** Square canvas with the mark centred at `scale` of the width. */
function square({ bg, scale, color = GOLD, radius = 0 }) {
  const size = 1024;
  const w = size * scale;
  const h = (w * vh) / vw;
  const x = (size - w) / 2;
  const y = (size - h) / 2;
  const inner = markInner.replace(/fill="[^"]*"/g, `fill="${color}"`);
  const rect = bg ? `<rect width="${size}" height="${size}" rx="${radius}" fill="${bg}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${rect}<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 ${vw} ${vh}">${inner}</svg></svg>`;
}

const render = (svg, size) => sharp(Buffer.from(svg), { density: 300 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

const targets = [
  // "any" icons: ivory rounded tile so the gold mark reads on dark and light launchers.
  { file: 'icons/icon-192.png', size: 192, svg: square({ bg: '#FFFFFF', scale: 0.7, radius: 200 }) },
  { file: 'icons/icon-512.png', size: 512, svg: square({ bg: '#FFFFFF', scale: 0.7, radius: 200 }) },
  // Maskable: full-bleed, mark inside the 80% safe zone.
  { file: 'icons/maskable-192.png', size: 192, svg: square({ bg: '#FFFFFF', scale: 0.56 }) },
  { file: 'icons/maskable-512.png', size: 512, svg: square({ bg: '#FFFFFF', scale: 0.56 }) },
  // iOS rounds the corners itself.
  { file: 'apple-touch-icon.png', size: 180, svg: square({ bg: '#FFFFFF', scale: 0.68 }) },
  { file: 'favicon-32.png', size: 32, svg: square({ bg: '#FFFFFF', scale: 0.86, radius: 180 }) },
  // Android status-bar badge: white silhouette on transparent (the OS tints it).
  { file: 'icons/badge-96.png', size: 96, svg: square({ bg: null, scale: 0.9, color: '#FFFFFF' }) },
];

for (const t of targets) {
  const png = await render(t.svg, t.size);
  await writeFile(path.join(pub, t.file), png);
  console.info(`wrote public/${t.file} (${t.size}x${t.size})`);
}
await writeFile(path.join(pub, 'icon.svg'), square({ bg: '#FFFFFF', scale: 0.82, radius: 200 }));
console.info('wrote public/icon.svg');

