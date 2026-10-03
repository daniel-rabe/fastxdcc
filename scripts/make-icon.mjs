/**
 * Draws the application icon.
 *
 * electron-builder turns a single large PNG into the per-platform icon formats, so this
 * only has to produce `build/icon.png`. It is written by hand rather than pulled from an
 * image library: a PNG is a handful of chunks around zlib-compressed scanlines, which is
 * less machinery than another dependency.
 *
 * The shape is a download arrow over a tray, in the palette the app itself uses.
 */

import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 512;
/** Drawn at this multiple and averaged down, which is what smooths the edges. */
const SS = 4;

const BG = [27, 31, 38];        // --bg-raised
const BORDER = [57, 65, 78];    // --border-strong
const ACCENT = [79, 156, 249];  // --accent
const GREEN = [69, 194, 122];   // --green

const W = SIZE * SS;

/** Signed distance to a rounded rectangle, positive outside. */
function roundedRectSdf(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

function insideTriangle(x, y, ax, ay, bx, by, cx, cy) {
  const sign = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = sign(x, y, ax, ay, bx, by);
  const d2 = sign(x, y, bx, by, cx, cy);
  const d3 = sign(x, y, cx, cy, ax, ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** Colour of one supersampled pixel, as [r, g, b, a]. */
function shade(x, y) {
  const c = W / 2;
  const plate = roundedRectSdf(x, y, c, c, W * 0.46, W * 0.46, W * 0.17);
  if (plate > 0) return [0, 0, 0, 0];

  // A thin lighter rim, so the icon keeps an edge on a dark background.
  const onBorder = plate > -W * 0.012;
  let colour = onBorder ? BORDER : BG;

  // Arrow shaft.
  const shaftHalf = W * 0.062;
  const shaftTop = W * 0.24;
  const shaftBottom = W * 0.5;
  if (Math.abs(x - c) <= shaftHalf && y >= shaftTop && y <= shaftBottom) colour = ACCENT;

  // Arrow head.
  if (insideTriangle(x, y, c - W * 0.16, W * 0.47, c + W * 0.16, W * 0.47, c, W * 0.68)) {
    colour = ACCENT;
  }

  // The tray it lands in: two uprights and a base, drawn in the "done" green.
  const trayLeft = c - W * 0.2;
  const trayRight = c + W * 0.2;
  const trayTop = W * 0.72;
  const trayBottom = W * 0.79;
  const thickness = W * 0.055;
  const onBase = y >= trayBottom - thickness && y <= trayBottom && x >= trayLeft && x <= trayRight;
  const onUpright =
    y >= trayTop &&
    y <= trayBottom &&
    (Math.abs(x - trayLeft) <= thickness / 2 || Math.abs(x - trayRight) <= thickness / 2);
  if (onBase || onUpright) colour = GREEN;

  return [colour[0], colour[1], colour[2], 255];
}

function render() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [sr, sg, sb, sa] = shade(px * SS + sx + 0.5, py * SS + sy + 0.5);
          // Weight colour by coverage so transparent samples do not darken the edge.
          const w = sa / 255;
          r += sr * w;
          g += sg * w;
          b += sb * w;
          a += sa;
        }
      }
      const samples = SS * SS;
      const alpha = a / samples;
      const coverage = alpha / 255 || 1;
      const at = (py * SIZE + px) * 4;
      pixels[at] = Math.round(r / samples / coverage);
      pixels[at + 1] = Math.round(g / samples / coverage);
      pixels[at + 2] = Math.round(b / samples / coverage);
      pixels[at + 3] = Math.round(alpha);
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function toPng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 stay zero: deflate, default filter, no interlace.

  // Each scanline is prefixed with its filter type; 0 means "store as is".
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const at = y * (size * 4 + 1);
    raw[at] = 0;
    pixels.copy(raw, at + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(root, 'build', 'icon.png');
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, toPng(render(), SIZE));
process.stdout.write(`${path.relative(root, out)} (${SIZE}x${SIZE})\n`);
