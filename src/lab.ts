// Print lab: render one photo in many dither looks, show each as a simulated
// thermal print (see thermal-sim.ts), and print the picked ones as labelled
// strips so they can be compared on real paper by letter.

import './platform.ts';
import { recentPhotos } from './archive.ts';
import { DOTS_PER_MM, getConfig } from './config.ts';
import { $, ctx2d, errorMessage, newCanvas, option } from './dom.ts';
import type { PrinterBase } from './printers/base.ts';
import { connectPrinter } from './printers/index.ts';
import { transport } from './printers/transport.ts';
import { canvasToRaster, DITHER_MODES, fitToPrintWidth, rasterToCanvas, textToCanvas } from './raster.ts';
import { SIM_DEFAULTS, simulatePrint } from './thermal-sim.ts';
import type { ImageSource, Raster, RasterOptions } from './types.ts';

interface Variant {
  label: string;
  options: RasterOptions;
  density: number;
  custom?: boolean;
}

const config = getConfig();
const WIDTH = config.paperWidthDots;
// CSS px per printer dot at real size (CSS assumes 96 px per inch).
const CSS_PER_DOT = 96 / 25.4 / DOTS_PER_MM;

const PRESETS: Variant[] = [
  { label: 'Classic today', options: { dither: 'atkinson', noise: 16 } },
  { label: 'Atkinson, less noise', options: { dither: 'atkinson', noise: 6 } },
  { label: 'Atkinson, no noise', options: { dither: 'atkinson', noise: 0 } },
  { label: 'Atkinson, smoothed', options: { dither: 'atkinson', noise: 6, denoise: 0.6, sharpen: 0.3 } },
  { label: 'Blue noise', options: { dither: 'bluenoise' } },
  { label: 'Blue noise, smoothed', options: { dither: 'bluenoise', denoise: 0.6, sharpen: 0.3 } },
  { label: 'Blue noise, crisp', options: { dither: 'bluenoise', denoise: 0.6, sharpen: 1 } },
  { label: 'Blue noise, lighter', options: { dither: 'bluenoise', gamma: 0.5 } },
  { label: 'Floyd–Steinberg', options: { dither: 'floyd', noise: 0 } },
  { label: 'Stucki, light noise', options: { dither: 'stucki', noise: 4 } },
  { label: 'Bayer 8×8', options: { dither: 'bayer' } },
  { label: 'Fine halftone', options: { dither: 'halftone', period: 4 } },
].map((v) => ({ ...v, density: config.printDensity }));

// ---------- persisted lab state (per browser, best effort) ----------

const STORE_KEY = 'photoboot:lab';
interface Saved {
  custom: Variant[];
  picked: string[];
  density: Record<string, number>;
  spread: number;
  gain: number;
}
function load(): Saved {
  const empty: Saved = { custom: [], picked: [], density: {}, spread: SIM_DEFAULTS.spread, gain: SIM_DEFAULTS.gain };
  try {
    return { ...empty, ...JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') };
  } catch {
    return empty;
  }
}
const saved = load();
function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(saved));
  } catch {}
}

const variants = (): Variant[] => [...PRESETS, ...saved.custom];
const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `Z${i - 25}`);
const densityOf = (v: Variant, key: string) => saved.density[key] ?? v.density;
// Picks and density overrides are keyed by the look itself, so they survive
// removing a custom variant that shifts the letters.
const keyOf = (v: Variant) => JSON.stringify(v.options) + (v.custom ? `#${v.density}` : '');

function describe({ dither = 'floyd', noise = 0, sharpen = 0.6, denoise = 0, gamma = 0.6, period }: RasterOptions) {
  const parts = [dither];
  if (period) parts.push(`cell ${period}`);
  if (noise) parts.push(`noise ${noise}`);
  if (denoise) parts.push(`denoise ${denoise}`);
  parts.push(`sharpen ${sharpen}`, `γ ${gamma}`);
  return parts.join(' · ');
}

