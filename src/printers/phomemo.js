// Phomemo P2S / M02-family BLE printer client. ESC/POS-flavoured byte stream
// over a single GATT write characteristic. Width is parameterised because it
// varies by model (M02 Pro: 384 dots at 203dpi; P2S: 576 dots at 300dpi).

import { PrinterBase } from './base.js';

// All Phomemos use one of these three service/characteristic pairs. We try
// each in order on connect.
export const PHOMEMO_UUIDS = [
  {
    service: '0000ff00-0000-1000-8000-00805f9b34fb',
    write: '0000ff02-0000-1000-8000-00805f9b34fb',
  },
  {
    service: '0000ae30-0000-1000-8000-00805f9b34fb',
    write: '0000ae01-0000-1000-8000-00805f9b34fb',
  },
  {
    service: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    write: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
  },
];

export const PHOMEMO_NAME_PREFIXES = ['P2', 'M02', 'M03', 'M04', 'T02', 'Phomemo'];

export class PhomemoPrinter extends PrinterBase {
  constructor(opts = {}) {
    super(opts);
    this.writeChar = null;
    this.chunkSize = 200;
  }

  async connect() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth not available in this browser.');
    this.log('Requesting device…');
    const device = await navigator.bluetooth.requestDevice({
      filters: PHOMEMO_NAME_PREFIXES.map((prefix) => ({ namePrefix: prefix })),
      optionalServices: PHOMEMO_UUIDS.map((u) => u.service),
    });
    this.log(`Selected: ${device.name || device.id}`);
    this.bindDisconnect(device);
    await this.attach(device);
  }

  bindDisconnect(device) {
    device.addEventListener('gattserverdisconnected', () => {
      this.log('Disconnected.');
      this.writeChar = null;
      this.onDisconnect();
    });
  }

  async attach(device) {
    const server = await device.gatt.connect();
    this.log('GATT connected. Probing services…');
    let writeChar = null;
    for (const { service, write } of PHOMEMO_UUIDS) {
      try {
        const svc = await server.getPrimaryService(service);
        writeChar = await svc.getCharacteristic(write);
        this.log(`Found service ${service.slice(4, 8)} / char ${write.slice(4, 8)}`);
        break;
      } catch (_) {
        // try next candidate
      }
    }
    if (!writeChar) throw new Error('No known Phomemo service found on this device.');
    this.device = device;
    this.writeChar = writeChar;
  }

  async disconnect() {
    await super.disconnect();
    this.writeChar = null;
  }

  async write(bytes) {
    if (!this.writeChar) throw new Error('Not connected.');
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const useResponse = this.writeChar.properties.write;
    for (let i = 0; i < data.length; i += this.chunkSize) {
      const chunk = data.slice(i, i + this.chunkSize);
      if (useResponse) await this.writeChar.writeValueWithResponse(chunk);
      else await this.writeChar.writeValueWithoutResponse(chunk);
    }
  }

  // density: 1 = thin, 3 = normal, 4 = thick. Don't probe other 1F 11 xx
  // opcodes — unknown ones have bricked M02-family printers.
  async init({ density = 3 } = {}) {
    await this.write(new Uint8Array([0x1b, 0x40, 0x1f, 0x11, 0x02, density]));
  }

  async feed(n = 80) {
    await this.write(new Uint8Array([0x1b, 0x4a, Math.min(255, n)]));
  }

  async printRaster(bitmap, widthDots, heightDots) {
    if (widthDots % 8 !== 0) throw new Error('widthDots must be a multiple of 8.');
    const rowBytes = widthDots / 8;
    if (bitmap.length !== rowBytes * heightDots) {
      throw new Error(`bitmap size mismatch: expected ${rowBytes * heightDots}, got ${bitmap.length}`);
    }
    const BAND = 128;
    for (let y = 0; y < heightDots; y += BAND) {
      const rows = Math.min(BAND, heightDots - y);
      const header = new Uint8Array([
        0x1d, 0x76, 0x30, 0x00,
        rowBytes & 0xff, (rowBytes >> 8) & 0xff,
        rows & 0xff, (rows >> 8) & 0xff,
      ]);
      const slice = bitmap.subarray(y * rowBytes, (y + rows) * rowBytes);
      const packet = new Uint8Array(header.length + slice.length);
      packet.set(header, 0);
      packet.set(slice, header.length);
      await this.write(packet);
    }
  }
}
