// Printer registry + factory. Add a backend by registering it here.
//
// Each entry declares how to recognise its devices (BLE name prefixes and
// service UUIDs) plus a default print width in dots. The factory can either
// take an explicit type id, or 'auto' — in which case it shows the picker
// filtered to every known family at once, and picks the backend whose
// name/UUID matches the selected device.

import { PhomemoPrinter, PHOMEMO_NAME_PREFIXES, PHOMEMO_UUIDS } from './phomemo.js';

export const PRINTERS = {
  phomemo: {
    label: 'Phomemo (P2 / M02 / M03 / M04 / T02)',
    hint: 'ESC/POS over BLE. 203 dpi (M02 Pro: 384 dots) or 300 dpi (P2S: 576 dots).',
    defaultWidthDots: 552,
    headWidthDots: 576,
    namePrefixes: PHOMEMO_NAME_PREFIXES,
    uuids: PHOMEMO_UUIDS,
    create: (opts) => new PhomemoPrinter(opts),
  },
};

export function printerSpec(type) {
  return PRINTERS[type] ?? null;
}

export function listPrinters() {
  return Object.entries(PRINTERS).map(([id, spec]) => ({ id, ...spec }));
}

// Match a BLE device to a backend. Checks name prefixes first, falling back
// to its advertised service UUIDs if the name is empty.
function detectType(device) {
  const name = device.name || '';
  for (const [id, spec] of Object.entries(PRINTERS)) {
    if (spec.namePrefixes.some((p) => name.startsWith(p))) return id;
  }
  return null;
}

async function pickAnyDevice() {
  if (!navigator.bluetooth) throw new Error('Web Bluetooth not available in this browser.');
  const filters = [];
  const optionalServices = new Set();
  for (const spec of Object.values(PRINTERS)) {
    for (const prefix of spec.namePrefixes) filters.push({ namePrefix: prefix });
    for (const u of spec.uuids) optionalServices.add(u.service);
  }
  return navigator.bluetooth.requestDevice({ filters, optionalServices: [...optionalServices] });
}

// Open a printer by type id, or 'auto' for name-based detection. Returns a
// connected PrinterBase subclass.
export async function connectPrinter(type, opts = {}) {
  if (type && type !== 'auto') {
    const spec = PRINTERS[type];
    if (!spec) throw new Error(`Unknown printer type: ${type}`);
    const printer = spec.create(opts);
    await printer.connect();
    return printer;
  }

  // Auto: open the picker with every known family, then pick the right backend
  // based on the selected device's name.
  const device = await pickAnyDevice();
  const detected = detectType(device);
  if (!detected) {
    throw new Error(`Can't recognise "${device.name || 'this device'}". Pick a printer type in settings.`);
  }
  const spec = PRINTERS[detected];
  const printer = spec.create(opts);
  // Bypass the picker: we already have the device, go straight to attach.
  printer.bindDisconnect?.(device);
  printer.log(`Auto-detected: ${spec.label}`);
  await printer.attach(device);
  return printer;
}
