#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(process.cwd());
const pub = path.join(root, 'public');
const iconsDir = path.join(pub, 'icons');

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function main() {
  const svgPath = path.join(pub, 'favicon.svg');
  const applePng = path.join(pub, 'apple-touch-icon.png');
  const icon192 = path.join(iconsDir, 'icon-192.png');
  const icon512 = path.join(iconsDir, 'icon-512.png');

  await ensureDir(iconsDir);

  // If PNGs already exist, skip regeneration to speed up builds
  try {
    await fs.access(icon192);
    await fs.access(icon512);
    await fs.access(applePng);
    return;
  } catch {}

  const svg = await fs.readFile(svgPath);

  // Generate PNG icons from SVG
  await sharp(svg).resize(192, 192).png().toFile(icon192);
  await sharp(svg).resize(512, 512).png().toFile(icon512);
  await sharp(svg).resize(180, 180).png().toFile(applePng);

  console.log('Generated PWA icons from favicon.svg');
}

main().catch((err) => {
  console.error('Icon generation failed:', err);
  process.exit(0); // don’t block builds; icons fallback to SVG if generation fails
});
