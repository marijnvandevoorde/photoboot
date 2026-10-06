// Kiosk lock + host PIN. Once the host starts the booth, this device
// remembers that it's running (and with which printer), so a refresh or an
// app restart goes straight back to the camera instead of the setup screen.
// Getting out — settings, another printer, back to setup — needs the PIN
// when one is set. Stopping the booth (host menu or settings) clears it.
//
// Like the PIN itself this stops curious guests, not attackers: the real
// lock is the OS (iPad Guided Access, Android app pinning).

import type { Config } from './config.ts';
import type { SavedPrinter } from './printers/index.ts';

const KIOSK_KEY = 'photoboot:kiosk';
// sessionStorage: the PIN was entered in this tab. The booth clears it on
// start, so walking away from settings locks them again.
const ADMIN_OK_KEY = 'photoboot:admin-ok';

export interface KioskState {
  since: string; // ISO time the host started the booth
  printer: SavedPrinter | null; // null = started without printer
}

function validPrinter(p: unknown): SavedPrinter | null {
  const { id, name, type } = (p ?? {}) as Partial<SavedPrinter>;
  return typeof id === 'string' && id ? { id, name: String(name ?? ''), type: String(type || 'auto') } : null;
}

export function kioskState(): KioskState | null {
  try {
    const state = JSON.parse(localStorage.getItem(KIOSK_KEY) ?? 'null');
    if (typeof state?.since !== 'string') return null;
    return { since: state.since, printer: validPrinter(state.printer) };
  } catch {
    return null;
  }
}

export function lockKiosk(printer: SavedPrinter | null, now = new Date()): KioskState {
  const state = { since: now.toISOString(), printer };
  try {
    localStorage.setItem(KIOSK_KEY, JSON.stringify(state));
  } catch {
    /* storage off: the booth just won't survive a reload */
  }
  return state;
}

export function unlockKiosk() {
  try {
    localStorage.removeItem(KIOSK_KEY);
  } catch {
    /* ignore */
  }
}

// ---------- PIN ----------

type PinConfig = Pick<Config, 'adminPasswordHash' | 'adminPassword'>;

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const pinHash = (pin: string) => sha256(`photoboot:${pin}`);

export const hasPin = (config: PinConfig) => !!(config.adminPasswordHash || config.adminPassword);

export async function checkPin(config: PinConfig, pin: string): Promise<boolean> {
  if (config.adminPasswordHash) return (await pinHash(pin)) === config.adminPasswordHash;
  return pin === config.adminPassword; // pre-hash configs
}

export function adminUnlocked(): boolean {
  try {
    return sessionStorage.getItem(ADMIN_OK_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAdminUnlocked(ok: boolean) {
  try {
    if (ok) sessionStorage.setItem(ADMIN_OK_KEY, '1');
    else sessionStorage.removeItem(ADMIN_OK_KEY);
  } catch {
    /* ignore */
  }
}
