// Generates PixlForge app icons from assets/icon-source.png.
//
// Run with Electron so nativeImage handles image loading and resizing:
//   npm run gen-icon
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, nativeImage } = require('electron');

const ASSETS = path.join(__dirname, '..', 'assets');

function findBackground(bmp, width, height) {
  const fillable = (i) => {
    if (bmp[i + 3] < 16) return true;
    const r = bmp[i + 2];
    const g = bmp[i + 1];
    const b = bmp[i];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return min > 180 && max - min < 28;
  };

  const bg = new Uint8Array(width * height);
  const queue = [];
  const push = (x, y) => {
    const p = y * width + x;
    if (!bg[p] && fillable(p * 4)) {
      bg[p] = 1;
      queue.push(p);
    }
  };

  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }

  while (queue.length) {
    const p = queue.pop();
    const x = p % width;
    const y = (p / width) | 0;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }

  const dilated = Uint8Array.from(bg);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bg[y * width + x]) continue;
      if (
        (x > 0 && bg[y * width + x - 1]) ||
        (x < width - 1 && bg[y * width + x + 1]) ||
        (y > 0 && bg[(y - 1) * width + x]) ||
        (y < height - 1 && bg[(y + 1) * width + x])
      ) {
        dilated[y * width + x] = 1;
      }
    }
  }
  return dilated;
}

function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...pngs.map((png) => png.data)]);
}

function main() {
  const sourcePath = path.join(ASSETS, 'icon-source.png');
  const source = nativeImage.createFromPath(sourcePath);
  if (source.isEmpty()) {
    throw new Error(`Missing or unreadable icon source: ${sourcePath}`);
  }

  const { width, height } = source.getSize();
  const src = source.toBitmap();
  const bg = findBackground(src, width, height);

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!bg[y * width + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('Icon source appears to be blank.');

  const bbox = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  const size = Math.max(bbox.w, bbox.h);
  const offX = bbox.x - Math.floor((size - bbox.w) / 2);
  const offY = bbox.y - Math.floor((size - bbox.h) / 2);
  const out = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = offX + x;
      const sy = offY + y;
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
      if (bg[sy * width + sx]) continue;
      const outputIndex = (y * size + x) * 4;
      const sourceIndex = (sy * width + sx) * 4;
      out[outputIndex] = src[sourceIndex];
      out[outputIndex + 1] = src[sourceIndex + 1];
      out[outputIndex + 2] = src[sourceIndex + 2];
      out[outputIndex + 3] = src[sourceIndex + 3];
    }
  }

  const master = nativeImage.createFromBitmap(out, { width: size, height: size });
  const png = (pixelSize) => master.resize({ width: pixelSize, height: pixelSize, quality: 'best' }).toPNG();
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), png(256));
  fs.writeFileSync(path.join(ASSETS, 'icon-preview-128.png'), png(128));
  fs.writeFileSync(
    path.join(ASSETS, 'icon.ico'),
    buildIco([16, 24, 32, 48, 64, 128, 256].map((pixelSize) => ({
      size: pixelSize,
      data: png(pixelSize),
    }))),
  );
  console.log(`wrote PixlForge icons from ${width}x${height} source`);
}

app.whenReady().then(() => {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
  app.quit();
});
