import { describe, expect, it } from 'vitest';
import { lsbFirst } from '../src/printers/base.ts';
import { CatPrinter, catPacket, crc8 } from '../src/printers/cat.ts';
import { EscPosPrinter } from '../src/printers/escpos.ts';
import { detectType } from '../src/printers/index.ts';
import { LuckPrinter } from '../src/printers/luck.ts';
import { MODELS, modelById, modelForName, settingsFor } from '../src/printers/models.ts';
import { Mxw01Printer } from '../src/printers/mxw01.ts';
import { NiimbotPrinter, niimbotPacket } from '../src/printers/niimbot.ts';
import { crc32, PaperangPrinter, paperangPacket } from '../src/printers/paperang.ts';
import { PhomemoPrinter } from '../src/printers/phomemo.ts';
import type { BleTransport, WriteTarget } from '../src/printers/transport.ts';
import { shrinkRaster } from '../src/raster.ts';

const hex = (s: string) => Uint8Array.from(s.split(' ').map((b) => parseInt(b, 16)));
const bytes = (writes: Uint8Array[]) => writes.flatMap((w) => [...w]);

// A printer on a fake link: records every write (and to which
// characteristic), and `answer` replies to a write through the notify
// channel, like the real printer would.
function fakePrinter(name: string, answer: (data: Uint8Array) => Uint8Array | null = () => null) {
  const writes: Uint8Array[] = [];
  const to: string[] = [];
  let connected = false;
  let notify: (data: Uint8Array) => void = () => {};
  const transport: BleTransport = {
    available: true,
    requestDevice: async () => ({ id: 'dev', name }),
    restoreDevice: async () => null,
    connect: async () => {
      connected = true;
    },
    isConnected: () => connected,
    findWrite: async (_device, [first]) => ({
      service: first.service,
      characteristic: first.write,
      withResponse: !first.noResponse,
      notify: first.notify,
      data: first.data,
    }),
    write: async (_device, target: WriteTarget, data: Uint8Array) => {
      writes.push(data.slice());
      to.push(target.characteristic.slice(4, 8));
      const reply = answer(data);
      if (reply) queueMicrotask(() => notify(reply));
    },
    subscribe: async (_device, _service, _char, onData) => {
      notify = onData;
    },
    disconnect: async () => {
      connected = false;
    },
  };
  return { transport, writes, to, notify: (data: Uint8Array) => notify(data) };
}

describe('printer models', () => {
  it('recognises devices by name, longest prefix first', () => {
    const id = (name: string) => modelForName(name)?.id;
    expect(id('P2S-1234')).toBe('phomemo-p2s');
    expect(id('M02S_AB')).toBe('phomemo-m02s');
    expect(id('M02-12')).toBe('phomemo-m02');
    expect(id('Q199E')).toBe('phomemo-m110');
    expect(id('GB03')).toBe('cat-gb');
    expect(id('MX06')).toBe('cat-mx');
    expect(id('MXW01-1')).toBe('mxw01');
    expect(id('MXW010')).toBe('cat-mx');
    expect(id('LuckP_D1_1234')).toBe('luck-pocket');
    expect(id('PeriPage+AB12')).toBe('peripage-a6plus');
    expect(id('PeriPage_AB12')).toBe('peripage-a6');
    expect(id('B21-C2B')).toBe('niimbot-b21');
    expect(id('Headphones')).toBeUndefined();
    expect(detectType({ id: 'x', name: 'GT01' })).toBe('cat');
  });

  it('has a usable entry for every model', () => {
    const ids = new Set<string>();
    for (const m of MODELS) {
      expect(ids.has(m.id)).toBe(false);
      ids.add(m.id);
      expect(m.widthDots % 8).toBe(0);
      expect(m.widthDots).toBeLessThanOrEqual(m.headWidthDots);
      expect(m.names.length > 0 || m.anyName).toBe(true);
    }
  });

  it('sets the width only while it follows the printer', () => {
    const cat = modelById('cat-gb');
    if (!cat) throw new Error('no cat model');
    expect(settingsFor(cat, { paperWidthAuto: true })).toEqual({ dotsPerMm: 8, paperWidthDots: 384 });
    expect(settingsFor(cat, { paperWidthAuto: false })).toEqual({ dotsPerMm: 8 });
  });

  it('picks the chosen model over the device name', async () => {
    const { transport } = fakePrinter('BlueTooth Printer');
    const printer = new EscPosPrinter({ transport, model: modelById('escpos-80') });
    await printer.connect();
    expect(printer.model?.id).toBe('escpos-80');
    expect(printer.headWidthDots).toBe(576);
  });
});

describe('raster helpers', () => {
  it('reverses bits for LSB-first printers', () => {
    expect([...lsbFirst(hex('80 01 f0 aa'))]).toEqual([0x01, 0x80, 0x0f, 0x55]);
  });

  it('scales a raster that is too wide for the head', () => {
    const raster = { bitmap: new Uint8Array(4 * 4).fill(0xff), widthDots: 32, heightDots: 4 };
    const small = shrinkRaster(raster, 16);
    expect(small).toMatchObject({ widthDots: 16, heightDots: 2 });
    expect([...small.bitmap]).toEqual([0xff, 0xff, 0xff, 0xff]);
    expect(shrinkRaster(raster, 32)).toBe(raster);
  });
});

