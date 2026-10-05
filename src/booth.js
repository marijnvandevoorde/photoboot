// Photo booth kiosk: connect printer once → live camera → timed capture of
// N shots → review (retake / print / share via QR / done). Config in
// src/config.js drives everything guests see; change it via /settings.html.

import qrcode from 'qrcode-generator';
import { recentPhotos, savePhoto } from './archive.js';
import { getConfig } from './config.js';
import { translator } from './i18n.js';
import {
  PHOTO_STYLES,
  PHOTO_TWISTS,
  PLAIN_LOOK,
  PRINT_EXTRA_DOTS,
  photoToRaster,
  printPhoto,
  renderColour,
  renderSticker,
} from './photo.js';
import { connectPrinter } from './printers/index.js';
import { rasterToCanvas } from './raster.js';
import { deviceId, remote } from './remote.js';
import { getStats, paperLeft, record, setStatus } from './stats.js';
import { loadTemplate } from './templates.js';

const $ = (id) => document.getElementById(id);
const screens = { setup: $('setup'), booth: $('booth'), review: $('review') };
const video = $('video');

const STICKER_MARGIN_DOTS = 24; // unprintable strip each side, for the preview
const RECONNECT_INTERVAL_MS = 5_000;
const RECONNECT_ON_PRINT_MS = 8_000;
const CAMERA_RETRY_MS = 5_000;
const ATTRACT_SLIDE_MS = 4_000;

const config = getConfig();
const t = translator(config);
let template = null; // resolved from config.templateId

let printer = null; // null = running without printer
let stream = null;
let cameras = [];
let cameraIndex = 0;
let mirrored = true;
let delay = 3;
let shotCount = Math.max(1, config.shotCount | 0);
let busy = false;

// Current session, reset on every capture.
// shots: canvases captured; rasters: sticker cache keyed by "style|twist";
// prints: Print taps that succeeded; jpeg: Promise<Blob> of the colour copy.
let session = null;
let reviewTimer = null;

// ---------- helpers ----------

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  if (name === 'booth') {
    armIdle();
    startLive();
  } else {
    stopIdle();
  }
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

function withTimeout(promise, ms) {
  return Promise.race([promise, sleep(ms).then(() => Promise.reject(new Error('timed out')))]);
}

for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
document.documentElement.lang = config.language || 'en';

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

// ---------- sound ----------

let audio = null;
function tone(freq, ms, { type = 'sine', gain = 0.2 } = {}) {
  if (!config.sound) return;
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const amp = audio.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    amp.gain.setValueAtTime(gain, audio.currentTime);
    amp.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + ms / 1000);
    osc.connect(amp).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + ms / 1000);
  } catch {
    /* no audio: fine */
  }
}

