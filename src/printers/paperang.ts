// Paperang P1 / P2 ("MiaoMiaoJi") over BLE.
//
// Packets: 02 | cmd | 00 | len (u16 LE) | payload | crc32 (LE) | 03, where
// the CRC-32 starts from the key 0x35769521. Image data (command 0) is raw
// MSB-first rows, at most 500 bytes of whole rows per packet.
// Protocol from Yrr0r/paperang-web and ihciah/miaomiaoji-tool.

import { checkRaster, PrinterBase } from './base.ts';
import { familyNames } from './models.ts';

const PAPERANG_UUIDS = [
  {
    service: '49535343-fe7d-4ae5-8fa9-9fafd205e455',
    write: '49535343-6daa-4d02-abf6-19569aca69fe',
  },
];

const KEY = 0x35769521;
const MAX_PAYLOAD = 500;
const CMD = { print: 0, density: 25, feed: 26 };

let table: Uint32Array | null = null;
export function crc32(bytes: Uint8Array, seed = 0): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (const b of bytes) crc = (table[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

export function paperangPacket(cmd: number, payload: ArrayLike<number>): Uint8Array {
  const data = Uint8Array.from(payload);
  const out = new Uint8Array(5 + data.length + 5);
  out.set([0x02, cmd, 0x00, data.length & 0xff, data.length >> 8]);
  out.set(data, 5);
  const crc = crc32(data, KEY);
  out.set([crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24, 0x03], 5 + data.length);
  return out;
}

// Our density 1 (light) … 4 (dark) as heat.
const HEAT = [0, 75, 85, 95, 110];

export class PaperangPrinter extends PrinterBase {
  protected readonly familyId = 'paperang';
  protected readonly family = 'Paperang';
  protected readonly namePrefixes = familyNames('paperang');
  protected readonly channels = PAPERANG_UUIDS;
  // One packet per write.
  override chunkSize = 512;

  async init({ density = 3 }: { density?: number } = {}) {
    await this.write(paperangPacket(CMD.density, [HEAT[Math.min(4, Math.max(1, density))]]));
  }

  async printRaster(bitmap: Uint8Array, widthDots: number, heightDots: number) {
    const rowBytes = checkRaster(bitmap, widthDots, heightDots);
    const rowsPerPacket = Math.max(1, Math.floor(MAX_PAYLOAD / rowBytes));
    for (let y = 0; y < heightDots; y += rowsPerPacket) {
      const rows = Math.min(rowsPerPacket, heightDots - y);
      await this.write(paperangPacket(CMD.print, bitmap.subarray(y * rowBytes, (y + rows) * rowBytes)));
    }
  }

  async feed(n = 80) {
    await this.write(paperangPacket(CMD.feed, [Math.min(255, n)]));
  }
}
