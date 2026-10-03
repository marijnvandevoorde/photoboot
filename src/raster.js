// Convert canvases / images into packed-bit monochrome rasters for the printer.

import { DEFAULT_PRINT_WIDTH_DOTS } from './printer.js';

// Fit a source image onto a canvas of exactly `targetWidth` dots wide,
// preserving aspect ratio. White background.
export function fitToPrintWidth(source, targetWidth = DEFAULT_PRINT_WIDTH_DOTS) {
  if (targetWidth % 8 !== 0) throw new Error('targetWidth must be a multiple of 8.');
  const sw = source.width || source.videoWidth || source.naturalWidth;
  const sh = source.height || source.videoHeight || source.naturalHeight;
  if (!sw || !sh) throw new Error('Source has no dimensions.');

  const scale = targetWidth / sw;
  const dw = targetWidth;
  const dh = Math.round(sh * scale);

  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, dw, dh);
  ctx.drawImage(source, 0, 0, dw, dh);
  return canvas;
}

// Floyd–Steinberg dither → packed MSB-first bitmap. 1 bit = black dot.
// Canvas width must be a multiple of 8.
export function canvasToRaster(canvas) {
  const { width, height } = canvas;
  if (width % 8 !== 0) throw new Error(`Canvas width ${width} is not a multiple of 8.`);
  const rowBytes = width / 8;

  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, width, height);

  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = 0.299 * img.data[p] + 0.587 * img.data[p + 1] + 0.114 * img.data[p + 2];
  }

  const bitmap = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = gray[i];
      const newVal = old < 128 ? 0 : 255;
      gray[i] = newVal;
      const err = old - newVal;
      if (x + 1 < width) gray[i + 1] += (err * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) gray[i + width - 1] += (err * 3) / 16;
        gray[i + width] += (err * 5) / 16;
        if (x + 1 < width) gray[i + width + 1] += (err * 1) / 16;
      }
      if (newVal === 0) {
        bitmap[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }

  return { bitmap, widthDots: width, heightDots: height };
}

// Render text as a canvas sized to `width` dots.
export function textToCanvas(text, { width = DEFAULT_PRINT_WIDTH_DOTS, fontSize = 32, padding = 16, lineHeight = 1.2 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;

  const ctx = canvas.getContext('2d');
  ctx.font = `${fontSize}px -apple-system, system-ui, sans-serif`;
  const words = text.split(/\s+/);
  const maxWidth = width - padding * 2;
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);

  const rowH = Math.round(fontSize * lineHeight);
  canvas.height = padding * 2 + rowH * lines.length;
  const ctx2 = canvas.getContext('2d');
  ctx2.fillStyle = '#fff';
  ctx2.fillRect(0, 0, canvas.width, canvas.height);
  ctx2.fillStyle = '#000';
  ctx2.font = `${fontSize}px -apple-system, system-ui, sans-serif`;
  ctx2.textBaseline = 'top';
  lines.forEach((ln, i) => ctx2.fillText(ln, padding, padding + i * rowH));
  return canvas;
}

export function testPatternCanvas(height = 240, width = DEFAULT_PRINT_WIDTH_DOTS) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, height);

  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, canvas.width - 2, height - 2);

  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(canvas.width, height);
  ctx.moveTo(canvas.width, 0);
  ctx.lineTo(0, height);
  ctx.stroke();

  const rampH = 40;
  const rampY = height - rampH - 10;
  for (let x = 0; x < canvas.width; x++) {
    const v = Math.round((x / canvas.width) * 255);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(x, rampY, 1, rampH);
  }

  ctx.fillStyle = '#000';
  for (let x = 0; x < canvas.width; x += 32) {
    ctx.fillRect(x, 10, 2, 20);
  }

  ctx.font = '28px -apple-system, system-ui, sans-serif';
  ctx.fillText(`WIDTH ${width}`, 20, 50);
  return canvas;
}

// Short calibration strip that lets us figure out the usable print width.
//
// Content, top to bottom:
//   1. One-line header saying what to look for.
//   2. A solid black bar from column 0 to `maxDots` — makes the right edge
//      of the printed area obvious. If the head is narrower than maxDots,
//      the bar simply stops wherever the head ends.
//   3. A row of numbered tick marks at every `step` dots. The numbers are
//      absolute column positions. You read back the highest number that is
//      fully visible on the sticker.
//
// Width is `maxDots` (rounded up to a multiple of 8). Height stays short
// (~1cm) so iterating is cheap in paper.
export function widthCalibrationCanvas({ maxDots = 640, step = 32 } = {}) {
  const WIDTH = Math.ceil(maxDots / 8) * 8;
  const HEADER_H = 22;
  const BAR_H = 20;
  const TICK_H = 12;
  const NUM_H = 18;
  const PAD = 6;
  const HEIGHT = HEADER_H + PAD + BAR_H + PAD + TICK_H + NUM_H + PAD;

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = '#000';

  let y = 0;

  ctx.font = 'bold 16px -apple-system, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(`WIDTH CAL · max ${maxDots} dots · step ${step}`, 2, y);
  y += HEADER_H + PAD;

  // Solid bar from column 0 to maxDots.
  ctx.fillRect(0, y, maxDots, BAR_H);
  y += BAR_H + PAD;

  // Numbered ticks every `step` dots.
  const positions = [];
  for (let p = 0; p <= maxDots; p += step) positions.push(p);

  const tickTop = y;
  for (const p of positions) {
    const x = Math.min(p, WIDTH - 2);
    ctx.fillRect(x, tickTop, 2, TICK_H);
  }
  y += TICK_H;

  ctx.font = '11px monospace';
  for (const p of positions) {
    if (p === 0) ctx.textAlign = 'left';
    else if (p >= maxDots - step / 2) ctx.textAlign = 'right';
    else ctx.textAlign = 'center';
    const x = p === 0 ? 0 : Math.min(p, WIDTH - 1);
    ctx.fillText(String(p), x, y);
  }
  ctx.textAlign = 'left';

  return canvas;
}
