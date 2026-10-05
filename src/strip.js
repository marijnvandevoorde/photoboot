// Compose N shots + a template into the final sticker.
//
// Layout, top to bottom:
//   [ header canvas     at stickerWidth ]
//   [ topPadding        rows of white   ]
//   [ photo 1           centred, template.photoWidth wide ]
//   [ gap               rows of white   ]
//   ... photo N ...
//   [ bottomPadding     rows of white   ]
//   [ footer canvas     at stickerWidth ]
//
// Each shot has already been rasterised by photoToRaster() with the look the
// guest picked. This step is pure composition: no dithering happens here
// except on the (vector) header/footer canvases, which get a 50% threshold.

import { whiteCanvas } from './effects.js';
import { canvasToRaster, rasterToCanvas } from './raster.js';

export function composeStrip(shotRasters, template, stickerWidth) {
  if (!shotRasters?.length) throw new Error('composeStrip needs at least one shot');
  if (stickerWidth % 8 !== 0) throw new Error('stickerWidth must be a multiple of 8');

  const header = template.buildHeader?.(stickerWidth) ?? null;
  const footer = template.buildFooter?.(stickerWidth) ?? null;

  const shotHeight = shotRasters.reduce((sum, r) => sum + r.heightDots, 0);
  const gaps = (shotRasters.length - 1) * (template.gap ?? 0);
  const headerH = header?.height ?? 0;
  const footerH = footer?.height ?? 0;
  const topPad = template.topPadding ?? 0;
  const botPad = template.bottomPadding ?? 0;

  const totalHeight = headerH + topPad + shotHeight + gaps + botPad + footerH;

  const canvas = whiteCanvas(stickerWidth, totalHeight);
  const ctx = canvas.getContext('2d');

  let y = 0;
  if (header) {
    ctx.drawImage(header, 0, y);
    y += header.height;
  }
  y += topPad;
  for (let i = 0; i < shotRasters.length; i++) {
    const r = shotRasters[i];
    const x = Math.floor((stickerWidth - r.widthDots) / 2);
    ctx.drawImage(rasterToCanvas(r), x, y);
    y += r.heightDots;
    if (i < shotRasters.length - 1) y += template.gap ?? 0;
  }
  y += botPad;
  if (footer) ctx.drawImage(footer, 0, y);

  // Flatten the mixed (raster photos + vector header/footer) canvas back to
  // 1-bit for the printer. Threshold keeps the vector art crisp; the photos
  // are already 1-bit so this is a no-op for them.
  return canvasToRaster(canvas, { dither: 'threshold' });
}
