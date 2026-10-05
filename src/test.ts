import { $, ctx2d, errorMessage } from './dom.ts';
import { DEFAULT_PRINT_WIDTH_DOTS, PhomemoPrinter } from './printer.ts';
import {
  canvasToRaster,
  fitToPrintWidth,
  rasterToCanvas,
  testPatternCanvas,
  textToCanvas,
  widthCalibrationCanvas,
} from './raster.ts';

const logEl = $('log');
const previewWrap = $('preview-wrap');
const previewCanvas = $<HTMLCanvasElement>('preview');

// User-adjustable target print width. Updated in the UI as we calibrate.
let targetWidth = DEFAULT_PRINT_WIDTH_DOTS;

function log(msg: string) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
  console.log(line);
}

if (!navigator.bluetooth) {
  $('unsupported').hidden = false;
  $<HTMLButtonElement>('connect').disabled = true;
}

const printer = new PhomemoPrinter({ onLog: log });

function setConnectedUI(connected: boolean) {
  $<HTMLButtonElement>('connect').disabled = connected;
  $<HTMLButtonElement>('print-text').disabled = !connected;
  $<HTMLButtonElement>('print-pattern').disabled = !connected;
  $<HTMLButtonElement>('print-image').disabled = !connected;
  $<HTMLButtonElement>('print-calibration').disabled = !connected;
  $<HTMLButtonElement>('print-cal-narrow').disabled = !connected;
  $<HTMLButtonElement>('print-dither').disabled = !connected;
  $<HTMLButtonElement>('disconnect').disabled = !connected;
}

function showPreview(canvas: HTMLCanvasElement) {
  previewCanvas.width = canvas.width;
  previewCanvas.height = canvas.height;
  ctx2d(previewCanvas).drawImage(canvas, 0, 0);
  previewWrap.hidden = false;
}

async function printCanvas(source: HTMLCanvasElement | HTMLImageElement, { fit = true } = {}) {
  // Images always go through a canvas (an <img> already at the target width
  // used to reach canvasToRaster as-is and fail).
  const keep = source instanceof HTMLCanvasElement && !(fit && source.width !== targetWidth);
  const sized = keep ? source : fitToPrintWidth(source, targetWidth);
  showPreview(sized);
  const { bitmap, widthDots, heightDots } = canvasToRaster(sized);
  log(`Rasterised: ${widthDots}×${heightDots} (${bitmap.length} bytes)`);
  await printer.init();
  await printer.printRaster(bitmap, widthDots, heightDots);
  await printer.feed(80);
  log('Print job sent.');
}

$<HTMLButtonElement>('connect').addEventListener('click', async () => {
  try {
    await printer.connect();
    setConnectedUI(true);
  } catch (err) {
    log(`ERROR: ${errorMessage(err)}`);
  }
});

$<HTMLButtonElement>('disconnect').addEventListener('click', async () => {
  await printer.disconnect();
  setConnectedUI(false);
});

$<HTMLButtonElement>('print-text').addEventListener('click', async () => {
  try {
    const canvas = textToCanvas(`Hello from the photoboot!\n\n${new Date().toLocaleString()}`, {
      width: targetWidth,
      fontSize: 36,
    });
    await printCanvas(canvas, { fit: false });
  } catch (err) {
    log(`ERROR: ${errorMessage(err)}`);
  }
});

$<HTMLButtonElement>('print-pattern').addEventListener('click', async () => {
  try {
    await printCanvas(testPatternCanvas(260, targetWidth), { fit: false });
  } catch (err) {
    log(`ERROR: ${errorMessage(err)}`);
  }
});

$<HTMLButtonElement>('print-calibration').addEventListener('click', async () => {
  try {
    const canvas = widthCalibrationCanvas({ maxDots: 640, step: 32 });
    log(`Calibration: 0–640 dots, ticks every 32. Report highest tick fully on sticker.`);
    await printCanvas(canvas, { fit: false });
  } catch (err) {
    log(`ERROR: ${errorMessage(err)}`);
  }
});

$<HTMLButtonElement>('print-cal-narrow').addEventListener('click', async () => {
  try {
    const canvas = widthCalibrationCanvas({ maxDots: 576, step: 16 });
    log(`Fine calibration: 0–576 dots, ticks every 16.`);
    await printCanvas(canvas, { fit: false });
  } catch (err) {
    log(`ERROR: ${errorMessage(err)}`);
  }
});

$<HTMLInputElement>('width').addEventListener('change', (e) => {
  const w = parseInt((e.target as HTMLInputElement).value, 10);
  if (!Number.isFinite(w) || w <= 0 || w % 8 !== 0) {
    log(`ERROR: width must be a positive multiple of 8.`);
    (e.target as HTMLInputElement).value = String(targetWidth);
    return;
  }
  targetWidth = w;
  log(`Target width set to ${targetWidth} dots.`);
});

