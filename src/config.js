// Photoboot runtime config. One source of truth, backed by localStorage.
// Set from the settings page, read everywhere else.

const STORAGE_KEY = 'photoboot:config';

export const DEFAULTS = {
  // Printer: 'auto' tries to recognise the device, else a known type id.
  printerType: 'auto',
  // Print width in dots. Must be a multiple of 8. 552 = Phomemo P2S booth default
  // (24-dot margins on 576-dot head); 384 = 32 mm; 288 = 24 mm paper.
  paperWidthDots: 552,
  // Thermal print density: 1 (thin) / 3 (normal) / 4 (thick).
  printDensity: 3,

  // Printing behaviour.
  autoPrint: false, // print the default look as soon as the review opens
  copies: 1, // stickers per Print tap
  maxPrintsPerSession: 3, // Print taps per photo; 0 = unlimited
  rollLengthMm: 0, // length of a fresh roll; 0 = don't track paper
  paperWarnMm: 500, // warn the host when less than this is left

  // Camera filter styles (Classic / Pop art / Woodcut / Stipple).
  filterEnabled: true,
  // Which styles / twists guests may pick (null = all), and the preselected one.
  allowedStyles: null,
  allowedTwists: null,
  defaultStyle: 'classic',
  defaultTwist: 'none',
  // Show the print look on the live camera: 'off', 'choice' (guests pick
  // Camera or a look on the camera screen) or 'always'.
  livePreview: 'choice',

  // Shots per session. 1 = single sticker, 3-4 = classic photo-strip.
  shotCount: 1,
  // Let guests pick 1–4 shots themselves (shotCount is then the default).
  guestShotChoice: false,
  // Delay between shots in strip mode (and before the first). Seconds.
  defaultDelay: 3,

  // Guest experience.
  tapAnywhere: true, // tapping the camera view starts the countdown
  sound: true, // countdown beeps + shutter click
  reviewTimeoutSec: 90, // idle review → back to the camera
  doneTimeoutSec: 20, // after a print / share → back to the camera
  attractAfterSec: 45, // idle camera → "tap to start" screen; 0 = never
  attractShowPhotos: true, // cycle recent photos on that screen
  eventName: '', // shown on the attract screen; also names local stats/photos
  language: 'en', // guest-facing wording: en / nl / fr (see i18n.js)
  texts: {}, // per-key overrides of the wording

  // Keep a colour copy of every session on this device (IndexedDB).
  keepLocalCopies: true,
  // Sent as X-Upload-Token when the server requires one (UPLOAD_TOKEN env).
  uploadToken: '',
  // Set when this booth was set up from a server event: { id, key, name }.
  serverEvent: null,

  // Active template id (see templates.js). 'plain' prints the shots alone.
  templateId: 'plain',
  // Per-template config, keyed by template id (e.g. text: { title, line1, … }).
  templateConfig: {},
  // Admin PIN gate for /settings, stored as a SHA-256 hex digest. Empty = no
  // gate. `adminPassword` is the pre-hash plaintext key, still honoured.
  adminPasswordHash: '',
  adminPassword: '',
};

let cache = null;

function read() {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cache = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function getConfig() {
  return { ...read() };
}

export function get(key) {
  return read()[key];
}

export function setConfig(updates) {
  const next = { ...read(), ...updates };
  cache = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or disabled — the in-memory cache still reflects the change.
  }
  return next;
}

export function resetConfig() {
  cache = { ...DEFAULTS };
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return cache;
}

// Keys that belong to this device, not to an event: left out of profiles,
// exports and server events.
export const DEVICE_KEYS = ['serverEvent', 'printerType'];

export function portableConfig(config = read()) {
  const out = { ...config };
  for (const key of DEVICE_KEYS) delete out[key];
  return out;
}

// Stats and local photos are grouped per event: the server event if this
// booth was set up from one, else the event name, else 'default'.
export function eventKey(config = read()) {
  if (config.serverEvent?.id) return config.serverEvent.id;
  const slug = (config.eventName || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'default';
}

// Common paper widths for Phomemo-class 300dpi printers. The booth exposes
// these as a dropdown; the exact usable width still depends on the printer
// head and sticker shape (see test.html calibration).
export const PAPER_PRESETS = [
  { dots: 552, label: '53 mm sticker (552 dots)', note: '50 mm sticker, 24-dot margins' },
  { dots: 384, label: '32 mm (384 dots)', note: 'Narrow label paper' },
  { dots: 288, label: '25 mm (288 dots)', note: 'Thin label paper' },
  { dots: 576, label: 'Full width (576 dots)', note: 'Full head width, no margins' },
];

export const DOTS_PER_MM = 11.8;
