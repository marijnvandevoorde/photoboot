// Common interface every printer backend implements. The booth and print
// pages talk to this, never to a concrete subclass.
//
// A backend picks and keeps one BLE device through the transport (see
// transport.ts) and reports status through onLog / onDisconnect. The base
// does the Bluetooth side for every family: connecting with a timeout,
// finding the write (and optional notify) channel, one write at a time, and
// resetting a link that stopped carrying data. Subclasses declare their
// channels and speak the protocol: `init`, `printRaster` and `feed`, and
// optionally `keepAlive`, `ready` (a handshake after connecting) and
// `received` (what the printer sends back).

import { modelForName, type PrinterModel } from './models.ts';
import {
  type BleDevice,
  type BleTransport,
  type Channel,
  transport,
  type WriteTarget,
  withTimeout,
} from './transport.ts';

export interface PrinterOptions {
  onLog?: (msg: string) => void;
  onDisconnect?: () => void;
  transport?: BleTransport;
  // The model the host picked in settings: wins over the device name.
  model?: PrinterModel | null;
  // Only offer devices with this name in the picker: the printer used
  // before, found again.
  deviceName?: string;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Covers waiting for a restored device's advertisement (10 s) plus the
// connect (on a Mac often 15 s) and any handshake.
const CONNECT_TIMEOUT_MS = 30_000;
// One write of a chunk; a healthy link takes milliseconds.
const WRITE_TIMEOUT_MS = 5_000;

export abstract class PrinterBase {
  device: BleDevice | null = null;
  protected readonly ble: BleTransport;
  protected readonly onLog: (msg: string) => void;
  protected readonly onDisconnect: () => void;
  protected target: WriteTarget | null = null;
  // GATT allows one operation at a time; a keepalive must not cut into a
  // print ("GATT operation already in progress").
  private queue: Promise<unknown> = Promise.resolve();

  // The driver id (see index.ts and models.ts), and its name in messages.
  protected abstract readonly familyId: string;
  protected abstract readonly family: string;
  // Name prefixes for the picker, and the channels to try, in order.
  protected abstract readonly namePrefixes: string[];
  protected abstract readonly channels: Channel[];
  // Bytes per GATT write. 20 always works; most printers take more.
  protected chunkSize = 200;
  // Pause after each write: cheap printers lose data that comes too fast.
  protected chunkDelayMs = 0;
  // Pick the picker by services instead of names (printers sold under
  // any name, like generic receipt printers).
  protected anyName = false;
  private readonly chosenModel: PrinterModel | null;
  private readonly deviceName: string | undefined;
  private waiters: { match: (data: Uint8Array) => boolean; resolve: (data: Uint8Array) => void }[] = [];
  // Printable width of the head in dots, from the model once connected.
  // The booth fits its stickers to this.
  headWidthDots = 384;
  // The model the device name matches, if any (see models.ts).
  model: PrinterModel | null = null;

  constructor({
    onLog = () => {},
    onDisconnect = () => {},
    transport: ble = transport(),
    model = null,
    deviceName,
  }: PrinterOptions = {}) {
    this.deviceName = deviceName;
    this.onLog = onLog;
    this.onDisconnect = onDisconnect;
    this.ble = ble;
    this.chosenModel = model;
    if (model) this.headWidthDots = model.headWidthDots;
  }

  log(msg: string) {
    this.onLog(msg);
  }

  // Up and with a write channel: a link that came up without one is broken.
  get connected(): boolean {
    return !!this.device && !!this.target && this.ble.isConnected(this.device);
  }

  // Pick a device with the system picker, then attach.
  async connect(): Promise<void> {
    if (!this.ble.available) throw new Error('Bluetooth is not available here.');
    this.log('Requesting device…');
    const device = await this.ble.requestDevice({
      namePrefixes: this.deviceName
        ? [this.deviceName]
        : this.anyName || this.chosenModel?.anyName
          ? []
          : this.namePrefixes,
      services: [...new Set(this.channels.map((c) => c.service))],
    });
    this.log(`Selected: ${device.name || device.id}`);
    await this.attach(device);
  }

  // Reconnect to the previously picked device without the picker: the
  // booth's "stay with the same printer forever" behaviour.
  async reconnect(): Promise<void> {
    if (!this.device) throw new Error('No printer selected yet.');
    await this.attach(this.device);
  }

  // Take over a device restored from an earlier visit (see
  // transport.restoreDevice) without connecting yet: `reconnect` connects,
  // and keeps working when the printer is switched on later.
  adopt(device: BleDevice) {
    this.device = device;
    this.recognise(device.name);
  }

  // Connect to an already picked device and find its channels, or leave it
  // disconnected: never half connected, and never waiting forever.
  async attach(device: BleDevice): Promise<void> {
    this.target = null;
    try {
      await withTimeout(this.open(device), CONNECT_TIMEOUT_MS, 'The printer did not answer.');
    } catch (err) {
      this.target = null;
      await this.ble.disconnect(device).catch(() => {});
      throw err;
    }
  }

  private async open(device: BleDevice): Promise<void> {
    await this.ble.connect(device, () => {
      this.log('Disconnected.');
      this.target = null;
      this.onDisconnect();
    });
    this.log('Connected. Probing services…');
    const target = await this.ble.findWrite(device, this.channels);
    if (!target) throw new Error(`No known ${this.family} service found on this device.`);
    this.log(`Found service ${target.service.slice(4, 8)} / char ${target.characteristic.slice(4, 8)}`);
    if (target.notify) {
      await this.ble.subscribe(device, target.service, target.notify, (data) => this.notified(data));
    }
    this.device = device;
    this.recognise(device.name);
    this.target = target;
    await this.ready();
  }

