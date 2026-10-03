// Phomemo P2S / M02-family Bluetooth printer client.
//
// Raster width is parameterised per-print — the head width varies by model
// and we need to calibrate it empirically.
//
// We try a few known service/characteristic UUID pairs because Phomemo has
// shipped at least two variants across the M02/M02S/P2/P2S lineup.

const UUID_CANDIDATES = [
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

// Starting assumption for the P2S. Calibration prints verify this empirically.
export const DEFAULT_PRINT_WIDTH_DOTS = 384;

export class PhomemoPrinter {
  constructor({ onLog = () => {} } = {}) {
    this.onLog = onLog;
    this.device = null;
    this.writeChar = null;
    this.chunkSize = 200;
  }

  log(msg) {
    this.onLog(msg);
  }

  get connected() {
    return !!this.device?.gatt?.connected;
  }

  async connect() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth not available in this browser.');

    this.log('Requesting device…');
    const device = await navigator.bluetooth.requestDevice({
      // Phomemo advertises names like "P2S", "M02 Pro", etc.
      filters: [
        { namePrefix: 'P2' },
        { namePrefix: 'M02' },
        { namePrefix: 'M03' },
        { namePrefix: 'M04' },
        { namePrefix: 'T02' },
        { namePrefix: 'Phomemo' },
      ],
      optionalServices: UUID_CANDIDATES.map(u => u.service),
    });

    this.log(`Selected: ${device.name || device.id}`);
    device.addEventListener('gattserverdisconnected', () => {
      this.log('Disconnected.');
      this.writeChar = null;
    });

    const server = await device.gatt.connect();
    this.log('GATT connected. Probing services…');

    let writeChar = null;
    for (const { service, write } of UUID_CANDIDATES) {
      try {
        const svc = await server.getPrimaryService(service);
        const ch = await svc.getCharacteristic(write);
        writeChar = ch;
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
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.device = null;
    this.writeChar = null;
  }

  async write(bytes) {
    if (!this.writeChar) throw new Error('Not connected.');
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const useResponse = this.writeChar.properties.write; // prefer with-response if supported
    for (let i = 0; i < data.length; i += this.chunkSize) {
      const chunk = data.slice(i, i + this.chunkSize);
      if (useResponse) await this.writeChar.writeValueWithResponse(chunk);
      else await this.writeChar.writeValueWithoutResponse(chunk);
    }
  }

  // Reset / init the printer. Safe to call before each job.
  async init() {
    const INIT = new Uint8Array([
      0x1b, 0x40, // ESC @ — initialize
      0x1f, 0x11, 0x02, 0x04, // Phomemo print quality / density
    ]);
    await this.write(INIT);
  }

  // Feed `n` dot-lines after a print so the paper advances past the cutter line.
  async feed(n = 80) {
    const bytes = new Uint8Array([0x1b, 0x4a, Math.min(255, n)]);
    await this.write(bytes);
  }

  // Send a monochrome raster bitmap.
  //   bitmap: Uint8Array of packed bits, MSB-first.
  //   widthDots: width of each row in dots (must be a multiple of 8).
  //   heightDots: number of rows (bitmap.length must equal heightDots * widthDots / 8).
  //
  // We split tall images into bands because some firmwares choke on very
  // tall single raster commands.
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
