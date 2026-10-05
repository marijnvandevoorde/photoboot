import type { CapacitorConfig } from '@capacitor/cli';

// The iOS / Android app bundles the built booth (dist/) and talks to the
// public server for sharing and events (VITE_SERVER_URL, see platform.ts).
const config: CapacitorConfig = {
  appId: 'co.smallvictories.photoboot',
  appName: 'Photoboot',
  webDir: 'dist',
  ios: {
    contentInset: 'never',
    backgroundColor: '#000000',
  },
  plugins: {
    BluetoothLe: {
      displayStrings: {
        scanning: 'Looking for printers…',
        cancel: 'Cancel',
        availableDevices: 'Printers nearby',
        noDeviceFound: 'No printer found. Is it switched on?',
      },
    },
  },
};

export default config;
