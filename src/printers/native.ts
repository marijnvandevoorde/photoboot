// BleTransport for the iOS / Android app: the Capacitor BLE plugin, since
// the app's web view has no Web Bluetooth. Same contract as webBluetooth.

import { BleClient } from '@capacitor-community/bluetooth-le';
import type { BleTransport } from './transport.ts';

const connected = new Set<string>();
let ready: Promise<void> | null = null;

// Asks for Bluetooth permission the first time; later calls are free.
function init(): Promise<void> {
  ready ??= BleClient.initialize().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const nativeBle: BleTransport = {
  available: true,

  async requestDevice({ namePrefixes, services }) {
    await init();
    // The plugin filters on one name prefix at most; with several, the
    // system list shows every nearby device and the guest picks by name.
    const device = await BleClient.requestDevice({
      namePrefix: namePrefixes.length === 1 ? namePrefixes[0] : undefined,
      optionalServices: services,
      displayMode: 'list',
    });
    return { id: device.deviceId, name: device.name ?? '' };
  },

  // iOS: retrievePeripherals; Android connects to any address it's given.
  async restoreDevice(id) {
    await init();
    const [device] = await BleClient.getDevices([id]);
    return device ? { id: device.deviceId, name: device.name ?? '' } : null;
  },

  async connect({ id }, onDisconnect) {
    await init();
    await BleClient.connect(id, () => {
      connected.delete(id);
      onDisconnect();
    });
    connected.add(id);
  },

  isConnected({ id }) {
    return connected.has(id);
  },

  async findWrite({ id }, candidates) {
    const services = await BleClient.getServices(id);
    for (const { service, write } of candidates) {
      const char = services.find((s) => same(s.uuid, service))?.characteristics.find((c) => same(c.uuid, write));
      if (char) return { service, characteristic: write, withResponse: char.properties.write };
    }
    return null;
  },

  async write({ id }, { service, characteristic, withResponse }, data) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (withResponse) await BleClient.write(id, service, characteristic, view);
    else await BleClient.writeWithoutResponse(id, service, characteristic, view);
  },

  async disconnect({ id }) {
    connected.delete(id);
    await BleClient.disconnect(id);
  },
};
