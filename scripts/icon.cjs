'use strict';
// Generate only build artifacts: a small original geometric app icon, no downloaded assets.
const fs = require('node:fs');
const zlib = require('node:zlib');
const { crc32 } = require('../src/core/packages.cjs');
const size = 256, pixels = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const p = y * (size * 4 + 1) + 1 + x * 4;
  const cx = Math.max(44, Math.min(211, x)), cy = Math.max(44, Math.min(211, y));
  const visible = (x - cx) ** 2 + (y - cy) ** 2 <= 44 ** 2;
  let chevron = false;
  for (const left of [62, 123]) { const dx = x - left, dy = Math.abs(y - 128); if (dx >= 0 && dx <= 72 && dy <= 60 - dx * .82 && dy >= 29 - dx * .82) chevron = true; }
  pixels[p] = chevron ? 27 : 200; pixels[p + 1] = chevron ? 42 : 246; pixels[p + 2] = chevron ? 29 : 145; pixels[p + 3] = visible ? 255 : 0;
}
function chunk(type, data) { const t = Buffer.from(type), result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); t.copy(result, 4); data.copy(result, 8); result.writeUInt32BE(crc32(Buffer.concat([t, data])), result.length - 4); return result; }
const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
fs.mkdirSync('build', { recursive: true }); fs.writeFileSync('build/icon.png', png); fs.writeFileSync('build/icon.ico', Buffer.concat([ico, png]));
console.log('Build icons generated.');
