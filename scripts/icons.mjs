// Renders public/icons/icon.svg into the PNG set and favicon.ico. Run: npm run icons
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const dir = fileURLToPath(new URL('../public/icons/', import.meta.url));
const svg = readFileSync(dir + 'icon.svg');

// render large once, downscale for quality
const master = await sharp(svg, { density: 288 }).resize(1024, 1024).png().toBuffer();

async function png(size, out, pad = 0) {
  let buf = await sharp(master).resize(size - pad * 2, size - pad * 2).png().toBuffer();
  if (pad) {
    buf = await sharp({ create: { width: size, height: size, channels: 4, background: '#ffffff' } })
      .composite([{ input: buf }])
      .png()
      .toBuffer();
  }
  writeFileSync(dir + out, buf);
  console.log('wrote icons/' + out);
  return buf;
}

await png(192, 'icon-192.png');
await png(512, 'icon-512.png');
await png(180, 'apple-touch-icon.png');
// maskable: same art inside the safe zone
await png(512, 'icon-maskable-512.png', 60);

// favicon.ico: ICO container holding PNG-encoded 16px and 32px images
const sizes = [16, 32];
const images = [];
for (const s of sizes) images.push(await sharp(master).resize(s, s).png().toBuffer());

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
const entries = [];
let offset = 6 + 16 * images.length;
images.forEach((buf, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(sizes[i], 0);
  e.writeUInt8(sizes[i], 1);
  e.writeUInt16LE(1, 4); // color planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(buf.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += buf.length;
  entries.push(e);
});
writeFileSync(
  fileURLToPath(new URL('../public/favicon.ico', import.meta.url)),
  Buffer.concat([header, ...entries, ...images]),
);
console.log('wrote favicon.ico');
