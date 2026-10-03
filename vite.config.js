import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { shareMiddleware } from './server/share.js';

// Mount the share routes (/api/share, /share/{uuid}.jpg) on the dev and
// preview servers so the QR flow works locally, not just in production.
const shareRoutes = {
  name: 'photoboot-share',
  configureServer(server) {
    server.middlewares.use(shareMiddleware);
  },
  configurePreviewServer(server) {
    server.middlewares.use(shareMiddleware);
  },
};

export default defineConfig({
  plugins: [basicSsl(), shareRoutes],
  server: {
    https: true,
    host: true,
    port: 5173,
  },
  build: {
    rollupOptions: {
      input: {
        booth: 'index.html',
        test: 'test.html',
      },
    },
  },
});
