import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Generates the app's icons, with no image dependency.
 *
 * A PWA needs real PNGs to be installable, and this repo does not carry binary
 * design assets or a build step that could rasterise an SVG. Encoding a PNG is
 * thirty lines — signature, IHDR, a zlib-deflated scanline block, IEND, each with
 * a CRC — so the icons are generated from a described shape instead of being
 * checked in as opaque blobs nobody can adjust.
 *
 * The mark is a lens: a ring with a dot, which is what the officer does (look at
 * a sticker). It is drawn at 4x and box-filtered down, because a hard-edged ring
 * at 192 px looks like a mistake.
 *
 * Run with `node scripts/generate-icons.mjs`; the output is committed, so a build
 * never depends on it.
 */

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const NAVY = [15, 23, 42];
const WHITE = [255, 255, 255];

/** One icon: a square background with a ring and a dot, in pixels. */
function render(size, { maskable }) {
  const scale = 4;
  const big = size * scale;
  const pixels = new Uint8Array(big * big * 4);

  // A maskable icon is cropped to a circle by the launcher, so it keeps its mark
  // inside the safe zone (40% of the width) and bleeds the background.
  const ringRadius = big * (maskable ? 0.22 : 0.28);
  const ringWidth = big * (maskable ? 0.035 : 0.045);
  const dotRadius = big * (maskable ? 0.055 : 0.07);
  const centre = big / 2;
  const cornerRadius = maskable ? 0 : big * 0.22;

  for (let y = 0; y < big; y += 1) {
    for (let x = 0; x < big; x += 1) {
      const index = (y * big + x) * 4;
      const inside = maskable || insideRoundedRect(x, y, big, cornerRadius);
      if (!inside) {
        pixels[index + 3] = 0;
        continue;
      }
      const distance = Math.hypot(x - centre, y - centre);
      const onRing = Math.abs(distance - ringRadius) <= ringWidth;
      const onDot = distance <= dotRadius;
      const colour = onRing || onDot ? WHITE : NAVY;
      pixels[index] = colour[0];
      pixels[index + 1] = colour[1];
      pixels[index + 2] = colour[2];
      pixels[index + 3] = 255;
    }
  }

  return downsample(pixels, big, size, scale);
}

function insideRoundedRect(x, y, size, radius) {
  const near = radius;
  const far = size - radius;
  const dx = x < near ? near - x : x > far ? x - far : 0;
  const dy = y < near ? near - y : y > far ? y - far : 0;
  return Math.hypot(dx, dy) <= radius;
}

/** Box filter: averages each scale×scale block into one pixel, edges included. */
function downsample(source, bigSize, size, scale) {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const index = ((y * scale + sy) * bigSize + (x * scale + sx)) * 4;
          const alpha = source[index + 3] ?? 0;
          r += (source[index] ?? 0) * alpha;
          g += (source[index + 1] ?? 0) * alpha;
          b += (source[index + 2] ?? 0) * alpha;
          a += alpha;
        }
      }
      const index = (y * size + x) * 4;
      if (a === 0) {
        out[index + 3] = 0;
        continue;
      }
      out[index] = Math.round(r / a);
      out[index + 1] = Math.round(g / a);
      out[index + 2] = Math.round(b / a);
      out[index + 3] = Math.round(a / (scale * scale));
    }
  }
  return out;
}

/** A PNG file: signature, IHDR, IDAT, IEND. */
function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(
      raw,
      y * (size * 4 + 1) + 1,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size, options] of [
  ["icon-192.png", 192, { maskable: false }],
  ["icon-512.png", 512, { maskable: false }],
  ["icon-maskable-512.png", 512, { maskable: true }],
  ["apple-touch-icon-180.png", 180, { maskable: true }],
]) {
  const file = join(OUT_DIR, name);
  writeFileSync(file, encodePng(size, render(size, options)));
  process.stdout.write(`wrote ${name}\n`);
}
