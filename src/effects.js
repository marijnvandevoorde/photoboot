// Fun print effects, all in printer dots:
// - styles: fitted colour canvas → 1-bit raster, for looks that aren't a
//   plain dither/screen (see canvasToRaster for those),
// - twists: canvas → canvas geometry applied before the style,
// - frames: decoration drawn around an already rendered raster.

import { boxBlur, canvasToRaster, inkToRaster, localMean, rasterToCanvas, sobel, toGray } from './raster.js';

const TAU = Math.PI * 2;
const TONE = { photo: true, gamma: 0.6, clip: 0.02, sharpen: 0.8 };
const HAND_FONT = '"Marker Felt", "Chalkboard SE", "Comic Sans MS", cursive';
const POSTER_FONT = 'Rockwell, "American Typewriter", Georgia, "Times New Roman", serif';

const frac = (v) => v - Math.floor(v);

// Small seeded PRNG (mulberry32): same photo + seed → same glitch/caption.
export function seededRandom(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function whiteCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  return canvas;
}

// Per-dot ink from a function of (x, y, i, darkness 0–1, edge strength).
function inkFrom(canvas, tone, fn) {
  const { width, height } = canvas;
  const gray = boxBlur(toGray(canvas, tone), width, height);
  const edges = sobel(gray, width, height);
  const ink = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      ink[i] = fn(x, y, 1 - Math.max(0, Math.min(255, gray[i])) / 255, edges[i]) ? 1 : 0;
    }
  }
  return inkToRaster(ink, width, height);
}

// ---------- styles ----------

// Big pixels in four flat shades, like a Game Boy.
export function pixel8bit(canvas) {
  const { width, height } = canvas;
  const gray = toGray(canvas, { ...TONE, gamma: 0.6, clip: 0.03, sharpen: 1.2 });
  // Local contrast boost, so a face against a bright wall gets its own shades.
  const local = localMean(gray, width, height, 14);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.4 * gray[i] + 0.6 * (128 + 2 * (gray[i] - local[i]));
  const B = 7;
  // Block averages posterized at their own quartiles, so every photo uses all
  // four shades and a backlit face doesn't merge into one dark block.
  const cols = Math.ceil(width / B);
  const rows = Math.ceil(height / B);
  const blocks = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      let n = 0;
      for (let y = r * B; y < Math.min(height, r * B + B); y++) {
        for (let x = c * B; x < Math.min(width, c * B + B); x++, n++) sum += gray[y * width + x];
      }
      blocks[r * cols + c] = sum / n;
    }
  }
  const sorted = blocks.slice().sort();
  const cuts = [0.22, 0.5, 0.78].map((q) => sorted[Math.floor(q * (sorted.length - 1))]);
  const ink = new Uint8Array(width * height);
  for (let by = 0; by < height; by += B) {
    for (let bx = 0; bx < width; bx += B) {
      const v = blocks[(by / B) * cols + bx / B];
      const level = cuts.filter((cut) => v > cut).length; // 0 dark … 3 light
      if (level === 3) continue;
      for (let y = by; y < Math.min(height, by + B); y++) {
        for (let x = bx; x < Math.min(width, bx + B); x++) {
          // Shades: solid, 75% and 25% dot patterns.
          const shade = level === 0 ? 1 : level === 1 ? !(x & 1 && y & 1) : !(x & 1) && !(y & 1);
          ink[y * width + x] = shade ? 1 : 0;
        }
      }
    }
  }
  return inkToRaster(ink, width, height);
}

