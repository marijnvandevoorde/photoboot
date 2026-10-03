// Photo booth kiosk: connect printer once → live camera → timed capture →
// review (retry / print / share via QR).

import qrcode from 'qrcode-generator';
import { photoToRaster, printPhoto } from './photo.js';
import { PhomemoPrinter } from './printer.js';
import { rasterToCanvas } from './raster.js';

const $ = (id) => document.getElementById(id);
const screens = { setup: $('setup'), booth: $('booth'), review: $('review') };
const video = $('video');

const STICKER_MARGIN_DOTS = 24; // unprintable strip each side, for the preview

const REVIEW_TIMEOUT_MS = 90_000;
const RECONNECT_INTERVAL_MS = 5_000;

let printer = null; // null = running without printer
let stream = null;
let cameras = [];
let cameraIndex = 0;
let mirrored = true;
let delay = 3;
let busy = false;

// Current photo + derived data, reset on every capture.
let photo = null; // { canvas, raster, shareUrl }
let reviewTimer = null;

// ---------- helpers ----------

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
}

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

let toastTimer = null;
function toast(msg, ms = 2500) {
  const el = $('review-status');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (el.hidden = true), ms);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fullscreen consumes the tap's user activation, which requestDevice also
// needs — so never call it from the Connect tap. Instead, go fullscreen on
// any tap once we're past setup (nothing after setup needs activation).
document.addEventListener('click', () => {
  if (screens.setup.hidden && !document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => {});
  }
});

// Keep the screen on while the booth is running.
let wakeLock = null;
async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    /* not supported / denied: fine */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLock?.released !== false) keepAwake();
});

// ---------- printer ----------

function setPill() {
  const pill = $('printer-pill');
  if (!printer) {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;
  const ok = printer.connected;
  pill.textContent = ok ? `🖨 ${printer.device.name || 'Printer'}` : '🖨 Reconnecting…';
  pill.classList.toggle('bad', !ok);
}

// After an unexpected disconnect, keep trying the same printer. There is
// deliberately no way to pick a different one once connected.
let reconnecting = false;
async function reconnectLoop() {
  if (reconnecting) return;
  reconnecting = true;
  setPill();
  while (printer && !printer.connected) {
    try {
      await printer.reconnect();
    } catch {
      await sleep(RECONNECT_INTERVAL_MS);
    }
  }
  reconnecting = false;
  setPill();
}

$('connect').addEventListener('click', async () => {
  const status = $('setup-status');
  const p = new PhomemoPrinter({
    onLog: (msg) => (status.textContent = msg),
    onDisconnect: () => reconnectLoop(),
  });
  try {
    await p.connect();
    printer = p;
    await startBooth();
  } catch (err) {
    status.textContent = err.name === 'NotFoundError' ? 'No printer selected.' : `Couldn't connect: ${err.message}`;
  }
});

$('skip-printer').addEventListener('click', () => {
  startBooth();
});

if (!navigator.bluetooth) {
  $('no-bluetooth').hidden = false;
  $('connect').disabled = true;
}

// ---------- camera ----------

async function startCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  const deviceId = cameras[cameraIndex]?.deviceId;
  const constraints = {
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
      width: { ideal: 1920 },
      height: { ideal: 1440 },
    },
  };
  stream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = stream;
  await video.play().catch(() => {});

  // Mirror the front camera (and desktop webcams that don't say), so the
  // preview behaves like a mirror. Rear cameras are shown as-is.
  const facing = stream.getVideoTracks()[0]?.getSettings().facingMode;
  mirrored = facing !== 'environment';
  video.classList.toggle('unmirrored', !mirrored);

  // Device labels/ids are only available after permission is granted.
  if (!cameras.length) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    cameras = devices.filter((d) => d.kind === 'videoinput');
    const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
    cameraIndex = Math.max(0, cameras.findIndex((c) => c.deviceId === current));
  }
  $('switch-camera').hidden = cameras.length < 2;
}

$('switch-camera').addEventListener('click', async () => {
  if (busy) return;
  cameraIndex = (cameraIndex + 1) % cameras.length;
  await startCamera().catch((err) => console.error(err));
});

async function startBooth() {
  show('booth');
  setPill();
  keepAwake();
  try {
    await startCamera();
  } catch (err) {
    alert(`Camera unavailable: ${err.message}`);
  }
}

// ---------- capture ----------

