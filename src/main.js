import { PhomemoPrinter, DEFAULT_PRINT_WIDTH_DOTS } from './printer.js';
import {
  canvasToRaster,
  fitToPrintWidth,
  testPatternCanvas,
  textToCanvas,
  widthCalibrationCanvas,
} from './raster.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const previewWrap = $('preview-wrap');
const previewCanvas = $('preview');

// User-adjustable target print width. Updated in the UI as we calibrate.
let targetWidth = DEFAULT_PRINT_WIDTH_DOTS;

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
  console.log(line);
}

if (!navigator.bluetooth) {
  $('unsupported').hidden = false;
  $('connect').disabled = true;
}

const printer = new PhomemoPrinter({ onLog: log });

function setConnectedUI(connected) {
  $('connect').disabled = connected;
  $('print-text').disabled = !connected;
  $('print-pattern').disabled = !connected;
  $('print-image').disabled = !connected;
  $('print-calibration').disabled = !connected;
  $('print-cal-narrow').disabled = !connected;
  $('disconnect').disabled = !connected;
}

function showPreview(canvas) {
  previewCanvas.width = canvas.width;
  previewCanvas.height = canvas.height;
  previewCanvas.getContext('2d').drawImage(canvas, 0, 0);
  previewWrap.hidden = false;
}

async function printCanvas(canvas, { fit = true } = {}) {
  const sized = fit && canvas.width !== targetWidth ? fitToPrintWidth(canvas, targetWidth) : canvas;
  showPreview(sized);
  const { bitmap, widthDots, heightDots } = canvasToRaster(sized);
  log(`Rasterised: ${widthDots}×${heightDots} (${bitmap.length} bytes)`);
  await printer.init();
  await printer.printRaster(bitmap, widthDots, heightDots);
  await printer.feed(80);
  log('Print job sent.');
}

$('connect').addEventListener('click', async () => {
  try {
    await printer.connect();
    setConnectedUI(true);
  } catch (err) {
    log(`ERROR: ${err.message}`);
  }
});

$('disconnect').addEventListener('click', async () => {
  await printer.disconnect();
  setConnectedUI(false);
});

$('print-text').addEventListener('click', async () => {
  try {
    const canvas = textToCanvas(
      `Hello from the photoboot!\n\n${new Date().toLocaleString()}`,
      { width: targetWidth, fontSize: 36 }
    );
    await printCanvas(canvas, { fit: false });
  } catch (err) {
    log(`ERROR: ${err.message}`);
  }
});

$('print-pattern').addEventListener('click', async () => {
  try {
    await printCanvas(testPatternCanvas(260, targetWidth), { fit: false });
  } catch (err) {
    log(`ERROR: ${err.message}`);
  }
});

$('print-calibration').addEventListener('click', async () => {
  try {
    const canvas = widthCalibrationCanvas({ maxDots: 640, step: 32 });
    log(`Calibration: 0–640 dots, ticks every 32. Report highest tick fully on sticker.`);
    await printCanvas(canvas, { fit: false });
  } catch (err) {
    log(`ERROR: ${err.message}`);
  }
});

$('print-cal-narrow').addEventListener('click', async () => {
  try {
    const canvas = widthCalibrationCanvas({ maxDots: 576, step: 16 });
    log(`Fine calibration: 0–576 dots, ticks every 16.`);
    await printCanvas(canvas, { fit: false });
  } catch (err) {
    log(`ERROR: ${err.message}`);
  }
});

$('width').addEventListener('change', (e) => {
  const w = parseInt(e.target.value, 10);
  if (!Number.isFinite(w) || w <= 0 || w % 8 !== 0) {
    log(`ERROR: width must be a positive multiple of 8.`);
    e.target.value = targetWidth;
    return;
  }
  targetWidth = w;
  log(`Target width set to ${targetWidth} dots.`);
});

$('print-image').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode();
  try {
    await printCanvas(img);
  } catch (err) {
    log(`ERROR: ${err.message}`);
  } finally {
    URL.revokeObjectURL(img.src);
    e.target.value = '';
  }
});

$('width').value = targetWidth;
log('Ready. Click "Connect printer" to begin.');
if (!navigator.bluetooth) log('Web Bluetooth is NOT available in this browser.');
