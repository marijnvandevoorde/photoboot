// Printers built on the LuckPrinter SDK: LuckJingle / Luck P (D1, L1, S1),
// Crafts & Co 3128 and the Fichero pocket printer (Action), the Lidl pocket
// printer, PeriPage and Marklife P50.
//
// Standard ESC/POS raster (GS v 0, MSB-first) wrapped in vendor commands:
// wake (12 × 00), enable (10 FF …), density (10 FF 10 00 n), the image, and
// stop. The enable/stop pair depends on the firmware (see models.ts
// `variant`); with the wrong one the printer takes the data and never
// prints. Protocol from SwapnanilDhol/minixprint, ChiaraCannolee/
// thermal-pocket-printer-basic, 0xMH/fichero-printer and opentlp.

import { checkRaster, gsv0, PrinterBase, sleep } from './base.ts';
import { familyNames } from './models.ts';

const LUCK_UUIDS = [
  { service: '0000ff00-0000-1000-8000-00805f9b34fb', write: '0000ff02-0000-1000-8000-00805f9b34fb' },
  { service: '000018f0-0000-1000-8000-00805f9b34fb', write: '00002af1-0000-1000-8000-00805f9b34fb' },
  { service: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', write: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f' },
  { service: '49535343-fe7d-4ae5-8fa9-9fafd205e455', write: '49535343-8841-43f4-a8d4-ecbe34729bb3' },
];

// Enable and stop per firmware.
const DIALECTS: Record<string, { enable: number[]; stop: number[] }> = {
  lujiang: { enable: [0x10, 0xff, 0xf1, 0x03], stop: [0x10, 0xff, 0xf1, 0x45] },
  marklife: { enable: [0x10, 0xff, 0xf1, 0x02], stop: [0x10, 0xff, 0xf1, 0x45] },
  aiyin: { enable: [0x10, 0xff, 0xfe, 0x01], stop: [0x10, 0xff, 0xfe, 0x45] },
};

export class LuckPrinter extends PrinterBase {
  protected readonly familyId = 'luck';
  protected readonly family = 'LuckJingle';
  protected readonly namePrefixes = familyNames('luck');
  protected readonly channels = LUCK_UUIDS;
  override chunkSize = 128;
  override chunkDelayMs = 30;
  private density = 1; // 0 light … 2 dark

  private get dialect() {
    return DIALECTS[this.model?.variant ?? ''] ?? DIALECTS.lujiang;
  }

  override async keepAlive() {
    await this.write([0x10, 0xff, 0x40]); // status
  }

  // Our density 1 (light) … 4 (dark) → the printer's 0 … 2.
  async init({ density = 3 }: { density?: number } = {}) {
    this.density = density <= 1 ? 0 : density >= 4 ? 2 : 1;
  }

  async printRaster(bitmap: Uint8Array, widthDots: number, heightDots: number) {
    const rowBytes = checkRaster(bitmap, widthDots, heightDots);
    await this.write(new Uint8Array(12)); // wake
    await this.write(this.dialect.enable);
    await this.write([0x10, 0xff, 0x10, 0x00, this.density]);
    await sleep(100);
    for (const block of gsv0(bitmap, rowBytes, heightDots)) await this.write(block);
    await sleep(500);
    await this.write(this.dialect.stop);
  }

  async feed(n = 80) {
    await this.write([0x1b, 0x4a, Math.min(255, n)]);
  }
}
