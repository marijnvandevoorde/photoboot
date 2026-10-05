// Fun print effects, all in printer dots:
// - styles: fitted colour canvas → 1-bit raster, for looks that aren't a
//   plain dither/screen (see canvasToRaster for those),
// - twists: canvas → canvas geometry applied before the style.
// More looks (8-bit, ASCII, spiral, glitch, Warhol, …) were tried in the
// filter lab and dropped; see git history (8b32a21) if you want one back.

import { boxBlur, inkToRaster, sobel, toGray } from './raster.js';

const TONE = { photo: true, gamma: 0.6, clip: 0.02, sharpen: 0.8 };

const frac = (v) => v - Math.floor(v);

// Small seeded PRNG (mulberry32): the same photo renders the same twice.
function seededRandom(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function whiteCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  return canvas;
}

// ---------- styles ----------

// Solid shadows, bold outlines and carved diagonal strokes that bend with
// the tone, like a linocut.
export function woodcut(canvas) {
  const { width, height } = canvas;
  const gray = boxBlur(toGray(canvas, { ...TONE, gamma: 0.5, clip: 0.03, sharpen: 0.6 }), width, height);
  const edges = sobel(gray, width, height);
  const ink = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const d = 1 - Math.max(0, Math.min(255, gray[i])) / 255; // darkness
      if (edges[i] > 70 || d > 0.82) ink[i] = 1;
      else if (d >= 0.25) {
        const t = (d - 0.25) / 0.57; // 0 light … 1 dark
        const phase = frac((x * 0.8 + y * 0.6) / 7 + d * 2.5);
        ink[i] = Math.abs(phase - 0.5) * 2 < t ? 1 : 0;
      }
    }
  }
  return inkToRaster(ink, width, height);
}

// Pointillism: error-diffuse a 3-dot grid (keeps features), then stamp a
// slightly jittered round dot wherever it inks (looks hand-placed).
export function stipple(canvas) {
  const { width, height } = canvas;
  const gray = toGray(canvas, { ...TONE, gamma: 0.42, clip: 0.03, sharpen: 1.4, outline: 1 });
  const rand = seededRandom(1);
  const ink = new Uint8Array(width * height);
  const C = 3;
  const cols = Math.ceil(width / C);
  const rows = Math.ceil(height / C);
  const cells = new Float32Array(cols * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) cells[Math.floor(y / C) * cols + Math.floor(x / C)] += gray[y * width + x] / (C * C);
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const on = cells[i] < 128;
      const err = cells[i] - (on ? 0 : 255);
      if (c + 1 < cols) cells[i + 1] += (err * 7) / 16;
      if (r + 1 < rows) {
        if (c > 0) cells[i + cols - 1] += (err * 3) / 16;
        cells[i + cols] += (err * 5) / 16;
        if (c + 1 < cols) cells[i + cols + 1] += err / 16;
      }
      if (!on) continue;
      const px = c * C + 1.5 + (rand() - 0.5) * 1.4;
      const py = r * C + 1.5 + (rand() - 0.5) * 1.4;
      for (let y = Math.floor(py - 2); y <= py + 2; y++) {
        for (let x = Math.floor(px - 2); x <= px + 2; x++) {
          if (x >= 0 && y >= 0 && x < width && y < height && (x - px) ** 2 + (y - py) ** 2 <= 2.6) ink[y * width + x] = 1;
        }
      }
    }
  }
  return inkToRaster(ink, width, height);
}

// ---------- twists ----------

// Left half + its mirror image: a perfectly symmetrical face.
export function mirror(canvas) {
  const { width, height } = canvas;
  const out = whiteCanvas(width, height);
  const ctx = out.getContext('2d');
  const half = width / 2;
  ctx.drawImage(canvas, 0, 0, half, height, 0, 0, half, height);
  ctx.translate(width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(canvas, 0, 0, half, height, 0, 0, half, height);
  return out;
}

// Fisheye bulge around the upper centre, where faces usually are.
export function bigHead(canvas) {
  const { width, height } = canvas;
  const src = canvas.getContext('2d').getImageData(0, 0, width, height);
  const out = whiteCanvas(width, height);
  const ctx = out.getContext('2d');
  const dst = ctx.getImageData(0, 0, width, height);
  const cx = width / 2;
  const cy = height * 0.42;
  const R = Math.min(width, height) * 0.5;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      const k = r < R && r > 0 ? Math.pow(r / R, 0.7) : 1; // < 1 → magnify
      const sx = Math.max(0, Math.min(width - 1.001, cx + dx * k));
      const sy = Math.max(0, Math.min(height - 1.001, cy + dy * k));
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const p = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const at = (xx, yy) => src.data[(yy * width + xx) * 4 + c];
        dst.data[p + c] =
          at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
      }
      dst.data[p + 3] = 255;
    }
  }
  ctx.putImageData(dst, 0, 0);
  return out;
}
