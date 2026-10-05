// Common interface every printer backend must implement. The booth and
// print page talk to this, never to a concrete subclass.
//
// A backend owns its BLE device, caches the connection, and reports status
// through onLog / onDisconnect. Subclasses implement protocol specifics in
// `connect`, `attach`, `init`, `printRaster`, and `feed`.

export class PrinterBase {
  constructor({ onLog = () => {}, onDisconnect = () => {} } = {}) {
    this.onLog = onLog;
    this.onDisconnect = onDisconnect;
    this.device = null;
  }

  log(msg) {
    this.onLog(msg);
  }

  get connected() {
    return !!this.device?.gatt?.connected;
  }

  // Pick a device via the browser's device picker, then attach. Required.
  async connect() {
    throw new Error('connect() not implemented');
  }

  // Reconnect to the previously picked device without the picker. Required
  // for the booth's "stay with the same printer forever" behaviour.
  async reconnect() {
    if (!this.device) throw new Error('No printer selected yet.');
    await this.attach(this.device);
  }

  async attach(_device) {
    throw new Error('attach() not implemented');
  }

  async disconnect() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.device = null;
  }

  async init(_opts) {
    throw new Error('init() not implemented');
  }

  async feed(_n) {
    throw new Error('feed() not implemented');
  }

  // bitmap: Uint8Array packed MSB-first (1 = black dot).
  async printRaster(_bitmap, _widthDots, _heightDots) {
    throw new Error('printRaster() not implemented');
  }
}
