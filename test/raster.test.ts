import { describe, expect, it } from 'vitest';
import { blueNoiseMask, boxBlur, inkToRaster, sobel } from '../src/raster.ts';

describe('inkToRaster', () => {
  it('packs 1-per-dot ink MSB first, 8 dots per byte', () => {
    const ink = [1, 0, 0, 0, 0, 0, 0, 1, /* row 2 */ 0, 1, 1, 0, 0, 0, 0, 0];
    const raster = inkToRaster(ink, 8, 2);
    expect(raster).toEqual({ bitmap: new Uint8Array([0b10000001, 0b01100000]), widthDots: 8, heightDots: 2 });
  });

  it('keeps rows aligned on wider images', () => {
    const width = 16;
    const ink = new Uint8Array(width * 2);
    ink[width + 15] = 1; // last dot of row 2
    expect([...inkToRaster(ink, width, 2).bitmap]).toEqual([0, 0, 0, 0b00000001]);
  });
});

describe('boxBlur / sobel', () => {
  const flat = (w: number, h: number, v: number) => new Float32Array(w * h).fill(v);

  it('leaves a flat image flat and finds no edges', () => {
    const img = flat(5, 5, 100);
    expect([...boxBlur(img, 5, 5)].every((v) => v === 100)).toBe(true);
    expect([...sobel(img, 5, 5)].every((v) => v === 0)).toBe(true);
  });

  it('finds a vertical edge', () => {
    const w = 6;
    const h = 4;
    const img = flat(w, h, 0);
    for (let y = 0; y < h; y++) for (let x = 3; x < w; x++) img[y * w + x] = 255;
    const edges = sobel(img, w, h);
    expect(edges[1 * w + 2]).toBeGreaterThan(500); // next to the step
    expect(edges[1 * w + 4]).toBe(0); // inside the flat white part
  });
});

describe('threshold masks', () => {
  it('blue-noise mask ranks every cell exactly once', () => {
    const { size, ranks } = blueNoiseMask(16);
    expect(new Set(ranks).size).toBe(size * size);
    expect(Math.max(...ranks)).toBe(size * size - 1);
  });
});
