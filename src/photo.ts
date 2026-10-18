// Shared photo print pipeline, used by the booth, the preview page, and the
// standalone print page.

import { DOTS_PER_MM, get } from './config.ts';
import * as fx from './effects.ts';
import type { PrinterBase } from './printers/base.ts';
import { DEFAULT_TEAR_MM, modelById } from './printers/models.ts';
import { canvasToRaster, fitToPrintWidth, shrinkRaster } from './raster.ts';
import { composeColour, composeStrip } from './strip.ts';
import type { ImageSource, Look, Raster, RasterOptions, Template } from './types.ts';

export interface PhotoStyle {
  id: string;
  label: string;
  options?: RasterOptions;
  render?: (canvas: HTMLCanvasElement) => Raster;
}

export interface PhotoTwist {
  id: string;
  label: string;
  apply?: (canvas: HTMLCanvasElement) => HTMLCanvasElement;
}

export const PHOTO_DENSITY_DEFAULT = 4;

// Styles have canvasToRaster options or their own `render`. The 'none' style
// is a plain threshold — useful when filters are disabled.
export const PHOTO_STYLES: PhotoStyle[] = [
  { id: 'classic', label: 'Classic', options: { dither: 'atkinson', noise: 16 } },
  {
    id: 'pop',
    label: 'Pop art',
    options: { dither: 'halftone', period: 11, gamma: 0.55, clip: 0.05, sharpen: 1, outline: 1 },
  },
  { id: 'woodcut', label: 'Woodcut', render: fx.woodcut },
  { id: 'stipple', label: 'Stipple', render: fx.stipple },
];

export const PHOTO_TWISTS: PhotoTwist[] = [
  { id: 'none', label: 'Normal' },
  { id: 'mirror', label: 'Mirror', apply: fx.mirror },
  { id: 'bighead', label: 'Big head', apply: fx.bigHead },
];

export const DEFAULT_LOOK: Look = { style: 'classic', twist: 'none' };
export const PLAIN_LOOK: Look = { style: 'classic', twist: 'none' };

const find = <T extends { id: string }>(list: T[], id: string): T => list.find((item) => item.id === id) ?? list[0];

// Image/canvas/video frame → photo raster `width` dots wide in one look.
export function photoToRaster(source: ImageSource, width: number, look: Look = DEFAULT_LOOK): Raster {
  const style = find(PHOTO_STYLES, look.style);
  const twist = find(PHOTO_TWISTS, look.twist);
  let canvas = fitToPrintWidth(source, width);
  if (twist.apply) canvas = twist.apply(canvas);
  return style.render ? style.render(canvas) : canvasToRaster(canvas, { photo: true, ...style.options });
}

// Compose one or more shots through a template into the sticker raster.
// shots: array of HTMLCanvas / HTMLImage (full-resolution camera frames).
// Returns { bitmap, widthDots, heightDots }.
export function renderSticker(
  shots: ImageSource[],
  template: Template,
  { stickerWidth, look = DEFAULT_LOOK }: { stickerWidth: number; look?: Look }
): Raster {
  const photoWidth = template.photoWidth(stickerWidth);
  const rasters = shots.map((shot) => photoToRaster(shot, photoWidth, look));
  return composeStrip(rasters, template, stickerWidth);
}

// The colour keepsake (shared + archived): same layout as the sticker, in
// colour, with the guest's twist but not the black-and-white style.
export function renderColour(
  shots: HTMLCanvasElement[],
  template: Template,
  { stickerWidth, look = DEFAULT_LOOK }: { stickerWidth: number; look?: Look }
): HTMLCanvasElement {
  return composeColour(shots, template, stickerWidth, { twist: find(PHOTO_TWISTS, look.twist).apply ?? null });
}

// Blank rows after each print, so the sticker clears the tear edge: the
// host's `tearMm`, else the printer model's own distance. Printed rows
// always advance the paper, unlike a bare feed command (not every printer
// honours one), so this is the whole margin.
export function tearDots(printer: PrinterBase | null): number {
  const model = modelById(get('printerModel')) ?? printer?.model ?? null;
  const mm = get('tearMm') || (model ? model.tearMm : DEFAULT_TEAR_MM);
  const perMm = model ? model.dpi / 25.4 : get('dotsPerMm') || DOTS_PER_MM;
  return Math.round(mm * perMm);
}

// Print a raster `copies` times, each followed by the tear margin.
// A sticker wider than the printer's head is scaled down to fit.
export async function printPhoto(
  printer: PrinterBase,
  raster: Raster,
  { density, copies = 1 }: { density?: number; copies?: number } = {}
): Promise<void> {
  const { bitmap, widthDots, heightDots } = shrinkRaster(raster, printer.headWidthDots);
  const tear = tearDots(printer);
  const padded = new Uint8Array(bitmap.length + (widthDots / 8) * tear);
  padded.set(bitmap);
  await printer.init({ density: density ?? get('printDensity') ?? PHOTO_DENSITY_DEFAULT });
  for (let i = 0; i < Math.max(1, copies); i++) {
    await printer.printRaster(padded, widthDots, heightDots + tear);
  }
}
