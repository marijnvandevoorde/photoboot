// Common interface every printer backend implements. The booth and print
// pages talk to this, never to a concrete subclass.
//
// A backend picks and keeps one BLE device through the transport (see
// transport.ts) and reports status through onLog / onDisconnect. Subclasses
// implement the protocol: `attach`, `init`, `printRaster` and `feed`.

import { type BleDevice, type BleTransport, transport } from './transport.ts';

export interface PrinterOptions {
  onLog?: (msg: string) => void;
  onDisconnect?: () => void;
  transport?: BleTransport;
}

export abstract class PrinterBase {
  device: BleDevice | null = null;
  protected readonly ble: BleTransport;
  protected readonly onLog: (msg: string) => void;
  protected readonly onDisconnect: () => void;

  constructor({ onLog = () => {}, onDisconnect = () => {}, transport: ble = transport() }: PrinterOptions = {}) {
    this.onLog = onLog;
    this.onDisconnect = onDisconnect;
    this.ble = ble;
  }

  log(msg: string) {
    this.onLog(msg);
  }

  get connected(): boolean {
    return !!this.device && this.ble.isConnected(this.device);
  }

  // Pick a device with the system picker, then attach.
  abstract connect(): Promise<void>;

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
  }

  // Connect to an already picked device and find its write channel.
  abstract attach(device: BleDevice): Promise<void>;

  async disconnect(): Promise<void> {
    if (this.device) await this.ble.disconnect(this.device);
    this.device = null;
  }

  abstract init(opts?: { density?: number }): Promise<void>;

  abstract feed(n?: number): Promise<void>;

  // bitmap: packed MSB-first, 1 = black dot.
  abstract printRaster(bitmap: Uint8Array, widthDots: number, heightDots: number): Promise<void>;
}
