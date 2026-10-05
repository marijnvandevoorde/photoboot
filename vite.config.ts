import { type Plugin, defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { shareMiddleware } from './server/share.ts';

// Mount the share routes (/api/share, /share/{uuid}.jpg) on the dev and
// preview servers so the QR flow works locally, not just in production.
const shareRoutes: Plugin = {
  name: 'photoboot-share',
  configureServer(server) {
    server.middlewares.use(shareMiddleware);
  },
  configurePreviewServer(server) {
    server.middlewares.use(shareMiddleware);
  },
};

// PHOTOBOOT_LOCAL=1 (print.sh): plain HTTP on localhost only. localhost is a
// secure context, so camera/Bluetooth still work without a cert warning.
const local = process.env.PHOTOBOOT_LOCAL === '1';

export default defineConfig({
  plugins: local ? [shareRoutes] : [basicSsl(), shareRoutes],
  // HTTPS comes from basicSsl() unless PHOTOBOOT_LOCAL is set.
  server: {
    host: local ? 'localhost' : true,
    port: 5173,
  },
  build: {
    rollupOptions: {
      input: {
        booth: 'index.html',
        test: 'test.html',
        print: 'print.html',
        settings: 'settings.html',
        preview: 'preview.html',
      },
    },
  },
});
