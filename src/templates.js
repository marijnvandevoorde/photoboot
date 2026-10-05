// Template registry. A template says how to lay out the shot(s): the photo
// width (relative to the sticker width), how much white space to leave above
// / below / between shots, and optional header/footer canvases rendered at
// the full sticker width.
//
// The strip composer in strip.js stitches them together:
//   [ header? ][ topPadding ][ photo (gap) photo … photo ][ bottomPadding ][ footer? ]
//
// Built-ins:
//   - 'plain'  : full-width shots, no decoration.
//   - 'text'   : typed title above, names / date / hashtag below, no PNGs.
//   - 'custom' : user-uploaded header + footer images, full-width shots.
//
// Adding a new built-in: push an entry here, implement its load branch in
// loadTemplate(), and (if it needs text/choices) surface those keys in the
// settings page.

import { whiteCanvas } from './effects.js';
import { fitToPrintWidth } from './raster.js';
import { kv } from './storage.js';

export const BUILT_IN_TEMPLATES = [
  { id: 'plain', label: 'Plain' },
  { id: 'text', label: 'Text (title, names, date)' },
  { id: 'custom', label: 'Custom (upload header / footer)' },
];

// System font stacks only, so the booth needs no internet for them.
export const TEXT_FONTS = [
  { id: 'sans', label: 'Clean', stack: '700 {px}px system-ui, -apple-system, "Helvetica Neue", sans-serif' },
  { id: 'serif', label: 'Classic serif', stack: '700 {px}px Georgia, "Times New Roman", serif' },
  { id: 'script', label: 'Handwritten', stack: '{px}px "Snell Roundhand", "Brush Script MT", "Segoe Script", cursive' },
  { id: 'rounded', label: 'Rounded', stack: '700 {px}px "Arial Rounded MT Bold", "Avenir Next", system-ui, sans-serif' },
  { id: 'mono', label: 'Typewriter', stack: '700 {px}px "American Typewriter", "Courier New", monospace' },
];

export const TEXT_DEFAULTS = { title: '', line1: '', line2: '', font: 'sans' };

const PLAIN = {
  label: 'Plain',
  photoWidth: (sticker) => sticker,
  topPadding: 0,
  bottomPadding: 0,
  gap: 8,
  buildHeader: null,
  buildFooter: null,
};

// Resolve a template id into a layout spec. Awaits any assets it needs.
export async function loadTemplate(id, config = {}) {
  if (id === 'text') return textTemplate({ ...TEXT_DEFAULTS, ...config });
  if (id === 'custom') {
    const [header, footer] = await Promise.all([
      loadStoredImage('template:header'),
      loadStoredImage('template:footer'),
    ]);
    return {
      label: 'Custom',
      photoWidth: (sticker) => sticker,
      topPadding: header ? 0 : 8,
      bottomPadding: footer ? 0 : 8,
      gap: 8,
      buildHeader: header ? (sticker) => fitToPrintWidth(header, sticker) : null,
      buildFooter: footer ? (sticker) => fitToPrintWidth(footer, sticker) : null,
    };
  }
  return PLAIN;
}

function textTemplate({ title, line1, line2, font }) {
  const stack = (TEXT_FONTS.find((f) => f.id === font) ?? TEXT_FONTS[0]).stack;
  const has = (s) => !!s?.trim();
  return {
    label: 'Text',
    photoWidth: (sticker) => sticker,
    topPadding: has(title) ? 0 : 8,
    bottomPadding: has(line1) || has(line2) ? 0 : 8,
    gap: 8,
    buildHeader: has(title) ? (w) => textBlock(w, stack, [{ text: title, size: 46 }], 14, 10) : null,
    buildFooter:
      has(line1) || has(line2)
        ? (w) =>
            textBlock(
              w,
              stack,
              [has(line1) && { text: line1, size: 54 }, has(line2) && { text: line2, size: 28 }].filter(Boolean),
              18,
              24
            )
        : null,
  };
}

// Centred lines of text at the sticker width. Sizes are for a 552-dot
// sticker and scale with the width; long lines shrink to fit.
function textBlock(width, stack, lines, padTop, padBottom) {
  const k = width / 552;
  const margin = Math.round(16 * k);
  const measure = document.createElement('canvas').getContext('2d');
  const laid = lines.map(({ text, size }) => {
    let px = Math.round(size * k);
    measure.font = stack.replace('{px}', px);
    const w = measure.measureText(text.trim()).width;
    if (w > width - 2 * margin) px = Math.floor((px * (width - 2 * margin)) / w);
    return { text: text.trim(), px, font: stack.replace('{px}', px) };
  });
  const lineGap = Math.round(10 * k);
  const height =
    Math.round(padTop * k) +
    laid.reduce((sum, l) => sum + Math.round(l.px * 1.15), 0) +
    lineGap * (laid.length - 1) +
    Math.round(padBottom * k);
  const canvas = whiteCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  let y = Math.round(padTop * k);
  for (const l of laid) {
    ctx.font = l.font;
    y += Math.round(l.px * 0.95);
    ctx.fillText(l.text, width / 2, y);
    y += Math.round(l.px * 0.2) + lineGap;
  }
  return canvas;
}

async function loadStoredImage(key) {
  const blob = await kv.get(key).catch(() => null);
  if (!blob) return null;
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* fall through to <img> */
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

export async function saveTemplateImage(slot, blob) {
  if (!['header', 'footer'].includes(slot)) throw new Error(`Bad slot: ${slot}`);
  await kv.set(`template:${slot}`, blob);
}

export async function clearTemplateImage(slot) {
  await kv.delete(`template:${slot}`);
}

export async function hasTemplateImage(slot) {
  const blob = await kv.get(`template:${slot}`).catch(() => null);
  return !!blob;
}

export async function templateImageUrl(slot) {
  const blob = await kv.get(`template:${slot}`).catch(() => null);
  return blob ? URL.createObjectURL(blob) : null;
}

// Template images as data URLs, for profiles / exports / server events.
export async function exportTemplateImages() {
  const out = {};
  for (const slot of ['header', 'footer']) {
    const blob = await kv.get(`template:${slot}`).catch(() => null);
    out[slot] = blob ? await blobToDataUrl(blob) : null;
  }
  return out;
}

export async function importTemplateImages(images = {}) {
  for (const slot of ['header', 'footer']) {
    if (images[slot]) await kv.set(`template:${slot}`, await (await fetch(images[slot])).blob());
    else await kv.delete(`template:${slot}`);
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