// ---------- source photo ----------

let fitted: HTMLCanvasElement | null = null;
let bandCentre = 0.4; // faces sit a bit above the middle
const rasters = new Map<string, Raster>(); // full-photo raster per look

function setSource(source: ImageSource) {
  fitted = fitToPrintWidth(source, WIDTH);
  rasters.clear();
  $('source-wrap').hidden = false;
  drawSource();
  updatePicked();
  renderAll();
}

function bandRows(height: number): [number, number] {
  const mm = Number($<HTMLSelectElement>('band').value);
  if (!mm) return [0, height];
  const rows = Math.min(height, Math.round(mm * DOTS_PER_MM));
  const top = Math.max(0, Math.min(height - rows, Math.round(bandCentre * height - rows / 2)));
  return [top, top + rows];
}

function drawSource() {
  if (!fitted) return;
  const canvas = $<HTMLCanvasElement>('source');
  canvas.width = fitted.width;
  canvas.height = fitted.height;
  const ctx = ctx2d(canvas);
  ctx.drawImage(fitted, 0, 0);
  const [top, bottom] = bandRows(fitted.height);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, canvas.width, top);
  ctx.fillRect(0, bottom, canvas.width, canvas.height - bottom);
}

$<HTMLCanvasElement>('source').addEventListener('click', (e) => {
  const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
  bandCentre = (e.clientY - rect.top) / rect.height;
  drawSource();
  renderAll();
});
$<HTMLSelectElement>('band').addEventListener('change', () => {
  drawSource();
  renderAll();
});

async function loadImage(src: string) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

$<HTMLButtonElement>('pick-file').addEventListener('click', () => $<HTMLInputElement>('file').click());
$<HTMLInputElement>('file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  setSource(await loadImage(url));
  URL.revokeObjectURL(url);
  input.value = '';
});

// Camera: the real input the booth sees, sensor noise and all.
let stream: MediaStream | null = null;
$<HTMLButtonElement>('camera').addEventListener('click', async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    const video = $<HTMLVideoElement>('video');
    video.srcObject = stream;
    await video.play();
    video.hidden = false;
    $('snap').hidden = false;
  } catch (err) {
    status(`Camera: ${errorMessage(err)}`);
  }
});
$<HTMLButtonElement>('snap').addEventListener('click', () => {
  const video = $<HTMLVideoElement>('video');
  const frame = newCanvas(video.videoWidth, video.videoHeight);
  ctx2d(frame).drawImage(video, 0, 0);
  for (const track of stream?.getTracks() ?? []) track.stop();
  video.hidden = true;
  $('snap').hidden = true;
  setSource(frame);
});

// Recent booth photos on this device (colour keepsakes).
async function showRecent() {
  const blobs = await recentPhotos(8).catch(() => []);
  if (!blobs.length) return;
  const wrap = $('recent');
  for (const blob of blobs.reverse()) {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    img.alt = 'Recent booth photo';
    img.addEventListener('click', () => setSource(img));
    wrap.append(img);
  }
  wrap.hidden = false;
}

// ---------- rendering ----------

function rasterFor(v: Variant): Raster {
  if (!fitted) throw new Error('No photo yet.');
  const key = JSON.stringify(v.options);
  let raster = rasters.get(key);
  if (!raster) {
    // Tone (contrast stretch) is computed over the whole photo, like the
    // booth does, and only then cropped to the band.
    raster = canvasToRaster(fitted, { photo: true, ...v.options });
    rasters.set(key, raster);
  }
  return raster;
}

function cropRaster({ bitmap, widthDots, heightDots }: Raster): Raster {
  const [top, bottom] = bandRows(heightDots);
  const rowBytes = widthDots / 8;
  return { bitmap: bitmap.slice(top * rowBytes, bottom * rowBytes), widthDots, heightDots: bottom - top };
}

