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
  // Camera filter styles (Classic / Pop art / Woodcut / Stipple).
  filterEnabled: true,
  // Shots per session. 1 = single sticker, 3-4 = classic photo-strip.
  shotCount: 1,
  // Delay between shots in strip mode (and before the first). Seconds.
  defaultDelay: 3,
  // Active template id (see templates.js). 'plain' prints the shots alone.
  templateId: 'plain',
  // Per-template config (reserved for future built-in templates).
  templateConfig: {},
  // Admin password gate for /settings. Empty = anyone with the URL can enter.
  // Set via settings; nothing sensitive lives here, this just stops guests
  // from stumbling in.
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

// Common paper widths for Phomemo-class 300dpi printers. The booth exposes
// these as a dropdown; the exact usable width still depends on the printer
// head and sticker shape (see test.html calibration).
export const PAPER_PRESETS = [
  { dots: 552, label: '53 mm sticker (552 dots)', note: '50 mm sticker, 24-dot margins' },
  { dots: 384, label: '32 mm (384 dots)', note: 'Narrow label paper' },
  { dots: 288, label: '25 mm (288 dots)', note: 'Thin label paper' },
  { dots: 576, label: 'Full width (576 dots)', note: 'Full head width, no margins' },
];
