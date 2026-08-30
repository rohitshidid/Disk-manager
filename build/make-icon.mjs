/**
 * Draw the app icon and assemble build/icon.icns.
 *
 * Pure Node: a few hundred lines of rasteriser and a PNG writer built on the
 * zlib that ships with the runtime. The alternative -- committing a binary
 * .icns nobody can diff, or adding an image library to a project whose whole
 * point is having no dependencies -- seemed worse than the arithmetic.
 *
 * The mark is a disk-usage ring: a mostly-filled arc for what is in use, the
 * remainder faint. It reads at 16px as a ring, which is all a Dock icon needs
 * to do.
 *
 *   node build/make-icon.mjs
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build');
const SS = 4;                      // supersampling factor, for smooth edges

/* --------------------------------------------------------------- drawing */

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** Signed distance to a rounded rectangle, negative inside. */
function sdRoundRect(px, py, halfW, halfH, r) {
  const qx = Math.abs(px) - halfW + r;
  const qy = Math.abs(py) - halfH + r;
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Alpha for a shape, from its signed distance, at this pixel scale. */
const cover = (d) => clamp01(0.5 - d);

function over(dst, i, r, g, b, a) {
  if (a <= 0) return;
  const inv = 1 - a;
  dst[i] = r * a + dst[i] * inv;
  dst[i + 1] = g * a + dst[i + 1] * inv;
  dst[i + 2] = b * a + dst[i + 2] * inv;
  dst[i + 3] = a + dst[i + 3] * inv;
}

/**
 * Render one square icon at `size` px, supersampled and box-filtered down.
 * Returns raw RGBA.
 */
function render(size) {
  const n = size * SS;
  const buf = new Float64Array(n * n * 4);
  const c = n / 2;
  const unit = n / 1024;                       // everything below is in 1024ths

  // Ring geometry. The gap at the top-left is where the "used" arc starts, so
  // the eye lands on the filled portion first.
  const rOuter = 330 * unit, rInner = 196 * unit;
  const start = -Math.PI / 2;                  // twelve o'clock
  const used = 0.72;                           // fraction of the ring filled
  const gap = 0.055 * Math.PI * 2;             // breathing room between arcs

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const px = x + 0.5 - c, py = y + 0.5 - c;

      // Rounded-square ground, with a vertical gradient.
      const dBg = sdRoundRect(px, py, 460 * unit, 460 * unit, 224 * unit);
      const t = clamp01((y / n) * 1.15 - 0.05);
      over(buf, i,
        lerp(37, 13, t), lerp(99, 148, t), lerp(235, 164, t),
        cover(dBg));

      const dist = Math.hypot(px, py);
      // Angle measured clockwise from twelve o'clock, in turns.
      let ang = Math.atan2(py, px) - start;
      ang = ((ang % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const inRing = clamp01(0.5 - (dist - rOuter)) * clamp01(0.5 - (rInner - dist));
      if (inRing <= 0) continue;

      const usedEnd = used * Math.PI * 2 - gap / 2;
      const freeStart = used * Math.PI * 2 + gap / 2;
      // Soften the two arc ends by a pixel, so they do not stair-step.
      const edge = 1 / Math.max(dist, 1);
      if (ang <= usedEnd) {
        over(buf, i, 255, 255, 255, inRing * clamp01((usedEnd - ang) / edge));
      } else if (ang >= freeStart) {
        over(buf, i, 255, 255, 255, inRing * 0.34 * clamp01((ang - freeStart) / edge));
      }
    }
  }

  // Box filter down to the requested size.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = (((y * SS + sy) * n) + (x * SS + sx)) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const k = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / k); out[o + 1] = Math.round(g / k);
      out[o + 2] = Math.round(b / k); out[o + 3] = Math.round((a / k) * 255);
    }
  }
  return out;
}

/* ------------------------------------------------------------------- PNG */

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function png(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // truecolour with alpha
  // Each scanline is prefixed with its filter type; 0 (none) keeps this simple
  // and costs a few kilobytes at these sizes.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ main */

fs.mkdirSync(OUT, { recursive: true });
const iconset = path.join(OUT, 'icon.iconset');
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset);

// The set macOS expects. Each is rendered at its true size rather than scaled
// from one master, so the 16px ring keeps its weight instead of turning grey.
const SIZES = [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
];
for (const [size, name] of SIZES) {
  fs.writeFileSync(path.join(iconset, name), png(render(size), size));
}
// electron-builder wants a 512px PNG alongside the .icns for non-mac targets.
fs.writeFileSync(path.join(OUT, 'icon.png'), png(render(512), 512));

execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(OUT, 'icon.icns')]);
fs.rmSync(iconset, { recursive: true, force: true });
console.log('wrote build/icon.icns and build/icon.png');
