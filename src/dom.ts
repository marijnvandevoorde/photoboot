// Small typed DOM helpers. The pages are static HTML, so a missing element or
// 2D context is a bug: fail loudly instead of null-checking everywhere.

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

export function ctx2d(canvas: HTMLCanvasElement | OffscreenCanvas, settings?: CanvasRenderingContext2DSettings) {
  const ctx = canvas.getContext('2d', settings) as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error('2D canvas unavailable');
  return ctx;
}

export function newCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function option(value: string | number, label: string): HTMLOptionElement {
  const opt = document.createElement('option');
  opt.value = String(value);
  opt.textContent = label;
  return opt;
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
