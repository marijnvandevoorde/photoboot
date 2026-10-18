// Printer registry + factory. Add a backend by registering it here, and its
// models in models.ts.
//
// Each driver ("family") speaks one protocol. Families share Bluetooth
// service UUIDs, so a device is matched to its family by its name (see
// models.ts). The factory takes a family id, a model the host picked, or
// 'auto': then the picker lists every known printer and the name decides.

import type { PrinterBase, PrinterOptions } from './base.ts';
import { CatPrinter } from './cat.ts';
import { EscPosPrinter } from './escpos.ts';
import { LuckPrinter } from './luck.ts';
import { familyNames, MODELS, modelById, modelForName } from './models.ts';
import { Mxw01Printer } from './mxw01.ts';
import { NiimbotPrinter } from './niimbot.ts';
import { PaperangPrinter } from './paperang.ts';
import { PhomemoPrinter } from './phomemo.ts';
import { type BleDevice, transport } from './transport.ts';

export interface PrinterSpec {
  label: string;
  hint: string;
  // Every service the family may use: browsers only allow these.
  services: string[];
  create: (opts: PrinterOptions) => PrinterBase;
}

const uuid = (short: string) => `0000${short}-0000-1000-8000-00805f9b34fb`;
const NIIMBOT_SERVICE = 'e7810a71-73ae-499d-8c15-faa9aef0c3f2';
const ISSC_SERVICE = '49535343-fe7d-4ae5-8fa9-9fafd205e455';

export const PRINTERS: Record<string, PrinterSpec> = {
  phomemo: {
    label: 'Phomemo',
    hint: 'P2 / P2S, M02 family, T02, M110 / M220 label printers.',
    services: [uuid('ff00'), uuid('ae30'), NIIMBOT_SERVICE],
    create: (opts) => new PhomemoPrinter(opts),
  },
  cat: {
    label: 'Cat printers (iPrint, Tiny Print)',
    hint: 'GB01–GB05, GT01, X5–X8, MX05–MX13, YT01 and their clones.',
    services: [uuid('ae30')],
    create: (opts) => new CatPrinter(opts),
  },
  mxw01: {
    label: 'MXW01 (Fun Print)',
    hint: 'MXW01, Flying Tiger, StickerMate, C17 and their clones.',
    services: [uuid('ae30')],
    create: (opts) => new Mxw01Printer(opts),
  },
  luck: {
    label: 'LuckJingle / Fichero / PeriPage',
    hint: 'LuckJingle D1 / L1, Crafts & Co and Fichero (Action), Lidl, PeriPage, Marklife P50.',
    services: [uuid('ff00'), uuid('18f0'), NIIMBOT_SERVICE, ISSC_SERVICE],
    create: (opts) => new LuckPrinter(opts),
  },
  paperang: {
    label: 'Paperang',
    hint: 'Paperang P1, P2.',
    services: [ISSC_SERVICE],
    create: (opts) => new PaperangPrinter(opts),
  },
  niimbot: {
    label: 'Niimbot',
    hint: 'B1, B21 label printers.',
    services: [NIIMBOT_SERVICE],
    create: (opts) => new NiimbotPrinter(opts),
  },
  escpos: {
    label: 'Receipt printers (ESC/POS)',
    hint: '58 / 80 mm Bluetooth receipt printers with BLE.',
    services: [uuid('18f0'), ISSC_SERVICE, uuid('ffe0'), uuid('ff00'), NIIMBOT_SERVICE],
    create: (opts) => new EscPosPrinter(opts),
  },
};

export function printerSpec(type: string): PrinterSpec | null {
  return PRINTERS[type] ?? null;
}

export function listPrinters() {
  return Object.entries(PRINTERS).map(([id, spec]) => ({ id, ...spec }));
}

// Match a BLE device to a family by its name.
export function detectType(device: BleDevice): string | null {
  return modelForName(device.name || '')?.family ?? null;
}

async function pickAnyDevice(): Promise<BleDevice> {
  const ble = transport();
  if (!ble.available) throw new Error('Bluetooth is not available here.');
  return ble.requestDevice({
    namePrefixes: [...new Set(MODELS.flatMap((m) => m.names))],
    services: [...new Set(Object.values(PRINTERS).flatMap((s) => s.services))],
  });
}

// Open a printer by family id, by `opts.model` (picked in settings), or
// 'auto' for name-based detection. Returns a connected PrinterBase.
export async function connectPrinter(type: string, opts: PrinterOptions = {}): Promise<PrinterBase> {
  const family = opts.model?.family ?? (type && type !== 'auto' ? type : null);
  if (family) {
    const spec = PRINTERS[family];
    if (!spec) throw new Error(`Unknown printer type: ${family}`);
    const printer = spec.create(opts);
    await printer.connect();
    return printer;
  }

  // Auto: open the picker with every known printer, then pick the right
  // driver from the selected device's name.
  const device = await pickAnyDevice();
  const detected = detectType(device);
  if (!detected) {
    throw new Error(`Can't recognise "${device.name || 'this device'}". Pick your printer in settings.`);
  }
  const spec = PRINTERS[detected];
  const printer = spec.create(opts);
  printer.log(`Auto-detected: ${spec.label}`);
  await printer.attach(device);
  return printer;
}

// Every family's names, for the pickers of family-specific pages.
export { familyNames };

// The printer the booth used before a reload or app restart: what the kiosk
// lock remembers.
export interface SavedPrinter {
  id: string;
  name: string;
  type: string; // a family id, or 'auto'
  model?: string; // the model it was used as
}

export function savedPrinter(printer: PrinterBase, type: string): SavedPrinter | null {
  if (!printer.device) return null;
  const saved: SavedPrinter = { id: printer.device.id, name: printer.device.name, type };
  if (printer.model) saved.model = printer.model.id;
  return saved;
}

// Find a saved printer again without the picker. Resolves to a printer that
// owns the device but may not be connected yet (call `reconnect`), or null
// when the platform can't restore devices or the device is gone.
export async function restorePrinter(saved: SavedPrinter, opts: PrinterOptions = {}): Promise<PrinterBase | null> {
  const ble = opts.transport ?? transport();
  if (!ble.available) return null;
  const device = await ble.restoreDevice(saved.id);
  if (!device) return null;
  const model = opts.model ?? modelById(saved.model ?? '');
  const spec = PRINTERS[model?.family ?? ''] ?? PRINTERS[saved.type] ?? PRINTERS[detectType(device) ?? ''];
  if (!spec) return null;
  const printer = spec.create({ ...opts, model });
  printer.adopt(device);
  return printer;
}