function setDelay(value) {
  delay = value;
  storage('delay', String(value));
  for (const btn of document.querySelectorAll('.delay')) {
    btn.setAttribute('aria-checked', String(Number(btn.dataset.delay) === value));
  }
}
for (const btn of document.querySelectorAll('.delay')) {
  btn.addEventListener('click', () => setDelay(Number(btn.dataset.delay)));
}
setDelay(Number(storage('delay')) || 3);

function setCaptureEnabled(enabled) {
  for (const btn of document.querySelectorAll('#capture-bar button, #switch-camera')) btn.disabled = !enabled;
}

async function countdown(seconds) {
  const el = $('countdown');
  el.hidden = false;
  for (let s = seconds; s > 0; s--) {
    el.textContent = s;
    await sleep(1000);
  }
  el.hidden = true;
}

function grabFrame() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // Save the photo exactly as the preview showed it.
  if (mirrored) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, w, h);
  return canvas;
}

function flash() {
  const el = $('flash');
  el.classList.remove('on');
  void el.offsetWidth; // restart animation
  el.classList.add('on');
}

$('shutter').addEventListener('click', async () => {
  if (busy || !video.videoWidth) return;
  busy = true;
  setCaptureEnabled(false);
  try {
    await countdown(delay);
    flash();
    const canvas = grabFrame();
    const raster = photoToRaster(canvas);
    photo = { canvas, raster, shareUrl: null };
    await sleep(350); // let the flash land before switching screens
    showReview();
  } finally {
    busy = false;
    setCaptureEnabled(true);
  }
});

// ---------- review ----------

function armReviewTimeout() {
  clearTimeout(reviewTimer);
  reviewTimer = setTimeout(() => {
    if (!busy) backToBooth();
    else armReviewTimeout();
  }, REVIEW_TIMEOUT_MS);
}

function showReview() {
  $('photo').src = photo.canvas.toDataURL('image/jpeg', 0.85);
  const preview = rasterToCanvas(photo.raster);
  const sticker = $('sticker');
  sticker.width = preview.width;
  sticker.height = preview.height;
  sticker.getContext('2d').drawImage(preview, 0, 0);
  // 1 dot = 1 device pixel (close to real size on a ~264 ppi tablet).
  const dpr = window.devicePixelRatio || 1;
  sticker.style.width = `${preview.width / dpr}px`;
  sticker.style.height = `${preview.height / dpr}px`;
  sticker.style.padding = `0 ${STICKER_MARGIN_DOTS / dpr}px`;
  $('print').hidden = !printer;
  $('review-status').hidden = true;
  show('review');
  armReviewTimeout();
}

function backToBooth() {
  clearTimeout(reviewTimer);
  $('qr-dialog').hidden = true;
  photo = null;
  show('booth');
  setPill();
}

$('retry').addEventListener('click', () => {
  if (!busy) backToBooth();
});

async function withBusy(button, fn) {
  if (busy) return;
  busy = true;
  button.disabled = true;
  armReviewTimeout();
  try {
    await fn();
  } finally {
    busy = false;
    button.disabled = false;
  }
}

$('print').addEventListener('click', () =>
  withBusy($('print'), async () => {
    try {
      if (!printer.connected) {
        toast('Reconnecting printer…', 0);
        await printer.reconnect();
        setPill();
      }
      toast('Printing…', 0);
      await printPhoto(printer, photo.raster);
      toast('Printed!');
    } catch (err) {
      toast(`Print failed: ${err.message}`, 5000);
      reconnectLoop();
    }
  })
);

async function uploadPhoto() {
  const blob = await new Promise((resolve) => photo.canvas.toBlob(resolve, 'image/jpeg', 0.9));
  const res = await fetch('/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: blob,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body.url;
}

$('share').addEventListener('click', () =>
  withBusy($('share'), async () => {
    try {
      if (!photo.shareUrl) {
        toast('Preparing…', 0);
        photo.shareUrl = await uploadPhoto();
      }
      const qr = qrcode(0, 'M');
      qr.addData(photo.shareUrl);
      qr.make();
      $('qr').innerHTML = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
      $('review-status').hidden = true;
      $('qr-dialog').hidden = false;
    } catch (err) {
      toast(`Sharing failed: ${err.message}`, 5000);
    }
  })
);

$('qr-close').addEventListener('click', () => {
  $('qr-dialog').hidden = true;
  armReviewTimeout();
});
