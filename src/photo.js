// Shared photo print looks, used by the booth and the standalone print page.
// Tune with the dithering comparison on /test.html and the /gallery.html
// overview.

import * as fx from './effects.js';
import { DEFAULT_PRINT_WIDTH_DOTS } from './printer.js';
import { canvasToRaster, fitToPrintWidth } from './raster.js';

export const PHOTO_DENSITY = 3;

// Guests combine a style, a twist and a frame. The first of each is the
// default. A style has canvasToRaster `options` or its own `render`.
//
// classic: Atkinson + threshold noise. Plain Atkinson gave regular hatching
//   on flat walls and crushed backlit faces.
// light: high-key — midtones become sparse dots, ink outlines keep the face.
//   A 1-bit printer has no grey, only dot density, so "lighter dither" means
//   fewer dots, not paler ones.
export const PHOTO_STYLES = [
  { id: 'classic', label: 'Classic', options: { dither: 'atkinson', noise: 16 } },
  { id: 'light', label: 'Light', options: { dither: 'atkinson', noise: 8, gamma: 0.3, clip: 0.03, outline: 0.8 } },
  { id: 'lines', label: 'Lines', options: { dither: 'lines', gamma: 0.8, clip: 0.04, sharpen: 1, outline: 0.6 } },
  { id: 'comic', label: 'Comic', options: { dither: 'comic', gamma: 0.6, clip: 0.03 } },
  { id: 'sketch', label: 'Sketch', options: { dither: 'atkinson', sketch: true, sharpen: 0 } },
  { id: 'pop', label: 'Pop art', options: { dither: 'halftone', period: 11, gamma: 0.55, clip: 0.05, sharpen: 1, outline: 1 } },
  { id: '8bit', label: '8-bit', render: fx.pixel8bit },
  { id: 'ascii', label: 'ASCII', render: fx.ascii },
  { id: 'woodcut', label: 'Woodcut', render: fx.woodcut },
  { id: 'hatch', label: 'Crosshatch', render: fx.crosshatch },
  { id: 'spiral', label: 'Spiral', render: fx.spiral },
  { id: 'waves', label: 'Waves', render: fx.waves },
  { id: 'stipple', label: 'Stipple', render: fx.stipple },
];

export const PHOTO_TWISTS = [
  { id: 'none', label: 'None' },
  { id: 'mirror', label: 'Mirror', apply: fx.mirror },
  { id: 'bighead', label: 'Big head', apply: fx.bigHead },
  { id: 'glitch', label: 'Glitch', apply: fx.glitch },
];

// `inner`: photo width inside the frame (multiple of 8).
export const PHOTO_FRAMES = [
  { id: 'none', label: 'None' },
  { id: 'polaroid', label: 'Polaroid', inner: 504, decorate: fx.polaroid },
  { id: 'wanted', label: 'Wanted', inner: 456, decorate: fx.wanted },
  { id: 'bubble', label: 'Bubble', decorate: fx.bubble },
  { id: 'warhol', label: 'Warhol' },
];

// The four looks of the Warhol 2×2, in reading order.
const WARHOL_STYLES = ['pop', 'comic', 'light', 'woodcut'];
const WARHOL_TILE = 272; // two tiles + 8-dot gap = 552
const STRIP_GAP = 16;

export const DEFAULT_LOOK = { style: 'classic', twist: 'none', frame: 'none' };

const find = (list, id) => list.find((item) => item.id === id) ?? list[0];

// Fitted canvas → raster in one style.
function renderStyle(canvas, styleId) {
  const style = find(PHOTO_STYLES, styleId);
  return style.render ? style.render(canvas) : canvasToRaster(canvas, { photo: true, ...style.options });
}

// One or more shots (a strip has three) → the sticker raster.
// `context`: { eventName, date, seed } for frames with text.
export function renderPhoto(shots, look = DEFAULT_LOOK, { width = DEFAULT_PRINT_WIDTH_DOTS, eventName = '', date = '', seed = 1 } = {}) {
  const twist = find(PHOTO_TWISTS, look.twist);
  const frame = find(PHOTO_FRAMES, look.frame);
  const prepare = (shot, w) => {
    const fitted = fitToPrintWidth(shot, w);
    return twist.apply ? twist.apply(fitted, seed) : fitted;
  };

  if (frame.id === 'warhol') {
    const tiles = WARHOL_STYLES.map((style, i) => renderStyle(prepare(shots[i % shots.length], WARHOL_TILE), style));
    return fx.composeGrid(tiles, { cols: 2, gap: width - 2 * WARHOL_TILE, width });
  }

  const inner = frame.inner ?? width;
  const rasters = shots.map((shot) => renderStyle(prepare(shot, inner), look.style));
  const photo = rasters.length > 1 ? fx.composeGrid(rasters, { gap: STRIP_GAP, width: inner }) : rasters[0];
  return frame.decorate ? frame.decorate(photo, { width, eventName, date, seed }) : photo;
}

// Image/canvas/video frame → dithered raster `width` dots wide, default look.
export function photoToRaster(source, width = DEFAULT_PRINT_WIDTH_DOTS) {
  return renderPhoto([source], DEFAULT_LOOK, { width });
}

// Print a raster made by renderPhoto.
export async function printPhoto(printer, { bitmap, widthDots, heightDots }) {
  await printer.init({ density: PHOTO_DENSITY });
  await printer.printRaster(bitmap, widthDots, heightDots);
  await printer.feed(80);
}