function shutterSound() {
  if (!config.sound) return;
  try {
    audio ??= new AudioContext();
    const len = Math.floor(audio.sampleRate * 0.12);
    const buffer = audio.createBuffer(1, len, audio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    const src = audio.createBufferSource();
    src.buffer = buffer;
    const amp = audio.createGain();
    amp.gain.value = 0.5;
    src.connect(amp).connect(audio.destination);
    src.start();
  } catch {
    /* ignore */
  }
}

// ---------- settings access ----------

// Hidden entries: long-press the Photoboot title (setup screen) or the
// top-left corner of the camera view to open settings. Also /?admin=1.
function longPress(el, ms, action) {
  if (!el) return;
  let timer = null;
  const cancel = () => clearTimeout(timer);
  el.addEventListener('pointerdown', () => {
    cancel();
    timer = setTimeout(action, ms);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) el.addEventListener(type, cancel);
}
const openSettings = () => (location.href = '/settings.html');
longPress(document.querySelector('.setup-card h1'), 1000, openSettings);
longPress($('admin-hatch'), 2000, openSettings);
if (new URLSearchParams(location.search).get('admin') === '1') openSettings();

// ---------- printer ----------

function setPill() {
  const pill = $('printer-pill');
  if (!printer) {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;
  const ok = printer.connected;
  const paper = paperLeft(config);
  pill.textContent =
    (ok ? `🖨 ${printer.device.name || 'Printer'}` : '🖨 Reconnecting…') + (paper?.low ? ' · 📄 low' : '');
  pill.classList.toggle('bad', !ok);
  pill.classList.toggle('low', !!paper?.low);
  setStatus({ printer: printer.device?.name || 'Printer', printerConnected: ok });
  updatePrintButton();
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
  setStatus({ printer: null, printerConnected: false });
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

  const track = stream.getVideoTracks()[0];
  // Unplugged / crashed camera: show the error panel and keep retrying.
  track?.addEventListener('ended', () => cameraFailed(new Error('Camera disconnected')));

  // Mirror the front camera (and desktop webcams that don't say), so the
  // preview behaves like a mirror. Rear cameras are shown as-is.
  const facing = track?.getSettings().facingMode;
  mirrored = facing !== 'environment';
  video.classList.toggle('unmirrored', !mirrored);

  // Device labels/ids are only available after permission is granted.
  if (!cameras.length) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    cameras = devices.filter((d) => d.kind === 'videoinput');
    const current = track?.getSettings().deviceId;
    cameraIndex = Math.max(0, cameras.findIndex((c) => c.deviceId === current));
  }
  $('switch-camera').hidden = cameras.length < 2;
}

let cameraRetryTimer = null;
async function tryCamera() {
  clearTimeout(cameraRetryTimer);
  try {
    await startCamera();
    $('camera-error').hidden = true;
    setStatus({ camera: 'ok' });
  } catch (err) {
    cameraFailed(err);
  }
}

function cameraFailed(err) {
  console.error(err);
  $('camera-error').hidden = false;
  setStatus({ camera: 'error', lastError: `Camera: ${err.message}` });
  clearTimeout(cameraRetryTimer);
  // Permission denials won't fix themselves; anything else might.
  if (err.name !== 'NotAllowedError') cameraRetryTimer = setTimeout(tryCamera, CAMERA_RETRY_MS);
}

$('camera-retry').addEventListener('click', (e) => {
  e.stopPropagation();
  tryCamera();
});

$('switch-camera').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (busy) return;
  cameraIndex = (cameraIndex + 1) % cameras.length;
  await tryCamera();
});

async function startBooth() {
  template = await loadTemplate(config.templateId, config.templateConfig?.[config.templateId]);
  setupLiveLooks();
  show('booth');
  setPill();
  updateShotCounter(0);
  keepAwake();
  await tryCamera();
}

// ---------- capture options ----------

function setChips(selector, attr, value) {
  for (const btn of document.querySelectorAll(selector)) {
    btn.setAttribute('aria-checked', String(Number(btn.dataset[attr]) === value));
  }
}

function setDelay(value) {
  delay = value;
  storage('delay', String(value));
  setChips('.delay', 'delay', value);
}
for (const btn of document.querySelectorAll('.delay')) {
  btn.addEventListener('click', () => setDelay(Number(btn.dataset.delay)));
}
setDelay(Number(storage('delay')) || config.defaultDelay || 3);

function setShotCount(value) {
  shotCount = value;
  setChips('.shots', 'shots', value);
}
$('shot-choice').hidden = !config.guestShotChoice;
for (const btn of document.querySelectorAll('.shots')) {
  btn.addEventListener('click', () => setShotCount(Number(btn.dataset.shots)));
}
setShotCount(shotCount);

function setCaptureEnabled(enabled) {
  for (const btn of document.querySelectorAll('#capture-bar button, #switch-camera')) btn.disabled = !enabled;
}

// ---------- idle attract screen ----------

let idleTimer = null;
let slideTimer = null;
let slideUrl = null;

function armIdle() {
  clearTimeout(idleTimer);
  if (config.attractAfterSec > 0) idleTimer = setTimeout(showAttract, config.attractAfterSec * 1000);
}

