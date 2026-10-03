// Shared photo print look, used by the booth and the standalone print page.
// Tune with the dithering comparison on /test.html.

import { DEFAULT_PRINT_WIDTH_DOTS } from './printer.js';
import { canvasToRaster, fitToPrintWidth } from './raster.js';

export const PHOTO_DITHER = 'atkinson';
export const PHOTO_NOISE = 16;
export const PHOTO_DENSITY = 3;

// Image/canvas/video frame → dithered raster `width` dots wide.
export function photoToRaster(source, width = DEFAULT_PRINT_WIDTH_DOTS) {
  return canvasToRaster(fitToPrintWidth(source, width), {
    photo: true,
    dither: PHOTO_DITHER,
    noise: PHOTO_NOISE,
  });
}

// Print a raster made by photoToRaster.
export async function printPhoto(printer, { bitmap, widthDots, heightDots }) {
  await printer.init({ density: PHOTO_DENSITY });
  await printer.printRaster(bitmap, widthDots, heightDots);
  await printer.feed(80);
}
