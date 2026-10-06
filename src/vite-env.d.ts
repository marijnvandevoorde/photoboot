/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Server the app talks to for sharing and events (default: the public booth).
  readonly VITE_SERVER_URL?: string;
  // App Store product id of the event gallery consumable (iOS in-app purchase).
  readonly VITE_APPLE_PRODUCT_ID?: string;
}
