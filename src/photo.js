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
export const PHOTO_FILTERS = [
  { id: 'classic', label: 'Classic', options: { dither: 'atkinson', noise: 16 } },
  { id: 'soft', label: 'Soft', options: { dither: 'stucki', noise: 6, gamma: 0.7, sharpen: 0.3 } },
  { id: 'bright', label: 'Bright', options: { dither: 'atkinson', noise: 16, gamma: 0.42, clip: 0.02 } },
  { id: 'punch', label: 'Punch', options: { dither: 'atkinson', noise: 10, gamma: 0.62, clip: 0.05, sharpen: 1.4 } },
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