$<HTMLButtonElement>('print-image').addEventListener('click', () => $<HTMLInputElement>('file').click());
$<HTMLInputElement>('file').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode();
  try {
    await printCanvas(img);
  } catch (err) {
    log(`ERROR: ${errorMessage(err)}`);
  } finally {
    URL.revokeObjectURL(img.src);
    (e.target as HTMLInputElement).value = '';
  }
});

// Prints the same photo crop once per dither × density combination, each
// strip labelled, so the options can be compared on real paper.
const DITHER_VARIANTS = [
  { dither: 'atkinson', noise: 16, density: 3 }, // booth default
  { dither: 'atkinson', noise: 16, density: 4 },
  { dither: 'stucki', noise: 0, density: 3 },
  { dither: 'floyd', noise: 16, density: 3 },
];
const STRIP_ROWS = 240; // ~20 mm per strip

function photoStrip(img: HTMLImageElement) {
  const fitted = fitToPrintWidth(img, targetWidth);
  const rows = Math.min(STRIP_ROWS, fitted.height);
  const top = Math.round((fitted.height - rows) / 2);
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = rows;
  ctx2d(canvas).drawImage(fitted, 0, top, targetWidth, rows, 0, 0, targetWidth, rows);
  return canvas;
}

$<HTMLButtonElement>('print-dither').addEventListener('click', () => $<HTMLInputElement>('dither-file').click());
$<HTMLInputElement>('dither-file').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode();
  try {
    const strip = photoStrip(img);
    showPreview(strip);
    for (const { dither, noise, density } of DITHER_VARIANTS) {
      const label = `${dither.toUpperCase()}${noise ? ' + noise' : ''} · density ${density}`;
      const photoRaster = canvasToRaster(strip, { photo: true, dither, noise });
      const labelRaster = canvasToRaster(textToCanvas(label, { width: targetWidth, fontSize: 20, padding: 4 }));
      log(`Printing ${label}…`);
      await printer.init({ density });
      await printer.printRaster(labelRaster.bitmap, labelRaster.widthDots, labelRaster.heightDots);
      await printer.printRaster(photoRaster.bitmap, photoRaster.widthDots, photoRaster.heightDots);
      await printer.feed(24);
    }
    await printer.feed(80);
    log('Dither comparison sent.');
  } catch (err) {
    log(`ERROR: ${errorMessage(err)}`);
  } finally {
    URL.revokeObjectURL(img.src);
    (e.target as HTMLInputElement).value = '';
  }
});

// On-screen comparison, no paper: renders the whole photo per variant at
// one printer dot per device pixel. Density can't be simulated here.
const SCREEN_VARIANTS = [
  { dither: 'atkinson', noise: 16, label: 'Atkinson + noise (booth default)' },
  { dither: 'atkinson', noise: 0, label: 'Atkinson' },
  { dither: 'stucki', noise: 0, label: 'Stucki' },
  { dither: 'stucki', noise: 16, label: 'Stucki + noise' },
  { dither: 'floyd', noise: 16, label: 'Floyd–Steinberg + noise' },
  { dither: 'floyd', noise: 0, label: 'Floyd–Steinberg' },
];

$<HTMLButtonElement>('compare-dither').addEventListener('click', () => $<HTMLInputElement>('compare-file').click());
$<HTMLInputElement>('compare-file').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode();
  try {
    const fitted = fitToPrintWidth(img, targetWidth);
    const wrap = $('compare');
    wrap.replaceChildren();
    const dpr = window.devicePixelRatio || 1;
    for (const { dither, noise, label } of SCREEN_VARIANTS) {
      const canvas = rasterToCanvas(canvasToRaster(fitted, { photo: true, dither, noise }));
      canvas.style.width = `${canvas.width / dpr}px`;
      canvas.style.height = `${canvas.height / dpr}px`;
      const fig = document.createElement('figure');
      const caption = document.createElement('figcaption');
      caption.textContent = label;
      fig.append(canvas, caption);
      wrap.append(fig);
    }
    $('compare-wrap').hidden = false;
    $('compare-wrap').scrollIntoView({ behavior: 'smooth' });
    log(`Rendered ${SCREEN_VARIANTS.length} dithering variants at ${targetWidth} dots wide.`);
  } catch (err) {
    log(`ERROR: ${errorMessage(err)}`);
  } finally {
    URL.revokeObjectURL(img.src);
    (e.target as HTMLInputElement).value = '';
  }
});

$<HTMLInputElement>('width').value = String(targetWidth);
log('Ready. Click "Connect printer" to begin.');
if (!navigator.bluetooth) log('Web Bluetooth is NOT available in this browser.');