let generation = 0;

async function renderAll() {
  const gen = ++generation;
  const grid = $('grid');
  grid.replaceChildren();
  if (!fitted) {
    grid.innerHTML = '<p class="muted">Pick a photo to start.</p>';
    return;
  }
  const list = variants();
  const cards = list.map((v, i) => card(v, i));
  grid.append(...cards.map((c) => c.el));
  for (const c of cards) {
    // Yield between cards so the page stays responsive and stale renders stop.
    await new Promise(requestAnimationFrame);
    if (gen !== generation) return;
    c.draw();
  }
}

function card(v: Variant, index: number) {
  const key = keyOf(v);
  const el = document.createElement('figure');
  el.className = 'variant';
  el.classList.toggle('picked', saved.picked.includes(key));

  const head = document.createElement('div');
  head.className = 'head';
  const badge = document.createElement('span');
  badge.className = 'letter';
  badge.textContent = letter(index);
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = v.label;
  head.append(badge, name);

  const opts = document.createElement('p');
  opts.className = 'opts';
  opts.textContent = describe(v.options);

  const controls = document.createElement('div');
  controls.className = 'controls';
  const pick = document.createElement('input');
  pick.type = 'checkbox';
  pick.checked = saved.picked.includes(key);
  pick.addEventListener('change', () => {
    saved.picked = pick.checked ? [...saved.picked, key] : saved.picked.filter((k) => k !== key);
    el.classList.toggle('picked', pick.checked);
    persist();
    updatePicked();
  });
  const pickLabel = document.createElement('label');
  pickLabel.append(pick, 'Print');

  const density = document.createElement('select');
  for (const d of [1, 3, 4]) density.append(option(d, `density ${d}`));
  density.value = String(densityOf(v, key));
  density.addEventListener('change', () => {
    saved.density[key] = Number(density.value);
    persist();
    draw();
  });
  controls.append(pickLabel, density);

  if (v.custom) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      saved.custom = saved.custom.filter((c) => c !== v);
      saved.picked = saved.picked.filter((k) => k !== key);
      persist();
      updatePicked();
      renderAll();
    });
    controls.append(remove);
  }

  const paper = document.createElement('div');
  paper.className = 'paper';
  paper.innerHTML = '<div class="pending">Rendering…</div>';
  el.append(head, opts, controls, paper);

  function draw() {
    const raster = cropRaster(rasterFor(v));
    const zoom = Number($<HTMLSelectElement>('zoom').value);
    const sim = $<HTMLSelectElement>('view').value === 'sim';
    const canvas = sim
      ? simulatePrint(raster, { density: densityOf(v, key), spread: saved.spread, gain: saved.gain })
      : rasterToCanvas(raster);
    canvas.className = sim ? 'sim' : 'dots';
    canvas.style.width = `${raster.widthDots * CSS_PER_DOT * zoom}px`;
    canvas.style.height = `${raster.heightDots * CSS_PER_DOT * zoom}px`;
    paper.replaceChildren(canvas);
  }
  return { el, draw };
}

$<HTMLSelectElement>('view').addEventListener('change', () => renderAll());
$<HTMLSelectElement>('zoom').addEventListener('change', () => renderAll());

// ---------- simulation calibration ----------

function syncSimInputs() {
  $<HTMLInputElement>('spread').value = String(saved.spread);
  $<HTMLInputElement>('gain').value = String(saved.gain);
  $('spread-out').textContent = saved.spread.toFixed(2);
  $('gain-out').textContent = saved.gain.toFixed(2);
}
let simTimer: ReturnType<typeof setTimeout> | undefined;
for (const id of ['spread', 'gain'] as const) {
  $<HTMLInputElement>(id).addEventListener('input', (e) => {
    saved[id] = Number((e.target as HTMLInputElement).value);
    syncSimInputs();
    persist();
    clearTimeout(simTimer);
    simTimer = setTimeout(renderAll, 250);
  });
}
$<HTMLButtonElement>('sim-reset').addEventListener('click', () => {
  saved.spread = SIM_DEFAULTS.spread;
  saved.gain = SIM_DEFAULTS.gain;
  syncSimInputs();
  persist();
  renderAll();
});

