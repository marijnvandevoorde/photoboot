// Printer registry + factory. Add a backend by registering it here.
//
// Each entry declares how to recognise its devices (BLE name prefixes and
// service UUIDs) plus a default print width in dots. The factory can either
// take an explicit type id, or 'auto' — in which case it shows the picker
// filtered to every known family at once, and picks the backend whose
// name/UUID matches the selected device.

import type { PrinterBase, PrinterOptions } from './base.ts';
import { PHOMEMO_NAME_PREFIXES, PHOMEMO_UUIDS, PhomemoPrinter } from './phomemo.ts';
import { type BleDevice, transport } from './transport.ts';

export interface PrinterSpec {
  label: string;
  hint: string;
  defaultWidthDots: number;
  headWidthDots: number;
  namePrefixes: string[];
  uuids: { service: string; write: string }[];
  create: (opts: PrinterOptions) => PrinterBase;
}

export const PRINTERS: Record<string, PrinterSpec> = {
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

export function printerSpec(type: string): PrinterSpec | null {
  return PRINTERS[type] ?? null;
}

export function listPrinters() {
  return Object.entries(PRINTERS).map(([id, spec]) => ({ id, ...spec }));
}

// Match a BLE device to a backend. Checks name prefixes first, falling back
// to its advertised service UUIDs if the name is empty.
export function detectType(device: BleDevice): string | null {
  const name = device.name || '';
  for (const [id, spec] of Object.entries(PRINTERS)) {
    if (spec.namePrefixes.some((p) => name.startsWith(p))) return id;
  }
  return null;
}

async function pickAnyDevice(): Promise<BleDevice> {
  const ble = transport();
  if (!ble.available) throw new Error('Bluetooth is not available here.');
  const specs = Object.values(PRINTERS);
  return ble.requestDevice({
    namePrefixes: specs.flatMap((s) => s.namePrefixes),
    services: [...new Set(specs.flatMap((s) => s.uuids.map((u) => u.service)))],
  });
}

// Open a printer by type id, or 'auto' for name-based detection. Returns a
// connected PrinterBase subclass.
export async function connectPrinter(type: string, opts: PrinterOptions = {}): Promise<PrinterBase> {
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
  printer.log(`Auto-detected: ${spec.label}`);
  await printer.attach(device);
  return printer;
}

// The printer the booth used before a reload or app restart: what the kiosk
// lock remembers.
export interface SavedPrinter {
  id: string;
  name: string;
  type: string; // a type id, or 'auto'
}

export function savedPrinter(printer: PrinterBase, type: string): SavedPrinter | null {
  return printer.device ? { id: printer.device.id, name: printer.device.name, type } : null;
}

// Find a saved printer again without the picker. Resolves to a printer that
// owns the device but may not be connected yet (call `reconnect`), or null
// when the platform can't restore devices or the device is gone.
export async function restorePrinter(saved: SavedPrinter, opts: PrinterOptions = {}): Promise<PrinterBase | null> {
  const ble = opts.transport ?? transport();
  if (!ble.available) return null;
  const device = await ble.restoreDevice(saved.id);
  if (!device) return null;
  const spec = PRINTERS[saved.type] ?? PRINTERS[detectType(device) ?? ''];
  if (!spec) return null;
  const printer = spec.create(opts);
  printer.adopt(device);
  return printer;
}
