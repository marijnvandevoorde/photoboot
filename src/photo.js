// Shared photo print looks, used by the booth and the standalone print page.
// Tune with the dithering comparison on /test.html.

import { DEFAULT_PRINT_WIDTH_DOTS } from './printer.js';
import { canvasToRaster, fitToPrintWidth } from './raster.js';

export const PHOTO_DENSITY = 3;

// Filters guests pick from after taking a photo. Options go straight to
// canvasToRaster. The first one is the default.
//
// classic: Atkinson + threshold noise. Plain Atkinson gave regular hatching
//   on flat walls and crushed backlit faces.
// light: high-key — midtones become sparse dots, ink outlines keep the face.
// A 1-bit printer has no grey, only dot density, so "lighter dither" means
// fewer dots, not paler ones.
export const PHOTO_FILTERS = [
  { id: 'classic', label: 'Classic', options: { dither: 'atkinson', noise: 16 } },
  { id: 'light', label: 'Light', options: { dither: 'atkinson', noise: 8, gamma: 0.3, clip: 0.03, outline: 0.8 } },
  { id: 'stencil', label: 'Stencil', options: { dither: 'stencil', gamma: 0.9, clip: 0.04, sharpen: 0 } },
  { id: 'lines', label: 'Lines', options: { dither: 'lines', gamma: 0.8, clip: 0.04, sharpen: 1, outline: 0.6 } },
  { id: 'halftone', label: 'Halftone', options: { dither: 'halftone', gamma: 0.55, clip: 0.08, sharpen: 1.5 } },
  { id: 'comic', label: 'Comic', options: { dither: 'comic', gamma: 0.6, clip: 0.03 } },
  { id: 'sketch', label: 'Sketch', options: { dither: 'atkinson', sketch: true, sharpen: 0 } },
];
export const DEFAULT_FILTER = PHOTO_FILTERS[0].id;

// Image/canvas/video frame → dithered raster `width` dots wide.
export function photoToRaster(source, width = DEFAULT_PRINT_WIDTH_DOTS, filterId = DEFAULT_FILTER) {
  const filter = PHOTO_FILTERS.find((f) => f.id === filterId) ?? PHOTO_FILTERS[0];
  return canvasToRaster(fitToPrintWidth(source, width), { photo: true, ...filter.options });
}

// Print a raster made by photoToRaster.
export async function printPhoto(printer, { bitmap, widthDots, heightDots }) {
  await printer.init({ density: PHOTO_DENSITY });
  await printer.printRaster(bitmap, widthDots, heightDots);
  await printer.feed(80);
}