// ---------- custom variants ----------

for (const mode of DITHER_MODES.filter((m) => m !== 'threshold')) $('c-dither').append(option(mode, mode));
$<HTMLSelectElement>('c-dither').value = 'bluenoise';
$<HTMLSelectElement>('c-density').value = String(config.printDensity);

$<HTMLButtonElement>('c-add').addEventListener('click', () => {
  const num = (id: string) => Number($<HTMLInputElement>(id).value);
  const dither = $<HTMLSelectElement>('c-dither').value;
  const options: RasterOptions = {
    dither,
    noise: num('c-noise'),
    sharpen: num('c-sharpen'),
    denoise: num('c-denoise'),
    gamma: num('c-gamma'),
  };
  if (dither === 'halftone') options.period = num('c-period');
  saved.custom.push({ label: 'Custom', options, density: num('c-density'), custom: true });
  persist();
  renderAll().then(() => $('grid').lastElementChild?.scrollIntoView({ behavior: 'smooth' }));
});

// ---------- printing ----------

let printer: PrinterBase | null = null;

function status(msg: string) {
  $('status').textContent = msg;
}

function pickedVariants() {
  return variants()
    .map((v, i) => ({ v, letter: letter(i), key: keyOf(v) }))
    .filter(({ key }) => saved.picked.includes(key));
}

function updatePicked() {
  const picks = pickedVariants();
  $('picked').textContent = picks.length
    ? `Picked: ${picks.map((p) => p.letter).join(', ')}`
    : 'Tick “Print” on the variants you want on paper.';
  $<HTMLButtonElement>('print').disabled = !printer?.connected || !picks.length || !fitted;
}

if (!transport().available) {
  $('no-ble').hidden = false;
  $<HTMLButtonElement>('connect').disabled = true;
}

$<HTMLButtonElement>('connect').addEventListener('click', async () => {
  try {
    printer = await connectPrinter(config.printerType, {
      onLog: status,
      onDisconnect: () => {
        status('Printer disconnected.');
        updatePicked();
      },
    });
    status('Printer connected.');
  } catch (err) {
    status(`ERROR: ${errorMessage(err)}`);
  }
  updatePicked();
});

const blankRows = (rows: number): Raster => ({
  bitmap: new Uint8Array((WIDTH / 8) * rows),
  widthDots: WIDTH,
  heightDots: rows,
});

$<HTMLButtonElement>('print').addEventListener('click', async () => {
  if (!printer) return;
  const button = $<HTMLButtonElement>('print');
  button.disabled = true;
  try {
    for (const { v, letter: l, key } of pickedVariants()) {
      const density = densityOf(v, key);
      const caption = `${l} · ${v.label} · d${density}`;
      const label = canvasToRaster(textToCanvas(caption, { width: WIDTH, fontSize: 22, padding: 6 }), {
        dither: 'threshold',
      });
      const strip = cropRaster(rasterFor(v));
      status(`Printing ${caption}…`);
      await printer.init({ density });
      for (const r of [label, strip, blankRows(24)]) await printer.printRaster(r.bitmap, r.widthDots, r.heightDots);
    }
    // Clear the tear bar, like printPhoto does.
    const tail = blankRows(72);
    await printer.printRaster(tail.bitmap, tail.widthDots, tail.heightDots);
    await printer.feed(80);
    status('Done. Compare the strips and note the letters you like.');
  } catch (err) {
    status(`ERROR: ${errorMessage(err)}`);
  }
  updatePicked();
});

// ---------- start ----------

syncSimInputs();
updatePicked();
renderAll();
showRecent();
