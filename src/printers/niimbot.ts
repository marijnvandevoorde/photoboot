// Niimbot label printers that print upright: B1, B21, B21S. 384 dots at
// 203 dpi. (The narrow D11 / D110 print sideways on 12 mm labels: not much
// use for photos, so they're left out.)
//
// Packets: 55 55 | cmd | len | data | xor(cmd, len, data) | AA AA, numbers
// big-endian. Every command but the image rows answers on the same
// characteristic (with cmd + 1, roughly), and the job is a little
// conversation: density, label type, start, page start, page size, rows,
// page end, then poll until it's printed. The B1 and B21 differ in the
// start and page-size commands (see models.ts `variant`).
// Protocol from MultiMote/niimbluelib and AndBondStyle/niimprint.

import { checkRaster, PrinterBase, sleep } from './base.ts';
import { familyNames } from './models.ts';

const NIIMBOT_UUIDS = [
  {
    service: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    write: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
    notify: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
    noResponse: true,
  },
];

const CMD = {
  connect: 0xc1,
  density: 0x21,
  labelType: 0x23,
  printStart: 0x01,
  pageStart: 0x03,
  pageSize: 0x13,
  quantity: 0x15,
  emptyRows: 0x84,
  row: 0x85,
  pageEnd: 0xe3,
  printStatus: 0xa3,
  printEnd: 0xf3,
  heartbeat: 0xdc,
};
// What each command answers with.
const REPLY: Record<number, number> = {
  [CMD.connect]: 0xc2,
  [CMD.density]: 0x31,
  [CMD.labelType]: 0x33,
  [CMD.printStart]: 0x02,
  [CMD.pageStart]: 0x04,
  [CMD.pageSize]: 0x14,
  [CMD.quantity]: 0x16,
  [CMD.pageEnd]: 0xe4,
  [CMD.printStatus]: 0xb3,
  [CMD.printEnd]: 0xf4,
};
const ERROR = 0xdb;
const PRINT_TIMEOUT_MS = 60_000;

export function niimbotPacket(cmd: number, data: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(7 + data.length);
  out.set([0x55, 0x55, cmd, data.length]);
  out.set(Uint8Array.from(data), 4);
  let check = cmd ^ data.length;
  for (let i = 0; i < data.length; i++) check ^= data[i];
  out.set([check, 0xaa, 0xaa], 4 + data.length);
  return out;
}

const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];

export class NiimbotPrinter extends PrinterBase {
  protected readonly familyId = 'niimbot';
  protected readonly family = 'Niimbot';
  protected readonly namePrefixes = familyNames('niimbot');
  protected readonly channels = NIIMBOT_UUIDS;
  private density = 3;

  private get b1() {
    return this.model?.variant === 'b1';
  }

  // Send a command and wait for its answer (or the printer's error).
  private async ask(cmd: number, data: ArrayLike<number> = [1], ms = 2_000): Promise<Uint8Array> {
    const want = REPLY[cmd];
    const answer = await this.request(
      niimbotPacket(cmd, data),
      (p) => p[0] === 0x55 && p[1] === 0x55 && (p[2] === want || p[2] === ERROR),
      ms
    );
    if (answer[2] === ERROR) throw new Error(`Niimbot error ${answer[4]}${answer[4] === 2 ? ': out of labels' : ''}.`);
    return answer.subarray(4, 4 + answer[3]);
  }

  // The app's handshake. Older firmware doesn't answer: carry on.
  protected override async ready() {
    const packet = niimbotPacket(CMD.connect, [1]);
    const withPrefix = new Uint8Array(packet.length + 1);
    withPrefix[0] = 0x03;
    withPrefix.set(packet, 1);
    await this.request(withPrefix, (p) => p[2] === REPLY[CMD.connect], 1_500).catch(() => {});
  }

  override async keepAlive() {
    await this.write(niimbotPacket(CMD.heartbeat, [1]));
  }

  // Our density 1 (light) … 4 (dark) → the printer's 1 … 5.
  async init({ density = 3 }: { density?: number } = {}) {
    this.density = density <= 1 ? 1 : density >= 4 ? 5 : 3;
  }

  async printRaster(bitmap: Uint8Array, widthDots: number, heightDots: number) {
    const rowBytes = checkRaster(bitmap, widthDots, heightDots);
    await this.ask(CMD.density, [this.density]);
    await this.ask(CMD.labelType, [1]); // labels with gaps
    await this.ask(CMD.printStart, this.b1 ? [0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00] : [1]);
    await this.ask(CMD.pageStart);
    await this.ask(
      CMD.pageSize,
      this.b1 ? [...be16(heightDots), ...be16(widthDots), ...be16(1)] : [...be16(heightDots), ...be16(widthDots)]
    );

    // Rows, with runs of identical rows sent once with a repeat count.
    for (let y = 0; y < heightDots; ) {
      const row = bitmap.subarray(y * rowBytes, (y + 1) * rowBytes);
      let repeat = 1;
      while (y + repeat < heightDots && repeat < 255 && sameRow(bitmap, rowBytes, y, y + repeat)) {
        repeat++;
      }
      const packet = row.some((b) => b !== 0)
        ? niimbotPacket(CMD.row, [...be16(y), 0, 0, 0, repeat, ...row])
        : niimbotPacket(CMD.emptyRows, [...be16(y), repeat]);
      await this.write(packet);
      await sleep(10);
      y += repeat;
    }

    await this.ask(CMD.pageEnd);
    await this.waitPrinted();
  }

  // B1: poll the status until the page is out, then end. B21: poll the end
  // command until it says yes.
  private async waitPrinted() {
    const until = Date.now() + PRINT_TIMEOUT_MS;
    while (Date.now() < until) {
      if (this.b1) {
        const status = await this.ask(CMD.printStatus);
        if (((status[0] << 8) | status[1]) >= 1) {
          await this.ask(CMD.printEnd);
          return;
        }
      } else if ((await this.ask(CMD.printEnd))[0] === 1) {
        return;
      }
      await sleep(300);
    }
    throw new Error('The Niimbot did not finish printing.');
  }

  // Labels: the printer moves to the next one by itself.
  async feed() {}
}

function sameRow(bitmap: Uint8Array, rowBytes: number, a: number, b: number) {
  for (let i = 0; i < rowBytes; i++) if (bitmap[a * rowBytes + i] !== bitmap[b * rowBytes + i]) return false;
  return true;
}
