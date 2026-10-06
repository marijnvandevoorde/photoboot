// Bluetooth LE transport used by the printer drivers. Drivers speak their
// protocol in bytes; the transport finds the device, connects and writes.
//
// - webBluetooth: navigator.bluetooth (Chrome, Edge, Bluefy).
// - native (src/printers/native.ts): the Capacitor BLE plugin inside the
//   iOS / Android app, where the web view has no Web Bluetooth.

export interface BleDevice {
  id: string;
  name: string;
}

export interface WriteTarget {
  service: string;
  characteristic: string;
  withResponse: boolean;
}

export interface DeviceFilter {
  namePrefixes: string[];
  services: string[]; // services the driver may need, for permission
}

export interface BleTransport {
  readonly available: boolean;
  requestDevice(filter: DeviceFilter): Promise<BleDevice>;
  // A device picked on an earlier visit or app run, found again by id
  // without the picker. Null when it's gone or the platform can't do this.
  restoreDevice(id: string): Promise<BleDevice | null>;
  connect(device: BleDevice, onDisconnect: () => void): Promise<void>;
  isConnected(device: BleDevice): boolean;
  // First of `candidates` the device offers, or null.
  findWrite(device: BleDevice, candidates: { service: string; write: string }[]): Promise<WriteTarget | null>;
  write(device: BleDevice, target: WriteTarget, data: Uint8Array): Promise<void>;
  disconnect(device: BleDevice): Promise<void>;
}

// ---------- Web Bluetooth ----------

const webDevices = new Map<string, BluetoothDevice>();
const listeners = new WeakMap<BluetoothDevice, () => void>();
const chars = new Map<string, BluetoothRemoteGATTCharacteristic>();
const ADVERTISEMENT_WAIT_MS = 10_000;

// Chrome only connects to a device from getDevices() once it has seen it
// advertise, so watch for one (briefly: the printer may be switched off).
function seenNearby(device: BluetoothDevice, ms = ADVERTISEMENT_WAIT_MS): Promise<void> {
  if (typeof device.watchAdvertisements !== 'function') return Promise.resolve();
  const abort = new AbortController();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      abort.abort();
      resolve();
    };
    const timer = setTimeout(done, ms);
    device.addEventListener('advertisementreceived', done, { once: true });
    device.watchAdvertisements({ signal: abort.signal }).catch(done);
  });
}

export const webBluetooth: BleTransport = {
  get available() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  },

  async requestDevice({ namePrefixes, services }) {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth not available in this browser.');
    const device = await navigator.bluetooth.requestDevice({
      filters: namePrefixes.map((namePrefix) => ({ namePrefix })),
      optionalServices: services,
    });
    webDevices.set(device.id, device);
    return { id: device.id, name: device.name ?? '' };
  },

  // getDevices() lists the devices this site was allowed before (Chrome;
  // not Bluefy or Safari, which then start without the printer).
  async restoreDevice(id) {
    if (typeof navigator.bluetooth?.getDevices !== 'function') return null;
    const device = (await navigator.bluetooth.getDevices()).find((d) => d.id === id);
    if (!device) return null;
    webDevices.set(device.id, device);
    await seenNearby(device);
    return { id: device.id, name: device.name ?? '' };
  },

  async connect({ id }, onDisconnect) {
    const device = webDevices.get(id);
    if (!device?.gatt) throw new Error('Unknown device.');
    if (!listeners.has(device)) {
      const handler = () => listeners.get(device)?.();
      device.addEventListener('gattserverdisconnected', handler);
    }
    listeners.set(device, onDisconnect);
    await device.gatt.connect();
  },

  isConnected({ id }) {
    return !!webDevices.get(id)?.gatt?.connected;
  },

  async findWrite({ id }, candidates) {
    const server = webDevices.get(id)?.gatt;
    if (!server?.connected) throw new Error('Not connected.');
    for (const { service, write } of candidates) {
      try {
        const svc = await server.getPrimaryService(service);
        const char = await svc.getCharacteristic(write);
        chars.set(`${id}|${service}|${write}`, char);
        return { service, characteristic: write, withResponse: char.properties.write };
      } catch {
        // try the next candidate
      }
    }
    return null;
  },

  async write({ id }, { service, characteristic, withResponse }, data) {
    const char = chars.get(`${id}|${service}|${characteristic}`);
    if (!char) throw new Error('Not connected.');
    const bytes = data as Uint8Array<ArrayBuffer>;
    if (withResponse) await char.writeValueWithResponse(bytes);
    else await char.writeValueWithoutResponse(bytes);
  },

  async disconnect({ id }) {
    const device = webDevices.get(id);
    if (device?.gatt?.connected) device.gatt.disconnect();
  },
};

let current: BleTransport = webBluetooth;

// The app shell swaps in its native transport at startup.
export function setTransport(transport: BleTransport) {
  current = transport;
}

export function transport(): BleTransport {
  return current;
}
