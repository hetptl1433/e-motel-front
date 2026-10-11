// Export every icon from the same geometric mark, without image dependencies.
// Run: node scripts/brand-assets.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const app = path.resolve(__dirname, '../HK/L1/l1');
const publicDir = path.join(app, 'public');
const blue = [37, 99, 235];
const ink = '#172b4d';
const color = '#2563eb';
const bars = [[19, 16, 8, 34], [19, 16, 27, 8], [19, 29, 23, 8], [19, 42, 27, 8]];
const symbol = `<rect width="64" height="64" rx="15" fill="${color}"/>${bars.map(([x, y, width, height]) => `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="white"/>`).join('')}`;
const mark = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><title>E-motel</title>${symbol}</svg>\n`;
fs.writeFileSync(path.join(app, 'src/logo.svg'), mark);
fs.writeFileSync(path.join(publicDir, 'favicon.svg'), mark);
fs.writeFileSync(path.join(publicDir, 'logo.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="242" height="64" viewBox="0 0 242 64" role="img" aria-labelledby="brand-title"><title id="brand-title">E-motel</title>${symbol}<text x="78" y="45" font-family="Arial, Helvetica, sans-serif" font-size="42" font-weight="700" letter-spacing="-1" fill="${ink}">E-motel</text></svg>\n`);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return output;
}
function insideTile(x, y) {
  const nearestX = Math.max(15, Math.min(49, x));
  const nearestY = Math.max(15, Math.min(49, y));
  return (x - nearestX) ** 2 + (y - nearestY) ** 2 <= 15 ** 2;
}
function png(size, opaque = false) {
  const samples = 8;
  const count = samples * samples;
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let filled = 0;
      let white = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = (x + (sx + .5) / samples) * 64 / size;
          const py = (y + (sy + .5) / samples) * 64 / size;
          if (opaque || insideTile(px, py)) filled += 1;
          if (bars.some(([left, top, width, height]) => px >= left && px < left + width && py >= top && py < top + height)) white += 1;
        }
      }
      const index = y * (size * 4 + 1) + 1 + x * 4;
      blue.forEach((value, channel) => { rows[index + channel] = filled ? Math.round(value + (255 - value) * white / filled) : 0; });
      rows[index + 3] = Math.round(filled * 255 / count);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

for (const [name, size, opaque] of [['logo192.png', 192, false], ['logo512.png', 512, false], ['apple-touch-icon.png', 180, true], ['logo-maskable512.png', 512, true]]) {
  fs.writeFileSync(path.join(publicDir, name), png(size, opaque));
}
const sizes = [16, 24, 32, 48, 64];
const frames = sizes.map(size => png(size));
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
sizes.forEach((size, index) => {
  const start = 6 + index * 16;
  directory[start] = size;
  directory[start + 1] = size;
  directory.writeUInt16LE(1, start + 4);
  directory.writeUInt16LE(32, start + 6);
  directory.writeUInt32LE(frames[index].length, start + 8);
  directory.writeUInt32LE(offset, start + 12);
  offset += frames[index].length;
});
fs.writeFileSync(path.join(publicDir, 'favicon.ico'), Buffer.concat([directory, ...frames]));
console.log('Exported E-motel SVG, browser, Apple, and app icons.');
