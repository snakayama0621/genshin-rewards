// Renders the extension icon (rounded square, teal-to-indigo gradient, white sparkle)
// to src/icons/icon{16,32,48,128}.png. Node stdlib only: node scripts/generate-icons.mjs
import { writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;
const CORNER_RADIUS = 0.22;
const TOP_LEFT = [34, 170, 156];
const BOTTOM_RIGHT = [76, 90, 214];
const WHITE = [255, 255, 255];

function insideRoundedSquare(x, y) {
  const r = CORNER_RADIUS;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Concave four-point star: |dx|^p + |dy|^p <= radius^p with p < 1. */
function insideSparkle(x, y, cx, cy, radius) {
  const p = 0.55;
  return (
    Math.abs(x - cx) ** p + Math.abs(y - cy) ** p <= radius ** p
  );
}

function sample(x, y, size) {
  if (!insideRoundedSquare(x, y)) return null;
  const big = insideSparkle(x, y, 0.47, 0.53, 0.36);
  const small = size >= 32 && insideSparkle(x, y, 0.76, 0.24, 0.13);
  if (big || small) return WHITE;
  const t = (x + y) / 2;
  return TOP_LEFT.map((from, i) => from + (BOTTOM_RIGHT[i] - from) * t);
}

function renderRgba(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const n = SUPERSAMPLE;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0];
      let covered = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const color = sample((px + (sx + 0.5) / n) / size, (py + (sy + 0.5) / n) / size, size);
          if (color === null) continue;
          covered++;
          for (let i = 0; i < 3; i++) sum[i] += color[i];
        }
      }
      const offset = (py * size + px) * 4;
      for (let i = 0; i < 3; i++) pixels[offset + i] = covered ? Math.round(sum[i] / covered) : 0;
      pixels[offset + 3] = Math.round((covered / (n * n)) * 255);
    }
  }
  return pixels;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of SIZES) {
  const path = `src/icons/icon${size}.png`;
  writeFileSync(path, encodePng(size, renderRgba(size)));
  console.log(`wrote ${path}`);
}
