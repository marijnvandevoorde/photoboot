// Shared photo print pipeline, used by the booth, the preview page, and the
// standalone print page.

import { get } from './config.js';
import * as fx from './effects.js';
import { canvasToRaster, fitToPrintWidth } from './raster.js';
import { composeStrip } from './strip.js';

export const PHOTO_DENSITY_DEFAULT = 3;

// Blank paper after each print so the sticker clears the tear bar (~6 mm).
// Printed rows always advance the paper, unlike a bare feed command.
const TEAR_MARGIN_DOTS = 72;

// Styles have canvasToRaster options or their own `render`. The 'none' style
// is a plain threshold — useful when filters are disabled.
export const PHOTO_STYLES = [
  { id: 'classic', label: 'Classic', options: { dither: 'atkinson', noise: 16 } },
  { id: 'pop', label: 'Pop art', options: { dither: 'halftone', period: 11, gamma: 0.55, clip: 0.05, sharpen: 1, outline: 1 } },
  { id: 'woodcut', label: 'Woodcut', render: fx.woodcut },
  { id: 'stipple', label: 'Stipple', render: fx.stipple },
];

export const PHOTO_TWISTS = [
  { id: 'none', label: 'Normal' },
  { id: 'mirror', label: 'Mirror', apply: fx.mirror },
  { id: 'bighead', label: 'Big head', apply: fx.bigHead },
];

export const DEFAULT_LOOK = { style: 'classic', twist: 'none' };
export const PLAIN_LOOK = { style: 'classic', twist: 'none' };

const find = (list, id) => list.find((item) => item.id === id) ?? list[0];

// Image/canvas/video frame → photo raster `width` dots wide in one look.
export function photoToRaster(source, width, look = DEFAULT_LOOK) {
  const style = find(PHOTO_STYLES, look.style);
  const twist = find(PHOTO_TWISTS, look.twist);
  let canvas = fitToPrintWidth(source, width);
  if (twist.apply) canvas = twist.apply(canvas);
  return style.render ? style.render(canvas) : canvasToRaster(canvas, { photo: true, ...style.options });
}

// Compose one or more shots through a template into the sticker raster.
// shots: array of HTMLCanvas / HTMLImage (full-resolution camera frames).
// Returns { bitmap, widthDots, heightDots }.
export function renderSticker(shots, template, { stickerWidth, look = DEFAULT_LOOK } = {}) {
  const photoWidth = template.photoWidth(stickerWidth);
  const rasters = shots.map((shot) => photoToRaster(shot, photoWidth, look));
  return composeStrip(rasters, template, stickerWidth);
}

const FEED_DOTS = 80;

// Paper a sticker uses beyond its own height (tear margin + feed), in dots.
export const PRINT_EXTRA_DOTS = TEAR_MARGIN_DOTS + FEED_DOTS;

// Print a raster `copies` times, each followed by the tear margin.
export async function printPhoto(printer, { bitmap, widthDots, heightDots }, { density, copies = 1 } = {}) {
  const padded = new Uint8Array(bitmap.length + (widthDots / 8) * TEAR_MARGIN_DOTS);
  padded.set(bitmap);
  await printer.init({ density: density ?? get('printDensity') ?? PHOTO_DENSITY_DEFAULT });
  for (let i = 0; i < Math.max(1, copies); i++) {
    await printer.printRaster(padded, widthDots, heightDots + TEAR_MARGIN_DOTS);
    await printer.feed(FEED_DOTS);
  }
}