// The photo typed out in characters, darkest → lightest.
export function ascii(canvas) {
  const { width, height } = canvas;
  const gray = toGray(canvas, { ...TONE, gamma: 0.75 });
  const RAMP = '@%#*+=-:. ';
  const CW = 9;
  const CH = 14;
  const out = whiteCanvas(width, height);
  const ctx = out.getContext('2d');
  ctx.font = 'bold 15px Menlo, Consolas, "Courier New", monospace';
  ctx.textBaseline = 'top';
  for (let cy = 0; cy + CH <= height; cy += CH) {
    for (let cx = 0; cx + CW <= width; cx += CW) {
      let sum = 0;
      for (let y = cy; y < cy + CH; y++) for (let x = cx; x < cx + CW; x++) sum += gray[y * width + x];
      const v = Math.max(0, Math.min(255, sum / (CW * CH)));
      const ch = RAMP[Math.min(RAMP.length - 1, Math.floor((v / 256) * RAMP.length))];
      if (ch !== ' ') ctx.fillText(ch, cx, cy);
    }
  }
  return canvasToRaster(out, { dither: 'threshold' });
}

// Solid shadows, bold outlines and carved diagonal strokes that bend with
// the tone, like a linocut.
export function woodcut(canvas) {
  return inkFrom(canvas, { ...TONE, gamma: 0.5, clip: 0.03, sharpen: 0.6 }, (x, y, d, edge) => {
    if (edge > 70 || d > 0.82) return true;
    if (d < 0.25) return false;
    const t = (d - 0.25) / 0.57; // 0 light … 1 dark
    const phase = frac((x * 0.8 + y * 0.6) / 7 + d * 2.5);
    return Math.abs(phase - 0.5) * 2 < t;
  });
}

// Pen-and-ink hatching: more line directions the darker it gets.
export function crosshatch(canvas) {
  return inkFrom(canvas, { ...TONE, gamma: 0.5, clip: 0.03 }, (x, y, d, edge) =>
    edge > 100 ||
    (d > 0.3 && (x + y) % 7 === 0) ||
    (d > 0.5 && (((x - y) % 7) + 7) % 7 === 0) ||
    (d > 0.68 && y % 4 === 0) ||
    (d > 0.84 && x % 3 === 0)
  );
}

// One continuous spiral from the centre, thicker where it's dark.
export function spiral(canvas) {
  const { width, height } = canvas;
  const S = 6; // dots between turns
  return inkFrom(canvas, { ...TONE, gamma: 0.95, clip: 0.03, outline: 0.7 }, (x, y, d) => {
    const dx = x - width / 2;
    const dy = y - height / 2;
    const u = Math.hypot(dx, dy) / S - Math.atan2(dy, dx) / TAU;
    return Math.abs(frac(u) - 0.5) < 0.05 + d * 0.42;
  });
}

// Flowing wavy lines, bent and thickened by the image.
export function waves(canvas) {
  return inkFrom(canvas, { ...TONE, gamma: 0.7 }, (x, y, d) => {
    const phase = y / 7 + 0.8 * Math.sin(x / 23 + y / 51) + d * 1.4;
    return Math.abs(frac(phase) - 0.5) < 0.04 + d * 0.44;
  });
}

// Pointillism: random round dots, denser where it's dark.
export function stipple(canvas) {
  const { width, height } = canvas;
  const gray = toGray(canvas, { ...TONE, gamma: 0.42, clip: 0.03, sharpen: 1.4, outline: 1 });
  const rand = seededRandom(1);
  const ink = new Uint8Array(width * height);
  // Error-diffuse a 3-dot grid (keeps features), then stamp a slightly
  // jittered round dot wherever it inks (looks hand-placed).
  const C = 3;
  const cols = Math.ceil(width / C);
  const rows = Math.ceil(height / C);
  const cells = new Float32Array(cols * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) cells[Math.floor(y / C) * cols + Math.floor(x / C)] += gray[y * width + x] / (C * C);
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const on = cells[i] < 128;
      const err = cells[i] - (on ? 0 : 255);
      if (c + 1 < cols) cells[i + 1] += (err * 7) / 16;
      if (r + 1 < rows) {
        if (c > 0) cells[i + cols - 1] += (err * 3) / 16;
        cells[i + cols] += (err * 5) / 16;
        if (c + 1 < cols) cells[i + cols + 1] += err / 16;
      }
      if (!on) continue;
      const px = c * C + 1.5 + (rand() - 0.5) * 1.4;
      const py = r * C + 1.5 + (rand() - 0.5) * 1.4;
      for (let y = Math.floor(py - 2); y <= py + 2; y++) {
        for (let x = Math.floor(px - 2); x <= px + 2; x++) {
          if (x >= 0 && y >= 0 && x < width && y < height && (x - px) ** 2 + (y - py) ** 2 <= 2.6) ink[y * width + x] = 1;
        }
      }
    }
  }
  return inkToRaster(ink, width, height);
}