function stopIdle() {
  clearTimeout(idleTimer);
  hideAttract();
}

async function showAttract() {
  if (busy || screens.booth.hidden) return armIdle();
  $('attract-event').textContent = config.eventName || '';
  $('attract').hidden = false;
  setShotCount(Math.max(1, config.shotCount | 0)); // next guest starts from the default
  setupLiveLooks();
  if (!config.attractShowPhotos || !config.keepLocalCopies) return;
  const photos = await recentPhotos(12).catch(() => []);
  if (!photos.length || $('attract').hidden) return;
  let i = 0;
  const next = () => {
    if (slideUrl) URL.revokeObjectURL(slideUrl);
    slideUrl = URL.createObjectURL(photos[i++ % photos.length]);
    $('attract-photo').src = slideUrl;
    $('attract-photo').hidden = false;
  };
  next();
  slideTimer = setInterval(next, ATTRACT_SLIDE_MS);
}

function hideAttract() {
  $('attract').hidden = true;
  clearInterval(slideTimer);
  $('attract-photo').hidden = true;
  if (slideUrl) URL.revokeObjectURL(slideUrl);
  slideUrl = null;
}

// Dismiss on click (not pointerdown) so the same tap doesn't also land on
// the camera view underneath and start a countdown.
$('attract').addEventListener('click', (e) => {
  e.stopPropagation();
  hideAttract();
  armIdle();
  startLive();
});
for (const type of ['pointerdown', 'keydown']) {
  document.addEventListener(type, () => {
    if (!screens.booth.hidden && $('attract').hidden) armIdle();
  });
}

// ---------- live print look ----------

// On the camera screen guests can pick a look and see the feed as it will
// print (config.livePreview). 'camera' = the plain feed. The pick carries
// over to the review.
const LIVE_FRAME_MS = 66; // ~15 fps at most; slower machines just skip frames
let live = { style: 'camera', twist: 'none' };
let liveRunning = false;
const liveCanvas = $('live');
const frameCanvas = document.createElement('canvas');

function setupLiveLooks() {
  const mode = config.livePreview;
  if (mode === 'off') return;
  const { styles, twists, look } = looks();
  const styleOptions = [
    ...(mode === 'choice' ? [{ id: 'camera', label: `📷 ${t('camera')}` }] : []),
    ...(styles.length ? styles : [{ id: PLAIN_LOOK.style, label: t('printLook') }]),
  ];
  live = { style: mode === 'always' ? look.style : 'camera', twist: look.twist };
  const row = (id, key, options) => {
    $(id).hidden = options.length < 2;
    $(id).replaceChildren(
      ...options.map((o) => {
        const btn = document.createElement('button');
        btn.className = 'filter';
        btn.setAttribute('role', 'radio');
        btn.dataset.key = key;
        btn.dataset.value = o.id;
        btn.textContent = o.label;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          live = { ...live, [key]: o.id };
          markLive();
          startLive();
        });
        return btn;
      })
    );
  };
  row('live-styles', 'style', styleOptions);
  row('live-twists', 'twist', twists);
  $('live-looks').hidden = styleOptions.length < 2 && twists.length < 2;
  markLive();
}

function markLive() {
  for (const btn of document.querySelectorAll('#live-looks .filter')) {
    btn.setAttribute('aria-checked', String(live[btn.dataset.key] === btn.dataset.value));
  }
}

// The look the next capture starts with, or null to use the default.
function captureLook() {
  if (config.livePreview === 'off') return null;
  const { look } = looks();
  return { style: live.style === 'camera' ? look.style : live.style, twist: live.twist };
}

const liveNeeded = () =>
  config.livePreview !== 'off' &&
  !screens.booth.hidden &&
  $('attract').hidden &&
  (live.style !== 'camera' || live.twist !== 'none');

