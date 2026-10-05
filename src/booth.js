// Photo booth kiosk: connect printer once → live camera → timed capture of
// N shots → review (retry / print / share via QR). Config in src/config.js
// drives printer type, paper width, template, shot count and filter toggle;
// change those via /settings.html.

import qrcode from 'qrcode-generator';
import { getConfig } from './config.js';
import { DEFAULT_LOOK, PHOTO_STYLES, PHOTO_TWISTS, printPhoto, renderSticker } from './photo.js';
import { connectPrinter } from './printers/index.js';
import { rasterToCanvas } from './raster.js';
import { loadTemplate } from './templates.js';

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

let config = getConfig();
let template = null; // resolved from config.templateId

// Current session + derived data, reset on every capture.
// shots: canvases captured this session (count === config.shotCount)
// rasters: cache keyed by "style|twist", value is the composed sticker raster
let session = null;
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

// ---------- settings access ----------

// Hidden entry: long-press the Photoboot title for a second to open settings.
// Also exposed via /?admin=1 for keyboards.
(function setupSettingsHatch() {
  const title = document.querySelector('.setup-card h1');
  if (!title) return;
  let timer = null;
  const start = () => {
    timer = setTimeout(() => (location.href = '/settings.html'), 1000);
  };
  const cancel = () => clearTimeout(timer);
  title.addEventListener('pointerdown', start);
  title.addEventListener('pointerup', cancel);
  title.addEventListener('pointerleave', cancel);
  title.addEventListener('pointercancel', cancel);
})();
if (new URLSearchParams(location.search).get('admin') === '1') {
  location.href = '/settings.html';
}

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
  try {
    const p = await connectPrinter(config.printerType, {
      onLog: (msg) => (status.textContent = msg),
      onDisconnect: () => reconnectLoop(),
    });
    printer = p;
    await startBooth();
  } catch (err) {
    status.textContent =
      err.name === 'NotFoundError' ? 'No printer selected.' : `Couldn't connect: ${err.message}`;
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
  // 1280×960 is plenty for a 552-dot sticker. Without a frame rate the
  // browser only matches the size and can pick a slow mode (a Logitech
  // webcam gave 1920×1440 cropped from a 2 fps mode), so ask for 30 and
  // insist on at least 15, falling back if the camera can't do that.
  const camera = {
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
    width: { ideal: 1280 },
    height: { ideal: 960 },
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { ...camera, frameRate: { ideal: 30, min: 15 } },
    });
  } catch (err) {
    if (err.name !== 'OverconstrainedError') throw err;
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...camera, frameRate: { ideal: 30 } } });
  }
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
  template = await loadTemplate(config.templateId, config.templateConfig?.[config.templateId]);
  show('booth');
  setPill();
  updateShotCounter(0);
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
setDelay(Number(storage('delay')) || config.defaultDelay || 3);

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

