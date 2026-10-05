/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Server the app talks to for sharing and events (default: the public booth).
  readonly VITE_SERVER_URL?: string;
}
