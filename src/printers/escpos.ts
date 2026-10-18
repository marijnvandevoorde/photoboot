// Generic ESC/POS receipt printers over BLE (Goojprt PT-210, MTP-II,
// MPT-III and the many no-name 58 / 80 mm ones). ESC @ then GS v 0 raster
// blocks, MSB-first. Many older receipt printers only do Bluetooth Classic,
// which browsers can't reach: those never show up in the picker.
// Channels from bitbank2/Thermal_Printer.

import { checkRaster, gsv0, PrinterBase } from './base.ts';
import { familyNames } from './models.ts';

const ESCPOS_UUIDS = [
  { service: '000018f0-0000-1000-8000-00805f9b34fb', write: '00002af1-0000-1000-8000-00805f9b34fb', noResponse: true },
  {
    service: '49535343-fe7d-4ae5-8fa9-9fafd205e455',
    write: '49535343-8841-43f4-a8d4-ecbe34729bb3',
    noResponse: true,
  },
  { service: '0000ffe0-0000-1000-8000-00805f9b34fb', write: '0000ffe1-0000-1000-8000-00805f9b34fb', noResponse: true },
  { service: '0000ff00-0000-1000-8000-00805f9b34fb', write: '0000ff02-0000-1000-8000-00805f9b34fb', noResponse: true },
  {
    service: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    write: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
    noResponse: true,
  },
];

export class EscPosPrinter extends PrinterBase {
  protected readonly familyId = 'escpos';
  protected readonly family = 'ESC/POS';
  protected readonly namePrefixes = familyNames('escpos');
  protected readonly channels = ESCPOS_UUIDS;
  // They're sold under any name: the picker lists every nearby device.
  override anyName = true;
  // Without pauses, cheap ones drop data and get stuck.
  override chunkSize = 128;
  override chunkDelayMs = 20;

  override async keepAlive() {
    await this.write([0x10, 0x04, 0x01]); // real-time status (DLE EOT)
  }

  // ESC/POS has no portable density command: the printer's own setting.
  async init() {
    await this.write([0x1b, 0x40]);
  }

  async printRaster(bitmap: Uint8Array, widthDots: number, heightDots: number) {
    const rowBytes = checkRaster(bitmap, widthDots, heightDots);
    for (const block of gsv0(bitmap, rowBytes, heightDots)) await this.write(block);
  }

  async feed(n = 80) {
    await this.write([0x1b, 0x4a, Math.min(255, n)]);
  }
}