// ---------- twists ----------

// Left half + its mirror image: a perfectly symmetrical face.
export function mirror(canvas) {
  const { width, height } = canvas;
  const out = whiteCanvas(width, height);
  const ctx = out.getContext('2d');
  const half = width / 2;
  ctx.drawImage(canvas, 0, 0, half, height, 0, 0, half, height);
  ctx.translate(width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(canvas, 0, 0, half, height, 0, 0, half, height);
  return out;
}

// Fisheye bulge around the upper centre, where faces usually are.
export function bigHead(canvas) {
  const { width, height } = canvas;
  const src = canvas.getContext('2d').getImageData(0, 0, width, height);
  const out = whiteCanvas(width, height);
  const ctx = out.getContext('2d');
  const dst = ctx.getImageData(0, 0, width, height);
  const cx = width / 2;
  const cy = height * 0.42;
  const R = Math.min(width, height) * 0.5;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      const k = r < R && r > 0 ? Math.pow(r / R, 0.7) : 1; // < 1 → magnify
      const sx = Math.max(0, Math.min(width - 1.001, cx + dx * k));
      const sy = Math.max(0, Math.min(height - 1.001, cy + dy * k));
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const p = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const at = (xx, yy) => src.data[(yy * width + xx) * 4 + c];
        dst.data[p + c] =
          at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
      }
      dst.data[p + 3] = 255;
    }
  }
  ctx.putImageData(dst, 0, 0);
  return out;
}

// Broken-tape look: slices shifted sideways, plus light scanlines.
export function glitch(canvas, seed = 7) {
  const { width, height } = canvas;
  const rand = seededRandom(seed);
  const out = whiteCanvas(width, height);
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  for (let n = 0; n < 9; n++) {
    const y = Math.floor(rand() * height);
    const h = 4 + Math.floor(rand() * 36);
    const shift = Math.round((rand() - 0.5) * 120);
    ctx.drawImage(canvas, 0, y, width, h, shift, y, width, h);
  }
  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
  for (let y = 0; y < height; y += 4) ctx.fillRect(0, y, width, 1);
  return out;
}

// ---------- layout helpers ----------

// Rasters → one raster, laid out in `cols` columns with `gap` dots between.
// All rasters in a row share the top edge; output width is `width`.
export function composeGrid(rasters, { cols = 1, gap = 16, width }) {
  const rows = [];
  for (let i = 0; i < rasters.length; i += cols) rows.push(rasters.slice(i, i + cols));
  const rowHeights = rows.map((row) => Math.max(...row.map((r) => r.heightDots)));
  const height = rowHeights.reduce((a, b) => a + b, 0) + gap * (rows.length - 1);
  const out = whiteCanvas(width, height);
  const ctx = out.getContext('2d');
  let y = 0;
  rows.forEach((row, r) => {
    let x = 0;
    for (const raster of row) {
      ctx.drawImage(rasterToCanvas(raster), x, y);
      x += raster.widthDots + gap;
    }
    y += rowHeights[r] + gap;
  });
  return canvasToRaster(out, { dither: 'threshold' });
}

// ---------- frames ----------

function fitText(ctx, text, maxWidth, size, font) {
  let px = size;
  do ctx.font = `bold ${px}px ${font}`;
  while (ctx.measureText(text).width > maxWidth && --px > 10);
  return px;
}