async function startLive() {
  if (liveRunning) return;
  liveRunning = true;
  try {
    while (liveNeeded()) {
      const started = performance.now();
      if (video.videoWidth) renderLiveFrame();
      await sleep(Math.max(15, LIVE_FRAME_MS - (performance.now() - started)));
    }
  } catch (err) {
    console.error('Live preview failed', err);
  } finally {
    liveRunning = false;
    liveCanvas.hidden = true;
  }
}

function renderLiveFrame() {
  const width = template?.photoWidth(config.paperWidthDots) ?? config.paperWidthDots;
  const height = Math.round((video.videoHeight * width) / video.videoWidth);
  if (frameCanvas.width !== width || frameCanvas.height !== height) {
    frameCanvas.width = width;
    frameCanvas.height = height;
  }
  const ctx = frameCanvas.getContext('2d', { willReadFrequently: true });
  ctx.save();
  if (mirrored) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, width, height);
  ctx.restore();

  let out;
  if (live.style === 'camera') {
    const twist = PHOTO_TWISTS.find((tw) => tw.id === live.twist);
    out = twist?.apply ? twist.apply(frameCanvas) : frameCanvas;
  } else {
    out = rasterToCanvas(photoToRaster(frameCanvas, width, live));
  }
  if (liveCanvas.width !== out.width || liveCanvas.height !== out.height) {
    liveCanvas.width = out.width;
    liveCanvas.height = out.height;
  }
  liveCanvas.getContext('2d').drawImage(out, 0, 0);
  liveCanvas.classList.toggle('dots', live.style !== 'camera');
  liveCanvas.hidden = false;
}

// ---------- capture ----------

let cancelled = false;
const CANCEL = Symbol('cancel');

// Sleep that ends early (by throwing) when the guest taps Cancel.
async function wait(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cancelled) throw CANCEL;
    await sleep(Math.min(100, end - Date.now()));
  }
  if (cancelled) throw CANCEL;
}

async function countdown(seconds) {
  const el = $('countdown');
  el.hidden = false;
  for (let s = seconds; s > 0; s--) {
    $('countdown-number').textContent = s;
    $('countdown-caption').textContent = s === 1 ? t('smile') : t('getReady');
    tone(s === 1 ? 880 : 660, 150);
    await wait(1000);
  }
  el.hidden = true;
}

async function betweenShots(next, total) {
  const el = $('countdown');
  el.hidden = false;
  $('countdown-number').textContent = '';
  $('countdown-caption').textContent = t('nextPose');
  updateShotCounter(next, total);
  await wait(1200);
}

function updateShotCounter(current, total = shotCount) {
  const el = $('shot-counter');
  if (total <= 1 || !current) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = t('photoOf', { n: current, total });
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

$('cancel-countdown').addEventListener('click', (e) => {
  e.stopPropagation();
  cancelled = true;
});

// Capture one or more shots back-to-back with a countdown between each.
async function capture() {
  if (busy || !video.videoWidth || !$('camera-error').hidden) return;
  busy = true;
  cancelled = false;
  hideAttract();
  setCaptureEnabled(false);
  const shots = [];
  const total = shotCount;
  try {
    for (let i = 0; i < total; i++) {
      if (i > 0) await betweenShots(i + 1, total);
      updateShotCounter(i + 1, total);
      await countdown(delay);
      flash();
      shutterSound();
      shots.push(grabFrame());
      // Let the flash land before the next step.
      await sleep(i === total - 1 ? 350 : 300);
    }
  } catch (err) {
    if (err !== CANCEL) throw err;
  } finally {
    $('countdown').hidden = true;
    busy = false;
    setCaptureEnabled(true);
    updateShotCounter(0);
  }
  // Only once `busy` is cleared: the review (and auto-print) check it.
  if (shots.length === total) startSession(shots);
  else armIdle();
}

$('shutter').addEventListener('click', (e) => {
  e.stopPropagation();
  capture();
});

// Tap anywhere on the camera view (not on its buttons) to start.
$('stage').addEventListener('click', (e) => {
  if (!config.tapAnywhere) return;
  if (e.target === video || e.target === liveCanvas || e.target === $('stage')) capture();
});

// ---------- session ----------

function startSession(shots) {
  session = { shots, rasters: {}, raster: null, look: null, shareUrl: null, shareTwist: null, prints: 0, jpegs: {} };
  record('session');
  syncStats();
  showReview();
}

// The colour keepsake (shared + archived) for the session's current twist:
// the sticker layout in colour. Cached per twist.
function colourJpeg(s = session) {
  const twist = s.look?.twist ?? 'none';
  return (s.jpegs[twist] ??= jpegOf(renderColour(s.shots, template, { stickerWidth: config.paperWidthDots, look: s.look })));
}

// Archive when the guest leaves the review, so the copy has their final twist.
function archiveSession(s) {
  if (!config.keepLocalCopies || !s) return;
  colourJpeg(s)
    .then((blob) => savePhoto(blob))
    .catch((err) => console.error('Local copy failed', err));
}

function jpegOf(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('JPEG encode failed'))), 'image/jpeg', 0.9)
  );
}

