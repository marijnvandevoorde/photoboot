import { describe, expect, it, vi } from 'vitest';
import { restorePrinter, savedPrinter } from '../src/printers/index.ts';
import { PHOMEMO_UUIDS, PhomemoPrinter } from '../src/printers/phomemo.ts';
import type { BleDevice, BleTransport, WriteTarget } from '../src/printers/transport.ts';

// A transport that records every write instead of talking to hardware.
// `known` = device ids the platform can find again without the picker.
function fakeTransport({ services = [PHOMEMO_UUIDS[1].service], known = ['dev-1'] } = {}) {
  const writes: Uint8Array[] = [];
  let connected = false;
  let onDisconnect = () => {};
  const transport: BleTransport = {
    available: true,
    requestDevice: async () => ({ id: 'dev-1', name: 'P2S-1234' }),
    restoreDevice: async (id: string) => (known.includes(id) ? { id, name: 'P2S-1234' } : null),
    connect: async (_device: BleDevice, cb: () => void) => {
      connected = true;
      onDisconnect = cb;
    },
    isConnected: () => connected,
    findWrite: async (_device, candidates) => {
      const hit = candidates.find((c) => services.includes(c.service));
      return hit ? { service: hit.service, characteristic: hit.write, withResponse: true } : null;
    },
    write: async (_device: BleDevice, _target: WriteTarget, data: Uint8Array) => {
      writes.push(data.slice());
    },
    disconnect: async () => {
      connected = false;
    },
  };
  const drop = () => {
    connected = false;
    onDisconnect();
  };
  return { transport, writes, drop };
}

const bytes = (writes: Uint8Array[]) => writes.flatMap((w) => [...w]);

describe('PhomemoPrinter', () => {
  it('connects through the transport and finds the write characteristic', async () => {
    const { transport } = fakeTransport();
    const printer = new PhomemoPrinter({ transport });
    await printer.connect();
    expect(printer.connected).toBe(true);
    expect(printer.device).toEqual({ id: 'dev-1', name: 'P2S-1234' });
  });

  it('fails clearly when no known service exists', async () => {
    const { transport } = fakeTransport({ services: [] });
    await expect(new PhomemoPrinter({ transport }).connect()).rejects.toThrow(/No known Phomemo service/);
  });

  it('sends reset + density on init and clamps feeds', async () => {
    const { transport, writes } = fakeTransport();
    const printer = new PhomemoPrinter({ transport });
    await printer.connect();
    await printer.init({ density: 4 });
    await printer.feed(400);
    expect(bytes(writes)).toEqual([0x1b, 0x40, 0x1f, 0x11, 0x02, 4, 0x1b, 0x4a, 255]);
  });

  it('prints in 128-row bands of GS v 0, in chunks of at most 200 bytes', async () => {
    const { transport, writes } = fakeTransport();
    const printer = new PhomemoPrinter({ transport });
    await printer.connect();
    const widthDots = 16;
    const heightDots = 300;
    const bitmap = new Uint8Array((widthDots / 8) * heightDots).map((_, i) => i % 251);
    await printer.printRaster(bitmap, widthDots, heightDots);

    expect(Math.max(...writes.map((w) => w.length))).toBeLessThanOrEqual(200);
    const all = bytes(writes);
    const bands = [128, 128, 44];
    let p = 0;
    let row = 0;
    for (const rows of bands) {
      expect(all.slice(p, p + 8)).toEqual([0x1d, 0x76, 0x30, 0x00, 2, 0, rows, 0]);
      expect(all.slice(p + 8, p + 8 + rows * 2)).toEqual([...bitmap.subarray(row * 2, (row + rows) * 2)]);
      p += 8 + rows * 2;
      row += rows;
    }
    expect(p).toBe(all.length);
  });

  it('rejects a bitmap of the wrong size or width', async () => {
    const { transport } = fakeTransport();
    const printer = new PhomemoPrinter({ transport });
    await printer.connect();
    await expect(printer.printRaster(new Uint8Array(3), 16, 2)).rejects.toThrow(/size mismatch/);
    await expect(printer.printRaster(new Uint8Array(3), 12, 2)).rejects.toThrow(/multiple of 8/);
  });

  it('reports a dropped link and reconnects to the same device', async () => {
    const { transport, drop } = fakeTransport();
    let drops = 0;
    const printer = new PhomemoPrinter({ transport, onDisconnect: () => drops++ });
    await printer.connect();
    drop();
    expect(drops).toBe(1);
    expect(printer.connected).toBe(false);
    await printer.reconnect();
    expect(printer.connected).toBe(true);
  });
});

describe('restorePrinter', () => {
  it('finds the saved printer again without the picker, then reconnects', async () => {
    const { transport } = fakeTransport();
    const picked = new PhomemoPrinter({ transport });
    await picked.connect();
    const saved = savedPrinter(picked, 'auto');
    expect(saved).toEqual({ id: 'dev-1', name: 'P2S-1234', type: 'auto' });

    const requestDevice = vi.spyOn(transport, 'requestDevice');
    const { transport: fresh } = fakeTransport(); // a new page load: nothing connected
    const spy = vi.spyOn(fresh, 'requestDevice');
    const printer = await restorePrinter(saved as NonNullable<typeof saved>, { transport: fresh });
    expect(printer).toBeInstanceOf(PhomemoPrinter);
    expect(printer?.device).toEqual({ id: 'dev-1', name: 'P2S-1234' });
    expect(printer?.connected).toBe(false); // adopted, not connected yet
    await printer?.reconnect();
    expect(printer?.connected).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(requestDevice).not.toHaveBeenCalled();
  });

  it('uses an explicit printer type', async () => {
    const { transport } = fakeTransport({ known: ['x'] });
    const printer = await restorePrinter({ id: 'x', name: 'Mystery', type: 'phomemo' }, { transport });
    expect(printer).toBeInstanceOf(PhomemoPrinter);
  });

  it('gives up when the device is gone or unrecognised', async () => {
    const { transport } = fakeTransport({ known: [] });
    expect(await restorePrinter({ id: 'dev-1', name: 'P2S-1234', type: 'auto' }, { transport })).toBeNull();
    const other = fakeTransport({ known: ['dev-2'] }).transport;
    other.restoreDevice = async (id) => ({ id, name: 'Headphones' });
    expect(await restorePrinter({ id: 'dev-2', name: 'Headphones', type: 'auto' }, { transport: other })).toBeNull();
  });

  it('gives up without Bluetooth', async () => {
    const { transport } = fakeTransport();
    expect(
      await restorePrinter({ id: 'dev-1', name: '', type: 'auto' }, { transport: { ...transport, available: false } })
    ).toBeNull();
  });
});