describe('cat printers', () => {
  it('builds 51 78 packets with a CRC-8 over the payload', () => {
    expect(crc8(hex('32'))).toBe(0x9e);
    expect([...catPacket(0xa3, [0])]).toEqual([...hex('51 78 a3 00 01 00 00 00 ff')]);
    expect([...catPacket(0xa4, [0x32])]).toEqual([...hex('51 78 a4 00 01 00 32 9e ff')]);
    expect([...catPacket(0xaf, [0x00, 0x40])]).toEqual([...hex('51 78 af 00 02 00 00 40 c7 ff')]);
    expect([...catPacket(0xa1, [0x80, 0x00])]).toEqual([...hex('51 78 a1 00 02 00 80 00 b6 ff')]);
  });

  it('prints LSB-first 48-byte rows between lattice start and end', async () => {
    const { transport, writes } = fakePrinter('GB01');
    const printer = new CatPrinter({ transport });
    await printer.connect();
    await printer.init({ density: 3 });
    const bitmap = new Uint8Array(48 * 2);
    bitmap[0] = 0x80; // leftmost dot of row 0
    await printer.printRaster(bitmap, 384, 2);
    const all = bytes(writes);
    const rows = [];
    for (let i = 0; i < all.length; i++)
      if (all[i] === 0x51 && all[i + 1] === 0x78 && all[i + 2] === 0xa2) rows.push(i);
    expect(rows).toHaveLength(2);
    expect(all.slice(rows[0] + 6, rows[0] + 7)).toEqual([0x01]); // bit 0 = leftmost
    expect(Math.max(...writes.map((w) => w.length))).toBeLessThanOrEqual(100);
    const lattice = all.findIndex((_, i) => all[i + 2] === 0xa6 && all[i] === 0x51);
    expect(lattice).toBeLessThan(rows[0]);
  });

  it('waits while the printer asks to pause', async () => {
    const { transport, writes, notify } = fakePrinter('GB01');
    const printer = new CatPrinter({ transport });
    await printer.connect();
    await printer.init();
    notify(hex('51 78 ae 01 01 00 10 70 ff'));
    const job = printer.printRaster(new Uint8Array(48 * 4), 384, 4);
    await new Promise((r) => setTimeout(r, 60));
    expect(writes).toHaveLength(0);
    notify(hex('51 78 ae 01 01 00 00 00 ff'));
    await job;
    expect(writes.length).toBeGreaterThan(0);
  });
});

describe('MXW01', () => {
  // Status OK, print accepted, then "done" after the flush.
  const answers = (data: Uint8Array) => {
    if (data[0] !== 0x22) return null;
    if (data[2] === 0xa1) return Uint8Array.from([0x22, 0x21, 0xa1, 0, 14, 0, ...new Array(14).fill(0)]);
    if (data[2] === 0xa9) return hex('22 21 a9 00 01 00 00 00 ff');
    if (data[2] === 0xad) return hex('22 21 aa 00 01 00 00 00 ff');
    return null;
  };

  it('announces the rows, sends them to the data characteristic and waits until printed', async () => {
    const { transport, writes, to } = fakePrinter('MXW01', answers);
    const printer = new Mxw01Printer({ transport });
    await printer.connect();
    await printer.init({ density: 3 });
    await printer.printRaster(new Uint8Array(48 * 10), 384, 10);
    expect([...writes[0]]).toEqual([...hex('22 21 a2 00 01 00 5d 94 ff')]);
    // 10 rows are padded to the minimum of 90.
    expect(writes.find((w) => w[2] === 0xa9)?.slice(6, 10)).toEqual(hex('5a 00 30 00'));
    const image = writes.filter((_, i) => to[i] === 'ae03');
    expect(image.reduce((n, w) => n + w.length, 0)).toBe(90 * 48);
    expect(writes.at(-1)?.[2]).toBe(0xad);
  });

  it('reports a printer error', async () => {
    const outOfPaper = (data: Uint8Array) =>
      data[2] === 0xa1 ? Uint8Array.from([0x22, 0x21, 0xa1, 0, 14, 0, ...new Array(12).fill(0), 1, 1]) : null;
    const { transport } = fakePrinter('MXW01', outOfPaper);
    const printer = new Mxw01Printer({ transport });
    await printer.connect();
    await expect(printer.printRaster(new Uint8Array(48), 384, 1)).rejects.toThrow(/out of paper/);
  });
});