function updateShotCounter(current) {
  const total = config.shotCount;
  const el = $('shot-counter');
  if (!el) return;
  if (total <= 1) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = `${current} / ${total}`;
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

// Capture one or more shots back-to-back with a countdown between each.
$('shutter').addEventListener('click', async () => {
  if (busy || !video.videoWidth) return;
  busy = true;
  setCaptureEnabled(false);
  const shots = [];
  try {
    const total = Math.max(1, config.shotCount | 0);
    for (let i = 0; i < total; i++) {
      updateShotCounter(i + 1);
      await countdown(delay);
      flash();
      shots.push(grabFrame());
      // Short beat between shots so the flash animation lands before the
      // next countdown kicks in. The final shot gets a longer pause to let
      // the review screen show up gracefully.
      await sleep(i === total - 1 ? 350 : 500);
    }
    session = { shots, rasters: {}, raster: null, look: null, shareUrl: null };
    showReview();
  } finally {
    busy = false;
    setCaptureEnabled(true);
    updateShotCounter(0);
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

// One radio row per look option (style, twist).
function renderOptions(listId, key, options) {
  $(listId).replaceChildren(
    ...options.map(({ id, label }) => {
      const btn = document.createElement('button');
      btn.className = 'filter';
      btn.setAttribute('role', 'radio');
      btn.dataset.key = key;
      btn.dataset.value = id;
      btn.textContent = label;
      btn.addEventListener('click', () => {
        if (busy || !session) return;
        selectLook({ ...session.look, [key]: id });
        armReviewTimeout();
      });
      return btn;
    })
  );
}
renderOptions('styles', 'style', PHOTO_STYLES);
renderOptions('twists', 'twist', PHOTO_TWISTS);

// Stickers are cached per look, so flipping back and forth is instant.
function selectLook(look) {
  session.look = look;
  const cacheKey = `${look.style}|${look.twist}`;
  session.raster = session.rasters[cacheKey] ??= renderSticker(session.shots, template, {
    stickerWidth: config.paperWidthDots,
    look,
  });
  for (const btn of document.querySelectorAll('.filter')) {
    btn.setAttribute('aria-checked', String(look[btn.dataset.key] === btn.dataset.value));
  }
  const preview = rasterToCanvas(session.raster);
  const sticker = $('sticker');
  sticker.width = preview.width;
  sticker.height = preview.height;
  sticker.getContext('2d').drawImage(preview, 0, 0);
  layoutSticker();
}

// Scale the preview by a whole number of device pixels per dot, as large as
// fits. Half steps are fine too: 2.5× alternates 2- and 3-pixel dots, a beat
// too fine to show as moire. Below 1:1 (tiny screens) it falls back to plain
// fit-to-box.
function layoutSticker() {
  if (!session?.raster || screens.review.hidden) return;
  const { widthDots, heightDots } = session.raster;
  const box = $('review-preview');
  const style = getComputedStyle(box);
  const availW = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const availH = box.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const dpr = window.devicePixelRatio || 1;
  const fit = Math.min((availW * dpr) / (widthDots + 2 * STICKER_MARGIN_DOTS), (availH * dpr) / heightDots);
  const scale = fit >= 1 ? Math.floor(fit * 2) / 2 : fit;
  const sticker = $('sticker');
  sticker.style.width = `${(widthDots * scale) / dpr}px`;
  sticker.style.height = `${(heightDots * scale) / dpr}px`;
  sticker.style.padding = `0 ${(STICKER_MARGIN_DOTS * scale) / dpr}px`;
}
new ResizeObserver(() => layoutSticker()).observe($('review-preview'));

async function showReview() {
  $('print').hidden = !printer;
  $('review-status').hidden = true;
  // The filter row is hidden entirely when disabled in settings — a plain
  // threshold is used instead.
  $('styles').hidden = !config.filterEnabled;
  $('twists').hidden = !config.filterEnabled;
  show('review');
  selectLook(config.filterEnabled ? DEFAULT_LOOK : { style: 'classic', twist: 'none' });
  armReviewTimeout();
}

function backToBooth() {
  clearTimeout(reviewTimer);
  $('qr-dialog').hidden = true;
  session = null;
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
      await printPhoto(printer, session.raster);
      toast('Printed!');
    } catch (err) {
      toast(`Print failed: ${err.message}`, 5000);
      reconnectLoop();
    }
  })
);

// Share uploads the first shot (or a composite if more than one), returning
// a URL for the QR code. Strip mode: stitch shots into one JPEG.
async function uploadPhoto() {
  const toUpload = await shareableCanvas();
  const blob = await new Promise((resolve) => toUpload.toBlob(resolve, 'image/jpeg', 0.9));
  const res = await fetch('/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: blob,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body.url;
}

function shareableCanvas() {
  const shots = session.shots;
  if (shots.length === 1) return shots[0];
  // Vertical photostrip of the raw colour frames.
  const refW = shots[0].width;
  const totalH = shots.reduce((sum, s) => sum + Math.round((s.height * refW) / s.width), 0);
  const canvas = document.createElement('canvas');
  canvas.width = refW;
  canvas.height = totalH;
  const ctx = canvas.getContext('2d');
  let y = 0;
  for (const shot of shots) {
    const h = Math.round((shot.height * refW) / shot.width);
    ctx.drawImage(shot, 0, y, refW, h);
    y += h;
  }
  return canvas;
}

$('share').addEventListener('click', () =>
  withBusy($('share'), async () => {
    try {
      if (!session.shareUrl) {
        toast('Preparing…', 0);
        session.shareUrl = await uploadPhoto();
      }
      const qr = qrcode(0, 'M');
      qr.addData(session.shareUrl);
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

// Dev only: /?demo=<image url> opens the review screen with that image, to
// check filters and layout without a camera.
const demo = import.meta.env.DEV && new URLSearchParams(location.search).get('demo');
if (demo) {
  const img = new Image();
  img.onload = async () => {
    template = await loadTemplate(config.templateId, config.templateConfig?.[config.templateId]);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const shots = Array.from({ length: config.shotCount }, () => canvas);
    session = { shots, rasters: {}, raster: null, look: null, shareUrl: null };
    showReview();
  };
  img.src = demo;
}
