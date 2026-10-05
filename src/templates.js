// Template registry. A template says how to lay out the shot(s): the photo
// width (relative to the sticker width), how much white space to leave above
// / below / between shots, and optional header/footer canvases rendered at
// the full sticker width.
//
// The strip composer in strip.js stitches them together:
//   [ header? ][ topPadding ][ photo (gap) photo … photo ][ bottomPadding ][ footer? ]
//
// Two built-ins ship:
//   - 'plain'  : full-width shots, no decoration.
//   - 'custom' : user-uploaded header + footer images, full-width shots.
//
// Adding a new built-in: push an entry here, implement its load branch in
// loadTemplate(), and (if it needs text/choices) surface those keys in the
// settings page.

import { fitToPrintWidth } from './raster.js';
import { kv } from './storage.js';

export const BUILT_IN_TEMPLATES = [
  { id: 'plain', label: 'Plain' },
  { id: 'custom', label: 'Custom (upload header / footer)' },
];

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
export async function loadTemplate(id, _config = {}) {
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
