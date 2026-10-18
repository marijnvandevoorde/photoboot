// Phomemo P2S / M02-family BLE printer client. ESC/POS-flavoured byte stream
// over a single GATT write characteristic. Width is parameterised because it
// varies by model (M02 Pro: 384 dots at 203dpi; P2S: 576 dots at 300dpi).

import { checkRaster, gsv0, PrinterBase } from './base.ts';
import { familyNames } from './models.ts';

// All Phomemos use one of these three service/characteristic pairs. We try
// each in order on connect.
export const PHOMEMO_UUIDS = [
  {
    service: '0000ff00-0000-1000-8000-00805f9b34fb',
    write: '0000ff02-0000-1000-8000-00805f9b34fb',
  },
  {
    service: '0000ae30-0000-1000-8000-00805f9b34fb',
    write: '0000ae01-0000-1000-8000-00805f9b34fb',
  },
  {
    service: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    write: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
  },
];

export const PHOMEMO_NAME_PREFIXES = familyNames('phomemo');

export class PhomemoPrinter extends PrinterBase {
  protected readonly familyId = 'phomemo';
  protected readonly family = 'Phomemo';
  protected readonly namePrefixes = PHOMEMO_NAME_PREFIXES;
  protected readonly channels = PHOMEMO_UUIDS;
  override headWidthDots = 576;

  // 1F 11 08 asks for the battery level: Phomemo's own app and the
  // phomemo-tools driver send it with every print, so it's known to be safe
  // (see the warning on init). We don't read the answer.
  override async keepAlive(): Promise<void> {
    await this.write(new Uint8Array([0x1f, 0x11, 0x08]));
  }

  // Label printers (M110, M220…: variant 'label') set speed, density and
  // the media (labels with gaps), and move on to the next label after each
  // image. Commands from vivier/phomemo-tools' M110 driver.
  private get labels() {
    return this.model?.variant === 'label';
  }

  // density: 1 = thin, 3 = normal, 4 = thick. Don't probe other 1F 11 xx
  // opcodes — unknown ones have bricked M02-family printers.
  async init({ density = 3 }: { density?: number } = {}): Promise<void> {
    if (this.labels) {
      const level = density <= 1 ? 0x06 : density >= 4 ? 0x0e : 0x0a;
      await this.write(new Uint8Array([0x1b, 0x4e, 0x0d, 0x05, 0x1b, 0x4e, 0x04, level, 0x1f, 0x11, 0x0a]));
      return;
    }
    await this.write(new Uint8Array([0x1b, 0x40, 0x1f, 0x11, 0x02, density]));
  }

  async feed(n = 80): Promise<void> {
    await this.write(new Uint8Array([0x1b, 0x4a, Math.min(255, n)]));
  }

  async printRaster(bitmap: Uint8Array, widthDots: number, heightDots: number): Promise<void> {
    const rowBytes = checkRaster(bitmap, widthDots, heightDots);
    for (const block of gsv0(bitmap, rowBytes, heightDots, 128)) await this.write(block);
    if (this.labels) await this.write(new Uint8Array([0x1f, 0xf0, 0x05, 0x00, 0x1f, 0xf0, 0x03, 0x00]));
  }
}
