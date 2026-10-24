// Rasterizes a rect-only SVG (as produced for the op8x logos) to PNG, no dependencies.
// Usage: node export-png.mjs <in.svg> <out.png> [width]  (height follows the viewBox ratio)
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const [inFile, outFile, widthArg] = process.argv.slice(2);
if (!inFile || !outFile) throw new Error("usage: node export-png.mjs <in.svg> <out.png> [width]");

const svg = readFileSync(inFile, "utf8");
const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
if (!vb) throw new Error("viewBox not found");
const [vbW, vbH] = [Number(vb[1]), Number(vb[2])];
const width = Number(widthArg ?? vbW);
const k = width / vbW;
const height = Math.round(vbH * k);

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const bg = hex(svg.match(/<rect width="[\d.]+" height="[\d.]+" fill="(#[0-9a-f]{6})"/i)[1]);
const fg = hex(svg.match(/<g fill="(#[0-9a-f]{6})"/i)[1]);

const px = new Uint8Array(width * height * 3);
for (let i = 0; i < width * height; i++) px.set(bg, i * 3);

const rectRe = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"\/>/g;
for (const [, x, y, w, h] of svg.matchAll(rectRe)) {
  const x0 = Math.round(x * k), y0 = Math.round(y * k);
  const x1 = Math.round((+x + +w) * k), y1 = Math.round((+y + +h) * k);
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) px.set(fg, (yy * width + xx) * 3);
}

// PNG: signature, IHDR, IDAT (filter byte 0 per row), IEND.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
const raw = Buffer.alloc(height * (width * 3 + 1));
for (let y = 0; y < height; y++) Buffer.from(px.buffer, y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);

writeFileSync(outFile, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]));
console.log(`${outFile} ${width}x${height}`);