// Server stats are pushed a few seconds after activity, so a burst of
// prints becomes one request.
let syncTimer = null;
function syncStats() {
  const ev = config.serverEvent;
  if (!ev?.id) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    remote.pushStats(ev.id, ev.key, deviceId(), getStats()).catch((err) => console.warn('Stats sync failed', err));
  }, 5000);
}

// ---------- review ----------

function armReviewTimeout(seconds = config.reviewTimeoutSec || 90) {
  clearTimeout(reviewTimer);
  reviewTimer = setTimeout(() => {
    if (!busy) backToBooth();
    else armReviewTimeout(seconds);
  }, seconds * 1000);
}

// Styles / twists guests may pick, and the preselected look.
function looks() {
  if (!config.filterEnabled) return { styles: [], twists: [], look: PLAIN_LOOK };
  const pick = (all, allowed) => {
    const list = all.filter((o) => !Array.isArray(allowed) || allowed.includes(o.id));
    return list.length ? list : all.slice(0, 1);
  };
  const styles = pick(PHOTO_STYLES, config.allowedStyles);
  const twists = pick(PHOTO_TWISTS, config.allowedTwists);
  const look = {
    style: (styles.find((s) => s.id === config.defaultStyle) ?? styles[0]).id,
    twist: (twists.find((tw) => tw.id === config.defaultTwist) ?? twists[0]).id,
  };
  return { styles, twists, look };
}

