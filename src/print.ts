// Standalone page: pick a photo and print it with the booth's photo look.

import { photoToRaster, printPhoto } from './photo.ts';
import { PhomemoPrinter } from './printer.ts';
import { rasterToCanvas } from './raster.ts';
import { $, errorMessage } from './dom.ts';
import type { Raster } from './types.ts';

let image: HTMLImageElement | null = null;
let raster: Raster | null = null;

function log(msg: string) {
  const el = $('log');
  el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

const printer = new PhomemoPrinter({ onLog: log, onDisconnect: () => updateButtons() });

function selectedWidth() {
  return Number(document.querySelector<HTMLInputElement>('input[name="width"]:checked')?.value ?? 552);
}

// The printer drops idle links (e.g. while the file picker is open), so
// Print only needs a selected printer; the click handler reconnects.
function updateButtons() {
  $<HTMLButtonElement>('connect').disabled = printer.connected;
  $<HTMLButtonElement>('print').disabled = !(printer.device && raster);
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
  const mm = (dots: number) => (dots / 11.8).toFixed(0);
  log(`Ready: ${raster.widthDots}×${raster.heightDots} dots (~${mm(raster.widthDots)}×${mm(raster.heightDots)} mm).`);
  updateButtons();
}

$<HTMLButtonElement>('connect').addEventListener('click', async () => {
  try {
    await printer.connect();
  } catch (err) {
    log(`ERROR: ${errorMessage(err)}`);
  }
  updateButtons();
});

$<HTMLButtonElement>('pick').addEventListener('click', () => $<HTMLInputElement>('file').click());
$<HTMLInputElement>('file').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const img = new Image();
  img.src = URL.createObjectURL(file);
  try {
    await img.decode();
    image = img;
    log(`Loaded ${file.name} (${img.naturalWidth}×${img.naturalHeight}).`);
    render();
  } catch (err) {
    log(`ERROR: couldn't read ${file.name}: ${errorMessage(err)}`);
  } finally {
    (e.target as HTMLInputElement).value = '';
  }
});

for (const radio of document.querySelectorAll('input[name="width"]')) {
  radio.addEventListener('change', render);
}

$<HTMLButtonElement>('print').addEventListener('click', async () => {
  $<HTMLButtonElement>('print').disabled = true;
  try {
    if (!raster) return;
    if (!printer.connected) await printer.reconnect();
    log('Printing…');
    await printPhoto(printer, raster);
    log('Printed.');
  } catch (err) {
    log(`ERROR: ${errorMessage(err)}`);
  }
  updateButtons();
});

if (!navigator.bluetooth) {
  $('unsupported').hidden = false;
  $<HTMLButtonElement>('connect').disabled = true;
}
log('Connect the printer, then choose a photo.');
