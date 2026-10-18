// "Cat printers": the GB01 / GT01 / MX05 / X6 / YT01… family sold under
// countless names (apps iPrint, Tiny Print, Fun Print). 384 dots at 203 dpi.
//
// Packets: 51 78 | cmd | 00 | len (u16 LE) | payload | crc8(payload) | FF.
// Image rows are 48 bytes, LSB-first (bit 0 is the leftmost dot). The
// printer asks to pause on the notify characteristic when its buffer fills.
// Protocol from NaitLee/Cat-Printer, rbaron/catprinter and opentlp.
//
// Variants (see models.ts): 'mx' (MX05–MX13, YT01…) adds a density command
// and wants smaller, slower writes; 'prefixed' (LY10, LP100…) puts 0x12
// before every packet.

import { checkRaster, lsbFirst, PrinterBase, sleep } from './base.ts';
import { familyNames } from './models.ts';

const ROW_BYTES = 48;
const MAX_PAUSE_MS = 10_000;

const CAT_UUIDS = [
  {
    service: '0000ae30-0000-1000-8000-00805f9b34fb',
    write: '0000ae01-0000-1000-8000-00805f9b34fb',
    notify: '0000ae02-0000-1000-8000-00805f9b34fb',
    noResponse: true,
  },
];

// CRC-8, polynomial 0x07, over the payload only.
export function crc8(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

export function catPacket(cmd: number, payload: ArrayLike<number>, header = [0x51, 0x78]): Uint8Array {
  const data = Uint8Array.from(payload);
  const out = new Uint8Array(6 + data.length + 2);
  out.set([header[0], header[1], cmd, 0, data.length & 0xff, data.length >> 8]);
  out.set(data, 6);
  out[6 + data.length] = crc8(data);
  out[7 + data.length] = 0xff;
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const LATTICE_START = [0xaa, 0x55, 0x17, 0x38, 0x44, 0x5f, 0x5f, 0x5f, 0x44, 0x38, 0x2c];
const LATTICE_END = [0xaa, 0x55, 0x17, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x17];
// Heating energy for our density 1 (light) … 4 (dark).
const ENERGY = [0, 8000, 10000, 12000, 16000];

export class CatPrinter extends PrinterBase {
  protected readonly familyId = 'cat';
  protected readonly family = 'cat printer';
  protected readonly namePrefixes = familyNames('cat');
  protected readonly channels = CAT_UUIDS;
  override chunkSize = 100;
  override chunkDelayMs = 8;
  private paused = false;
  private density = 3;

  private get variant() {
    return this.model?.variant ?? '';
  }

  private packet(cmd: number, payload: ArrayLike<number>): Uint8Array {
    const p = catPacket(cmd, payload);
    if (this.variant !== 'prefixed') return p;
    const out = new Uint8Array(p.length + 1);
    out[0] = 0x12;
    out.set(p, 1);
    return out;
  }

  private send(cmd: number, payload: ArrayLike<number>) {
    return this.write(this.packet(cmd, payload));
  }

  // 51 78 AE 01 01 00 10 … = pause, … 00 … = go on.
  protected override received(data: Uint8Array) {
    if (data[0] === 0x51 && data[1] === 0x78 && data[2] === 0xae) this.paused = data[6] === 0x10;
  }

  protected override async pace() {
    const until = Date.now() + MAX_PAUSE_MS;
    while (this.paused && Date.now() < until) await sleep(20);
  }

  protected override async ready() {
    if (this.variant === 'mx') {
      this.chunkSize = 63;
      this.chunkDelayMs = 6;
    }
  }

  override async keepAlive() {
    await this.send(0xa3, [0x00]); // get device state
  }

  async init({ density = 3 }: { density?: number } = {}) {
    this.density = Math.min(4, Math.max(1, density));
  }

  async printRaster(bitmap: Uint8Array, widthDots: number, heightDots: number) {
    const rowBytes = checkRaster(bitmap, widthDots, heightDots);
    const energy = ENERGY[this.density];
    const mx = this.variant === 'mx';
    const speed = mx ? 10 : 32;
    const job: Uint8Array[] = [];
    const add = (cmd: number, payload: ArrayLike<number>) => job.push(this.packet(cmd, payload));
    if (mx) add(0xf2, [0x01, this.density * 40]);
    add(0xa3, [0x00]);
    add(0xa4, [mx ? 0x33 : 0x32]); // quality
    if (!mx) add(0xbd, [speed]);
    add(0xaf, [energy & 0xff, energy >> 8]);
    add(0xbe, [mx ? 0x00 : 0x01]);
    add(0xa6, LATTICE_START);
    if (mx) add(0xbd, [speed]);
    const row = new Uint8Array(ROW_BYTES);
    for (let y = 0; y < heightDots; y++) {
      row.fill(0);
      row.set(bitmap.subarray(y * rowBytes, y * rowBytes + Math.min(rowBytes, ROW_BYTES)));
      add(0xa2, lsbFirst(row));
      // Some firmware forgets the speed on long prints.
      if (y % 200 === 199) add(0xbd, [speed]);
    }
    add(0xa6, LATTICE_END);
    add(0xbd, [mx ? 0x19 : 0x08]);
    add(0xa3, [0x00]);
    // One paced stream: the printer pauses it when its buffer is full.
    await this.write(concat(job));
  }

  // Blank rows: the feed command misbehaves on some MX models.
  async feed(n = 80) {
    await this.write(concat(Array.from({ length: n }, () => this.packet(0xa2, new Uint8Array(ROW_BYTES)))));
  }
}