// One radio row per look option (style, twist).
function renderOptions(listId, key, options) {
  $(listId).hidden = options.length < 2;
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

// Stickers are cached per look, so flipping back and forth is instant.
function selectLook(look) {
  session.look = look;
  const cacheKey = `${look.style}|${look.twist}`;
  session.raster = session.rasters[cacheKey] ??= renderSticker(session.shots, template, {
    stickerWidth: config.paperWidthDots,
    look,
  });
  for (const btn of document.querySelectorAll('#review .filter')) {
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

const printLimitReached = () =>
  config.maxPrintsPerSession > 0 && (session?.prints ?? 0) >= config.maxPrintsPerSession;

function updatePrintButton() {
  const btn = $('print');
  const note = $('print-note');
  if (!printer || !session) return;
  btn.textContent = session.prints > 0 ? t('printAgain') : t('print');
  btn.disabled = busy || printLimitReached();
  if (printLimitReached()) {
    note.textContent = t('printLimit');
    note.hidden = false;
  } else if (!printer.connected) {
    note.textContent = t('printerOffline');
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

function showReview() {
  $('print').hidden = !printer;
  $('review-status').hidden = true;
  $('print-note').hidden = true;
  const { styles, twists, look } = looks();
  renderOptions('styles', 'style', styles);
  renderOptions('twists', 'twist', twists);
  show('review');
  selectLook(captureLook() ?? look);
  updatePrintButton();
  armReviewTimeout();
  if (config.autoPrint && printer) doPrint();
}

function backToBooth() {
  clearTimeout(reviewTimer);
  $('qr-dialog').hidden = true;
  $('print-overlay').hidden = true;
  archiveSession(session);
  session = null;
  show('booth');
  setPill();
}

$('retry').addEventListener('click', () => {
  if (!busy) backToBooth();
});
$('done').addEventListener('click', () => {
  if (!busy) backToBooth();
});

function setActionsEnabled(enabled) {
  for (const btn of document.querySelectorAll('.actions button')) btn.disabled = !enabled;
  if (enabled) updatePrintButton();
}

function printOverlay(title, sub = '', spinning = true) {
  $('print-title').textContent = title;
  $('print-sub').textContent = sub;
  $('print-spinner').hidden = !spinning;
  $('print-overlay').hidden = false;
}

async function doPrint() {
  if (busy || !printer || !session || printLimitReached()) return;
  busy = true;
  setActionsEnabled(false);
  clearTimeout(reviewTimer);
  const raster = session.raster;
  const copies = Math.max(1, config.copies | 0);
  try {
    printOverlay(t('printing'), t('grabSticker'));
    if (!printer.connected) {
      await withTimeout(printer.reconnect(), RECONNECT_ON_PRINT_MS);
      setPill();
    }
    await printPhoto(printer, raster, { copies });
    session.prints++;
    record('print', { heightDots: raster.heightDots + PRINT_EXTRA_DOTS, copies });
    syncStats();
    printOverlay(t('printed'), t('grabSticker'), false);
    await sleep(1800);
    $('print-overlay').hidden = true;
    armReviewTimeout(config.doneTimeoutSec || 20);
  } catch (err) {
    console.error(err);
    record('printFail');
    setStatus({ lastError: `Print: ${err.message}` });
    $('print-overlay').hidden = true;
    toast(printer.connected ? t('printFailed') : t('printerOffline'), 6000);
    armReviewTimeout();
    reconnectLoop();
  } finally {
    busy = false;
    setActionsEnabled(true);
    setPill();
  }
}

$('print').addEventListener('click', () => doPrint());

// Share uploads the colour copy and shows a QR to the photo's page.
async function uploadPhoto() {
  const headers = { 'Content-Type': 'image/jpeg' };
  if (config.serverEvent?.id) {
    headers['X-Event-Id'] = config.serverEvent.id;
    headers['X-Event-Key'] = config.serverEvent.key;
  }
  if (config.uploadToken) headers['X-Upload-Token'] = config.uploadToken;
  const res = await fetch('/api/share', { method: 'POST', headers, body: await colourJpeg() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body.url;
}

$('share').addEventListener('click', async () => {
  if (busy || !session) return;
  busy = true;
  setActionsEnabled(false);
  clearTimeout(reviewTimer);
  try {
    // A new twist since the last share is a different photo: upload again.
    if (!session.shareUrl || session.shareTwist !== session.look.twist) {
      toast(t('preparing'), 0);
      const first = !session.shareUrl;
      session.shareUrl = await uploadPhoto();
      session.shareTwist = session.look.twist;
      if (first) record('share');
      syncStats();
    }
    const qr = qrcode(0, 'M');
    qr.addData(session.shareUrl);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
    $('review-status').hidden = true;
    $('qr-dialog').hidden = false;
    // Long enough to find the camera app; resets on Done.
    armReviewTimeout(Math.max(config.doneTimeoutSec || 20, 45));
  } catch (err) {
    console.error(err);
    setStatus({ lastError: `Share: ${err.message}` });
    toast(t('shareFailed'), 5000);
    armReviewTimeout();
  } finally {
    busy = false;
    setActionsEnabled(true);
  }
});

$('qr-close').addEventListener('click', () => {
  $('qr-dialog').hidden = true;
  armReviewTimeout(config.doneTimeoutSec || 20);
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
    startSession(Array.from({ length: shotCount }, () => canvas));
  };
  img.src = demo;
}
