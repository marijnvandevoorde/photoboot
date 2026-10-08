// Rough optical model of a thermal print, for judging dither looks on screen
// without burning paper. Not exact: it is meant to be calibrated by eye
// against a real print (the lab page exposes the knobs).
//
// What it models:
// - dot spread: heat bleeds sideways, so a dot prints as a soft blob a bit
//   bigger than its cell, longer in the feed direction (the paper moves
//   while the element is hot),
// - density: more heat → bigger blobs, neighbours merge sooner, midtones
//   darken (dot gain),
// - weak isolated dots: a lone dot gets less heat from its neighbours than
//   one in a cluster, so it prints smaller and paler, or not at all,
// - head elements that run slightly hot or cold (faint vertical streaks),
// - paper and ink colour, which are never pure white / black.

import { ctx2d, newCanvas } from './dom.ts';
import type { Raster } from './types.ts';

export interface SimOptions {
  density?: number; // printer density setting, 1–4
  spread?: number; // blob sigma in dots (heat bleed)
  gain?: number; // extra dot gain on top of density, −0.2 … 0.2
  scale?: number; // simulated pixels per printer dot
}

export const SIM_DEFAULTS = { spread: 0.42, gain: 0, scale: 3 };

const PAPER = [246, 245, 241];
const INK = [34, 33, 38];

// Threshold on the blurred coverage where a blob edge sits, per density.
// Lower = bigger dots.
const EDGE: Record<number, number> = { 1: 0.56, 2: 0.5, 3: 0.44, 4: 0.36 };

export function simulatePrint({ bitmap, widthDots, heightDots }: Raster, options: SimOptions = {}): HTMLCanvasElement {
  const { density = 3, spread, gain, scale: S } = { ...SIM_DEFAULTS, ...options };
  const w = widthDots * S;
  const h = heightDots * S;
  const rowBytes = widthDots / 8;

  // Ink map, per dot and at S× resolution.
  const dots = new Float32Array(widthDots * heightDots);
  const cov = new Float32Array(w * h);
  for (let y = 0; y < heightDots; y++) {
    for (let x = 0; x < widthDots; x++) {
      if (!(bitmap[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7)))) continue;
      dots[y * widthDots + x] = 1;
      for (let sy = 0; sy < S; sy++) cov.fill(1, (y * S + sy) * w + x * S, (y * S + sy) * w + x * S + S);
    }
  }

  const blob = gaussBlur(cov, w, h, spread * S, spread * S * 1.25);
  // Neighbourhood heat, for the isolated-dot falloff. Smooth, so per dot is
  // fine.
  const heatDots = gaussBlur(dots, widthDots, heightDots, 1.4, 1.4);

  // Per head element (column) gain: a few percent, seeded so it's stable.
  const column = new Float32Array(widthDots);
  let seed = 7;
  for (let x = 0; x < widthDots; x++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    column[x] = 1 + ((seed / 4294967296) * 2 - 1) * 0.03;
  }

  const edge = (EDGE[Math.round(density)] ?? EDGE[3]) - gain;
  const soft = 0.12;
  const canvas = newCanvas(w, h);
  const ctx = ctx2d(canvas);
  const img = ctx.createImageData(w, h);
  for (let y = 0, i = 0; y < h; y++) {
    const heatRow = ((y / S) | 0) * widthDots;
    for (let x = 0; x < w; x++, i++) {
      const heat = heatDots[heatRow + ((x / S) | 0)];
      // Isolated dots need more coverage to show; clusters reinforce.
      const c = blob[i] * column[(x / S) | 0] * (0.8 + 0.35 * heat);
      const t = Math.max(0, Math.min(1, (c - edge + soft) / (2 * soft)));
      const dark = t * t * (3 - 2 * t) * (0.86 + 0.14 * Math.min(1, heat * 1.5));
      const p = i * 4;
      for (let k = 0; k < 3; k++) img.data[p + k] = PAPER[k] + (INK[k] - PAPER[k]) * dark;
      img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Separable Gaussian blur, edges clamped.
function gaussBlur(src: Float32Array, w: number, h: number, sx: number, sy: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const kx = kernel(sx);
  const ky = kernel(sy);
  const rx = (kx.length - 1) / 2;
  const ry = (ky.length - 1) / 2;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -rx; k <= rx; k++) sum += src[row + Math.min(w - 1, Math.max(0, x + k))] * kx[k + rx];
      tmp[row + x] = sum;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -ry; k <= ry; k++) sum += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x] * ky[k + ry];
      out[y * w + x] = sum;
    }
  }
  return out;
}

function kernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float32Array(2 * r + 1);
  let total = 0;
  for (let i = -r; i <= r; i++) total += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= total;
  return k;
}