const CRIMES = [
  'STEALING THE SHOW',
  'EXCESSIVE DANCING',
  'BEING TOO GOOD-LOOKING',
  'EATING ALL THE SNACKS',
  'UNLICENSED FUN',
  'HOGGING THE PHOTO BOOTH',
  'TERRIBLE DAD JOKES',
  'SUSPICIOUS LEVELS OF CHARM',
];
const CAPTIONS = [
  'Best party ever!',
  'Did I blink?',
  'Is this my good side?',
  "I'm kind of a big deal.",
  'Say cheese!',
  'Nailed it.',
  'Who invited me?',
  'Wait, is it printing?',
  'Living my best life',
  'Photobombed!',
];

// Instant-photo frame: margin, outline, event name and date underneath.
export function polaroid(raster, { width, eventName, date }) {
  const M = (width - raster.widthDots) / 2;
  const footer = eventName ? 128 : 90;
  const out = whiteCanvas(width, M + raster.heightDots + footer);
  const ctx = out.getContext('2d');
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, width - 3, out.height - 3);
  ctx.drawImage(rasterToCanvas(raster), M, M);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let y = M + raster.heightDots + 14;
  if (eventName) {
    fitText(ctx, eventName, width - 2 * M, 46, HAND_FONT);
    ctx.fillText(eventName, width / 2, y + 28);
    y += 56;
  }
  ctx.font = `${eventName ? 28 : 40}px ${HAND_FONT}`;
  ctx.fillText(date, width / 2, y + (eventName ? 22 : 32));
  return canvasToRaster(out, { dither: 'threshold' });
}

// Wild-west poster: WANTED, the photo, the crime and a reward.
export function wanted(raster, { width, seed }) {
  const rand = seededRandom(seed);
  const M = (width - raster.widthDots) / 2;
  const head = 128;
  const foot = 132;
  const out = whiteCanvas(width, head + raster.heightDots + foot);
  const ctx = out.getContext('2d');
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, width - 6, out.height - 6);
  ctx.lineWidth = 2;
  ctx.strokeRect(13, 13, width - 26, out.height - 26);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fitText(ctx, 'WANTED', width - 2 * M, 104, POSTER_FONT);
  ctx.fillText('WANTED', width / 2, 74);
  ctx.drawImage(rasterToCanvas(raster), M, head);
  ctx.lineWidth = 4;
  ctx.strokeRect(M - 2, head - 2, raster.widthDots + 4, raster.heightDots + 4);
  const crime = `FOR ${CRIMES[Math.floor(rand() * CRIMES.length)]}`;
  const reward = `REWARD $${((1 + Math.floor(rand() * 9)) * 1_000_000).toLocaleString('en-US')}`;
  const y = head + raster.heightDots;
  fitText(ctx, crime, width - 2 * M, 28, POSTER_FONT);
  ctx.fillText(crime, width / 2, y + 40);
  fitText(ctx, reward, width - 2 * M, 40, POSTER_FONT);
  ctx.fillText(reward, width / 2, y + 90);
  return canvasToRaster(out, { dither: 'threshold' });
}

// Comic speech bubble above the photo with a random caption.
export function bubble(raster, { width, seed }) {
  const rand = seededRandom(seed);
  const caption = CAPTIONS[Math.floor(rand() * CAPTIONS.length)];
  const head = 150;
  const out = whiteCanvas(width, head + raster.heightDots);
  const ctx = out.getContext('2d');
  ctx.drawImage(rasterToCanvas(raster), 0, head);
  // Bubble: rounded box + tail pointing down into the photo.
  const bx = 20;
  const by = 12;
  const bw = width - 40;
  const bh = 100;
  const tailX = width * (0.3 + rand() * 0.4);
  ctx.fillStyle = '#fff';
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(tailX - 22, by + bh - 10);
  ctx.lineTo(tailX + 6, head + 34);
  ctx.lineTo(tailX + 26, by + bh - 10);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 40);
  ctx.fill();
  ctx.stroke();
  ctx.fillRect(tailX - 16, by + bh - 6, 36, 12); // open the box where the tail joins
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fitText(ctx, caption, bw - 60, 44, HAND_FONT);
  ctx.fillText(caption, width / 2, by + bh / 2);
  return canvasToRaster(out, { dither: 'threshold' });
}
