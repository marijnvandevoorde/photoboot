// Where the booth runs: a browser, or the iOS / Android app (Capacitor).
// Import this first on every page; it wires up the native bits in the app.

import { Capacitor } from '@capacitor/core';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { nativeBle } from './printers/native.ts';
import { setTransport } from './printers/transport.ts';

export const isApp = Capacitor.isNativePlatform();
// The iOS app sells event galleries through Apple in-app purchase.
export const isIosApp = isApp && Capacitor.getPlatform() === 'ios';

// The app serves its pages from capacitor://localhost, so server calls
// (sharing, events) need the real server's origin. Browsers use their own.
const SERVER = import.meta.env.VITE_SERVER_URL ?? 'https://boot.small-victories.co';
export const apiBase = isApp ? SERVER : '';

if (isApp) setTransport(nativeBle);

// StoreKit hands over purchases that finish outside the buy button (Ask to
// Buy approved later, a purchase interrupted by a crash) at app start, on
// any page: keep them so settings can redeem them with the server.
if (isIosApp) void import('./purchase.ts').then((p) => p.watchTransactions());

// Keep the screen on. The app uses the native plugin; browsers the Wake
// Lock API (the booth handles that itself).
export async function keepScreenOn(): Promise<boolean> {
  if (!isApp) return false;
  await KeepAwake.keepAwake().catch(() => {});
  return true;
}