  private recognise(name: string) {
    this.model = this.chosenModel ?? modelForName(name, this.familyId);
    if (this.model) this.headWidthDots = this.model.headWidthDots;
  }

  private notified(data: Uint8Array) {
    const i = this.waiters.findIndex((w) => w.match(data));
    if (i >= 0) this.waiters.splice(i, 1)[0].resolve(data);
    this.received(data);
  }

  // Write `bytes`, then wait for the first notification that `match`es.
  protected async request(bytes: Uint8Array, match: (data: Uint8Array) => boolean, ms = 2_000): Promise<Uint8Array> {
    let waiter: (typeof this.waiters)[number] | undefined;
    const answer = new Promise<Uint8Array>((resolve) => {
      waiter = { match, resolve };
      this.waiters.push(waiter);
    });
    try {
      await this.write(bytes);
      return await withTimeout(answer, ms, `The ${this.family} printer did not reply.`);
    } finally {
      this.waiters = this.waiters.filter((w) => w !== waiter);
    }
  }

  // After connecting, before the link counts as up: a handshake, if any.
  protected async ready(): Promise<void> {}

  // Bytes from the notify channel.
  protected received(_data: Uint8Array): void {}

  // Drop the link but keep the device, so `reconnect` starts from a clean
  // slate: the way out of a link that looks up but no longer carries data.
  async reset(): Promise<void> {
    this.target = null;
    if (this.device) await this.ble.disconnect(this.device).catch(() => {});
  }

  async disconnect(): Promise<void> {
    this.target = null;
    if (this.device) await this.ble.disconnect(this.device);
    this.device = null;
  }

  // Send bytes in chunks, after any write already queued. A write that
  // fails or hangs means the link is gone, whatever the stack says: reset it
  // so the next reconnect starts clean. `pace` runs before each chunk (flow
  // control).
  write(bytes: Uint8Array | number[], { bulk = false } = {}): Promise<void> {
    const run = this.queue.then(async () => {
      const { device } = this;
      // Bulk data goes to the channel's data characteristic, if it has one.
      const target =
        bulk && this.target?.data
          ? { ...this.target, characteristic: this.target.data, withResponse: false }
          : this.target;
      if (!device || !target) throw new Error('Not connected.');
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      try {
        for (let i = 0; i < data.length; i += this.chunkSize) {
          await this.pace();
          const chunk = data.slice(i, i + this.chunkSize);
          await withTimeout(this.ble.write(device, target, chunk), WRITE_TIMEOUT_MS, 'The printer stopped answering.');
          if (this.chunkDelayMs) await sleep(this.chunkDelayMs);
        }
      } catch (err) {
        await this.reset();
        throw err;
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  // Wait before the next chunk, for printers that ask to pause.
  protected async pace(): Promise<void> {}

  // Something harmless to send while idle: some printers drop a quiet link,
  // and a failed send finds a dead one before a guest's print does.
  async keepAlive(): Promise<void> {}

  // density: 1 = light, 3 = normal, 4 = dark (each family maps it).
  abstract init(opts?: { density?: number }): Promise<void>;

  abstract feed(n?: number): Promise<void>;

  // bitmap: packed MSB-first, 1 = black dot. Never wider than headWidthDots.
  abstract printRaster(bitmap: Uint8Array, widthDots: number, heightDots: number): Promise<void>;
}

// Reverse the bits of every byte: MSB-first rows → LSB-first (cat printers).
export function lsbFirst(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    let b = bytes[i];
    b = ((b & 0xf0) >> 4) | ((b & 0x0f) << 4);
    b = ((b & 0xcc) >> 2) | ((b & 0x33) << 2);
    out[i] = ((b & 0xaa) >> 1) | ((b & 0x55) << 1);
  }
  return out;
}

// GS v 0 raster blocks of at most `band` rows (cheap firmware chokes on
// taller ones): ESC/POS, Phomemo, LuckJingle and friends.
export function gsv0(bitmap: Uint8Array, rowBytes: number, heightDots: number, band = 255): Uint8Array[] {
  const blocks: Uint8Array[] = [];
  for (let y = 0; y < heightDots; y += band) {
    const rows = Math.min(band, heightDots - y);
    const slice = bitmap.subarray(y * rowBytes, (y + rows) * rowBytes);
    const block = new Uint8Array(8 + slice.length);
    block.set([0x1d, 0x76, 0x30, 0x00, rowBytes & 0xff, rowBytes >> 8, rows & 0xff, rows >> 8]);
    block.set(slice, 8);
    blocks.push(block);
  }
  return blocks;
}

// Shared check for printRaster.
export function checkRaster(bitmap: Uint8Array, widthDots: number, heightDots: number) {
  if (widthDots % 8 !== 0) throw new Error('widthDots must be a multiple of 8.');
  const rowBytes = widthDots / 8;
  if (bitmap.length !== rowBytes * heightDots) {
    throw new Error(`bitmap size mismatch: expected ${rowBytes * heightDots}, got ${bitmap.length}`);
  }
  return rowBytes;
}
