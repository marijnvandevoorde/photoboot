// Standalone page: pick a photo and print it with the booth's photo look.

import { photoToRaster, printPhoto } from './photo.js';
import { PhomemoPrinter } from './printer.js';
import { rasterToCanvas } from './raster.js';

const $ = (id) => document.getElementById(id);

let image = null;
let raster = null;

function log(msg) {
  const el = $('log');
  el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

const printer = new PhomemoPrinter({ onLog: log, onDisconnect: () => updateButtons() });

function selectedWidth() {
  return Number(document.querySelector('input[name="width"]:checked').value);
}

// The printer drops idle links (e.g. while the file picker is open), so
// Print only needs a selected printer; the click handler reconnects.
function updateButtons() {
  $('connect').disabled = printer.connected;
  $('print').disabled = !(printer.device && raster);
}

function render() {
  if (!image) return;
  raster = photoToRaster(image, selectedWidth());
  const canvas = rasterToCanvas(raster);
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${canvas.width / dpr}px`;
  canvas.style.height = `${canvas.height / dpr}px`;
  $('preview').replaceChildren(canvas);
  $('preview-wrap').hidden = false;
  const mm = (dots) => (dots / 11.8).toFixed(0);
  log(`Ready: ${raster.widthDots}×${raster.heightDots} dots (~${mm(raster.widthDots)}×${mm(raster.heightDots)} mm).`);
  updateButtons();
}

$('connect').addEventListener('click', async () => {
  try {
    await printer.connect();
  } catch (err) {
    log(`ERROR: ${err.message}`);
  }
  updateButtons();
});

$('pick').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const img = new Image();
  img.src = URL.createObjectURL(file);
  try {
    await img.decode();
    image = img;
    log(`Loaded ${file.name} (${img.naturalWidth}×${img.naturalHeight}).`);
    render();
  } catch (err) {
    log(`ERROR: couldn't read ${file.name}: ${err.message}`);
  } finally {
    e.target.value = '';
  }
});

for (const radio of document.querySelectorAll('input[name="width"]')) {
  radio.addEventListener('change', render);
}

$('print').addEventListener('click', async () => {
  $('print').disabled = true;
  try {
    if (!printer.connected) await printer.reconnect();
    log('Printing…');
    await printPhoto(printer, raster);
    log('Printed.');
  } catch (err) {
    log(`ERROR: ${err.message}`);
  }
  updateButtons();
});

if (!navigator.bluetooth) {
  $('unsupported').hidden = false;
  $('connect').disabled = true;
}
log('Connect the printer, then choose a photo.');