describe('LuckJingle family', () => {
  it('wakes, enables, prints GS v 0 and stops, in the model dialect', async () => {
    const { transport, writes } = fakePrinter('PeriPage_1234');
    const printer = new LuckPrinter({ transport });
    await printer.connect();
    await printer.init({ density: 4 });
    await printer.printRaster(new Uint8Array(48 * 2), 384, 2);
    const all = bytes(writes);
    expect(all.slice(0, 12)).toEqual(new Array(12).fill(0));
    expect(all.slice(12, 16)).toEqual([0x10, 0xff, 0xfe, 0x01]); // PeriPage: AiYin dialect
    expect(all.slice(16, 21)).toEqual([0x10, 0xff, 0x10, 0x00, 2]);
    expect(all.slice(21, 29)).toEqual([0x1d, 0x76, 0x30, 0x00, 48, 0, 2, 0]);
    expect(all.slice(-4)).toEqual([0x10, 0xff, 0xfe, 0x45]);
  });

  it('uses the Lujiang dialect for LuckJingle and Action printers', async () => {
    const { transport, writes } = fakePrinter('C&Co 3128');
    const printer = new LuckPrinter({ transport });
    await printer.connect();
    await printer.printRaster(new Uint8Array(48), 384, 1);
    expect(bytes(writes).slice(12, 16)).toEqual([0x10, 0xff, 0xf1, 0x03]);
  });
});

describe('Paperang', () => {
  it('frames packets with the keyed CRC-32', () => {
    expect(crc32(hex('5f'), 0x35769521)).toBe(0x658ac523);
    expect([...paperangPacket(25, [95])]).toEqual([2, 25, 0, 1, 0, 95, 0x23, 0xc5, 0x8a, 0x65, 3]);
  });

  it('sends whole rows, at most 500 bytes per packet', async () => {
    const { transport, writes } = fakePrinter('Paperang');
    const printer = new PaperangPrinter({ transport });
    await printer.connect();
    await printer.printRaster(new Uint8Array(48 * 25), 384, 25);
    expect(writes.map((w) => w[3] | (w[4] << 8))).toEqual([480, 480, 240]);
  });
});

describe('Niimbot', () => {
  it('builds packets with an XOR checksum', () => {
    expect([...niimbotPacket(0x21, [3])]).toEqual([...hex('55 55 21 01 03 23 aa aa')]);
    expect([...niimbotPacket(0x13, [0, 0xf0, 0, 0x60])]).toEqual([...hex('55 55 13 04 00 f0 00 60 87 aa aa')]);
    expect([...niimbotPacket(0x84, [0, 0, 5])]).toEqual([...hex('55 55 84 03 00 00 05 82 aa aa')]);
  });

  // Answers every command; the B1 page is printed on the first status poll.
  const answers = (data: Uint8Array) => {
    const at = data[0] === 0x03 ? 1 : 0;
    if (data[at] !== 0x55) return null;
    const cmd = data[at + 2];
    if (cmd === 0x85 || cmd === 0x84 || cmd === 0xdc) return null;
    const reply = { 193: 0xc2, 33: 0x31, 35: 0x33, 1: 0x02, 3: 0x04, 19: 0x14, 227: 0xe4, 163: 0xb3, 243: 0xf4 }[cmd];
    return reply ? niimbotPacket(reply, reply === 0xb3 ? [0, 1, 100, 100] : [1]) : null;
  };

  it('runs a B1 job: page size with copies, rows with repeats, then waits for the page', async () => {
    const { transport, writes } = fakePrinter('B1-G123', answers);
    const printer = new NiimbotPrinter({ transport });
    await printer.connect();
    await printer.init({ density: 4 });
    const bitmap = new Uint8Array(48 * 4);
    bitmap.fill(0xff, 48, 48 * 3); // rows 1 and 2 black
    await printer.printRaster(bitmap, 384, 4);
    const cmds = writes.map((w) => (w[0] === 0x03 ? w[3] : w[2]));
    expect(cmds).toEqual([0xc1, 0x21, 0x23, 0x01, 0x03, 0x13, 0x84, 0x85, 0x84, 0xe3, 0xa3, 0xf3]);
    expect([...writes[5].subarray(4, 10)]).toEqual([0, 4, 1, 0x80, 0, 1]);
    expect([...writes[7].subarray(4, 10)]).toEqual([0, 1, 0, 0, 0, 2]); // row 1, twice
  });

  it('turns a printer error into a message', async () => {
    const { transport } = fakePrinter('B21-1', (data) => (data[2] === 0x21 ? niimbotPacket(0xdb, [2]) : null));
    const printer = new NiimbotPrinter({ transport });
    await printer.connect();
    await expect(printer.printRaster(new Uint8Array(48), 384, 1)).rejects.toThrow(/out of labels/);
  });
});

describe('Phomemo label printers', () => {
  it('sets speed, density and gap labels, and ends each label', async () => {
    const { transport, writes } = fakePrinter('Q199E');
    const printer = new PhomemoPrinter({ transport });
    await printer.connect();
    await printer.init({ density: 3 });
    await printer.printRaster(new Uint8Array(48), 384, 1);
    const all = bytes(writes);
    expect(all.slice(0, 11)).toEqual([0x1b, 0x4e, 0x0d, 0x05, 0x1b, 0x4e, 0x04, 0x0a, 0x1f, 0x11, 0x0a]);
    expect(all.slice(-8)).toEqual([0x1f, 0xf0, 0x05, 0x00, 0x1f, 0xf0, 0x03, 0x00]);
  });
});
