// MXW01-style cat printers (app Fun Print / WalkPrint): MXW01, Flying
// Tiger, StickerMate, C17… 384 dots at 203 dpi.
//
// Packets: 22 21 | cmd | 00 | len (u16 LE) | payload | crc8 | FF, the same
// CRC as the older cat printers. Commands go to AE01, the image to AE03,
// replies come on AE02. A print: intensity, status check, announce the row
// count and wait for the go-ahead, send the rows (48 bytes, LSB-first, at
// least 90 of them), flush, and wait until it's printed.
// Protocol from jeremy46231/MXW01-catprinter and opentlp.

import { checkRaster, lsbFirst, PrinterBase } from './base.ts';
import { catPacket } from './cat.ts';
import { familyNames } from './models.ts';

const ROW_BYTES = 48;
const MIN_ROWS = 90;
const HEADER = [0x22, 0x21];

const MXW01_UUIDS = [
  {
    service: '0000ae30-0000-1000-8000-00805f9b34fb',
    write: '0000ae01-0000-1000-8000-00805f9b34fb',
    notify: '0000ae02-0000-1000-8000-00805f9b34fb',
    data: '0000ae03-0000-1000-8000-00805f9b34fb',
    noResponse: true,
  },
];

// Our density 1 (light) … 4 (dark) as the app's intensity levels.
const INTENSITY = [0, 0x58, 0x5a, 0x5d, 0x62];
const ERRORS: Record<number, string> = {
  1: 'out of paper',
  9: 'out of paper',
  4: 'too hot',
  8: 'battery low',
};

const packet = (cmd: number, payload: ArrayLike<number>) => catPacket(cmd, payload, HEADER);
const reply = (cmd: number) => (data: Uint8Array) => data[0] === 0x22 && data[1] === 0x21 && data[2] === cmd;

export class Mxw01Printer extends PrinterBase {
  protected readonly familyId = 'mxw01';
  protected readonly family = 'MXW01';
  protected readonly namePrefixes = familyNames('mxw01');
  protected readonly channels = MXW01_UUIDS;
  override chunkSize = 96;
  override chunkDelayMs = 10;
  private density = 3;

  override async keepAlive() {
    await this.write(packet(0xa1, [0x00])); // status; the reply is ignored
  }

  async init({ density = 3 }: { density?: number } = {}) {
    this.density = Math.min(4, Math.max(1, density));
  }

  async printRaster(bitmap: Uint8Array, widthDots: number, heightDots: number) {
    const rowBytes = checkRaster(bitmap, widthDots, heightDots);
    const rows = Math.max(MIN_ROWS, heightDots);
    const image = new Uint8Array(rows * ROW_BYTES);
    for (let y = 0; y < heightDots; y++) {
      image.set(bitmap.subarray(y * rowBytes, y * rowBytes + Math.min(rowBytes, ROW_BYTES)), y * ROW_BYTES);
    }

    await this.write(packet(0xa2, [INTENSITY[this.density]]));
    const status = await this.request(packet(0xa1, [0x00]), reply(0xa1));
    if (status.length > 19 && status[18] !== 0) {
      throw new Error(`Printer: ${ERRORS[status[19]] ?? `error ${status[19]}`}.`);
    }
    const ok = await this.request(packet(0xa9, [rows & 0xff, rows >> 8, 0x30, 0x00]), reply(0xa9));
    if (ok[6] !== 0) throw new Error('The printer refused the print.');
    await this.write(lsbFirst(image), { bulk: true });
    await this.request(packet(0xad, [0x00]), reply(0xaa), 15_000 + rows * 20);
  }

  // Blank rows are the only way to move the paper.
  async feed(n = 80) {
    await this.printRaster(new Uint8Array(ROW_BYTES * n), ROW_BYTES * 8, n);
  }
}
