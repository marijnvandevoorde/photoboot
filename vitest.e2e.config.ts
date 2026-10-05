import { defineConfig } from 'vitest/config';

// Browser end-to-end test: builds the app, runs the real server and drives
// headless Chrome with a fake camera and a stubbed Bluetooth printer.
// Needs Google Chrome (or CHROME_PATH); skipped when it isn't installed.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.test.ts'],
    globalSetup: ['test/e2e/build.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
