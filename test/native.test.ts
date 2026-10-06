import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PHOMEMO_UUIDS, PhomemoPrinter } from '../src/printers/phomemo.ts';

// The Capacitor BLE plugin, as the app sees it on a device with a P2S.
const ble = vi.hoisted(() => ({
  initialize: vi.fn(async () => {}),
  requestDevice: vi.fn(async (_opts: unknown) => ({ deviceId: 'AA:BB', name: 'P2S-9' })),
  getDevices: vi.fn(async (ids: string[]) => ids.map((deviceId) => ({ deviceId, name: 'P2S-9' }))),
  connect: vi.fn(async (_id: string, _onDisconnect?: (id: string) => void) => {}),
  disconnect: vi.fn(async (_id: string) => {}),
  // iOS reports UUIDs in upper case: matching must not care.
  getServices: vi.fn(async (_id: string) => [
    {
      uuid: PHOMEMO_UUIDS[0].service.toUpperCase(),
      characteristics: [{ uuid: PHOMEMO_UUIDS[0].write.toUpperCase(), properties: { write: false } }],
    },
  ]),
  write: vi.fn(async (..._args: unknown[]) => {}),
  writeWithoutResponse: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock('@capacitor-community/bluetooth-le', () => ({ BleClient: ble }));

const { nativeBle } = await import('../src/printers/native.ts');
const { restorePrinter } = await import('../src/printers/index.ts');

beforeEach(() => vi.clearAllMocks());

describe('native BLE transport', () => {
  it('drives a Phomemo through the plugin', async () => {
    const printer = new PhomemoPrinter({ transport: nativeBle });
    await printer.connect();
    expect(ble.initialize).toHaveBeenCalled();
    // Several Phomemo prefixes → no single prefix filter, list picker.
    expect(ble.requestDevice).toHaveBeenCalledWith(
      expect.objectContaining({ namePrefix: undefined, displayMode: 'list' })
    );
    expect(printer.connected).toBe(true);

    await printer.init({ density: 3 });
    expect(ble.writeWithoutResponse).toHaveBeenCalledTimes(1); // the char has no `write` property
    const [id, service, char, view] = ble.writeWithoutResponse.mock.calls[0] as [string, string, string, DataView];
    expect([id, service, char]).toEqual(['AA:BB', PHOMEMO_UUIDS[0].service, PHOMEMO_UUIDS[0].write]);
    expect([...new Uint8Array(view.buffer, view.byteOffset, view.byteLength)]).toEqual([
      0x1b, 0x40, 0x1f, 0x11, 0x02, 3,
    ]);
  });

  it('notices a dropped link', async () => {
    let drops = 0;
    const printer = new PhomemoPrinter({ transport: nativeBle, onDisconnect: () => drops++ });
    await printer.connect();
    const onDisconnect = ble.connect.mock.calls[0][1];
    onDisconnect?.('AA:BB');
    expect(drops).toBe(1);
    expect(printer.connected).toBe(false);
  });

  it('filters on the prefix when there is only one', async () => {
    await nativeBle.requestDevice({ namePrefixes: ['P2'], services: [] });
    expect(ble.requestDevice).toHaveBeenCalledWith(expect.objectContaining({ namePrefix: 'P2' }));
  });

  it('reports a device without a known service', async () => {
    ble.getServices.mockResolvedValueOnce([]);
    await expect(new PhomemoPrinter({ transport: nativeBle }).connect()).rejects.toThrow(/No known Phomemo service/);
  });

  it('restores a printer from an earlier app run without the picker', async () => {
    const printer = await restorePrinter({ id: 'AA:BB', name: 'P2S-9', type: 'auto' }, { transport: nativeBle });
    expect(ble.getDevices).toHaveBeenCalledWith(['AA:BB']);
    expect(ble.requestDevice).not.toHaveBeenCalled();
    await printer?.reconnect();
    expect(ble.connect).toHaveBeenCalledWith('AA:BB', expect.any(Function));
    expect(printer?.connected).toBe(true);
  });

  it('returns null when iOS no longer knows the device', async () => {
    ble.getDevices.mockResolvedValueOnce([]);
    expect(await nativeBle.restoreDevice('gone')).toBeNull();
  });
});
