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

// One way a printer family talks: where to write, and optionally where it
// answers (status, flow control).
export interface Channel {
  service: string;
  write: string;
  notify?: string;
  // A second write characteristic for bulk image data, where the printer
  // has one (MXW01).
  data?: string;
  // Write without response even where with-response is offered: faster,
  // for printers that pace through `notify` or need none.
  noResponse?: boolean;
}

export interface WriteTarget {
  service: string;
  characteristic: string;
  withResponse: boolean;
  notify?: string;
  data?: string;
}

export interface DeviceFilter {
  namePrefixes: string[]; // none = any device
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
  findWrite(device: BleDevice, candidates: Channel[]): Promise<WriteTarget | null>;
  write(device: BleDevice, target: WriteTarget, data: Uint8Array): Promise<void>;
  // Deliver what the printer sends on `characteristic`. Again after every
  // connect; the latest callback wins.
  subscribe(
    device: BleDevice,
    service: string,
    characteristic: string,
    onData: (data: Uint8Array) => void
  ): Promise<void>;
  disconnect(device: BleDevice): Promise<void>;
}

// ---------- Web Bluetooth ----------

const webDevices = new Map<string, BluetoothDevice>();
const listeners = new WeakMap<BluetoothDevice, () => void>();
const chars = new Map<string, BluetoothRemoteGATTCharacteristic>();
const notifyHandlers = new Map<string, (data: Uint8Array) => void>();
const notifying = new WeakSet<BluetoothRemoteGATTCharacteristic>();
// Devices from getDevices() that haven't advertised since: see seenNearby.
const unseen = new Set<string>();
const ADVERTISEMENT_WAIT_MS = 10_000;

// Rejects after `ms`. The BLE stacks can leave a connect or write pending
// forever (Chrome's gatt.connect() has no timeout of its own), which would
// stall the reconnect loop and every print after it.
export function withTimeout<T>(promise: Promise<T>, ms: number, message = 'timed out'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Chrome only connects to a device from getDevices() once it has seen it
// advertise, so watch for one (briefly: the printer may be switched off).
// Until it has, every connect watches again: a printer that was off at
// restore is picked up as soon as it's switched on.
function seenNearby(device: BluetoothDevice, ms = ADVERTISEMENT_WAIT_MS): Promise<void> {
  if (typeof device.watchAdvertisements !== 'function') return Promise.resolve();
  unseen.add(device.id);
  const abort = new AbortController();
  return new Promise<void>((resolve) => {
    const stop = () => {
      clearTimeout(timer);
      device.removeEventListener('advertisementreceived', seen);
      abort.abort();
      resolve();
    };
    const seen = () => {
      unseen.delete(device.id);
      stop();
    };
    const timer = setTimeout(stop, ms);
    device.addEventListener('advertisementreceived', seen);
    // Can't watch here (no permission): waiting again won't help.
    device.watchAdvertisements({ signal: abort.signal }).catch(() => {
      if (!abort.signal.aborted) seen();
    });
  });
}

export const webBluetooth: BleTransport = {
  get available() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  },

  async requestDevice({ namePrefixes, services }) {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth not available in this browser.');
    // No names (printers sold under any name): list every nearby device.
    const device = await navigator.bluetooth.requestDevice(
      namePrefixes.length
        ? { filters: namePrefixes.map((namePrefix) => ({ namePrefix })), optionalServices: services }
        : { acceptAllDevices: true, optionalServices: services }
    );
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
    if (unseen.has(id)) await seenNearby(device);
    try {
      await device.gatt.connect();
    } catch (err) {
      // macOS: Chrome gives up after ~15 s ("Connection attempt failed")
      // while the link is still coming up, and then it does. Tearing it
      // down and starting over loses every slow connect, so look again.
      const gatt = device.gatt;
      for (let i = 0; i < 15 && !gatt.connected; i++) await new Promise((r) => setTimeout(r, 200));
      if (!gatt.connected) throw err;
    }
  },

  isConnected({ id }) {
    return !!webDevices.get(id)?.gatt?.connected;
  },

  async findWrite({ id }, candidates) {
    const server = webDevices.get(id)?.gatt;
    if (!server?.connected) throw new Error('Not connected.');
    for (const { service, write, notify, data, noResponse } of candidates) {
      try {
        const svc = await server.getPrimaryService(service);
        const char = await svc.getCharacteristic(write);
        chars.set(`${id}|${service}|${write}`, char);
        if (data) chars.set(`${id}|${service}|${data}`, await svc.getCharacteristic(data));
        const withResponse = char.properties.write && !(noResponse && char.properties.writeWithoutResponse);
        return { service, characteristic: write, withResponse, notify, data };
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

  async subscribe({ id }, service, characteristic, onData) {
    const server = webDevices.get(id)?.gatt;
    if (!server?.connected) throw new Error('Not connected.');
    const key = `${id}|${service}|${characteristic}`;
    notifyHandlers.set(key, onData);
    const char = await (await server.getPrimaryService(service)).getCharacteristic(characteristic);
    if (!notifying.has(char)) {
      notifying.add(char);
      char.addEventListener('characteristicvaluechanged', () => {
        const view = char.value;
        if (view)
          notifyHandlers.get(key)?.(
            new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
          );
      });
    }
    await char.startNotifications();
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
