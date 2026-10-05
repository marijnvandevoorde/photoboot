import { defineConfig } from 'vitest/config';

// Unit + server tests. DOM-dependent files opt into happy-dom with a
// `// @vitest-environment happy-dom` comment; the rest run in plain Node.
// Canvas drawing isn't available in happy-dom, so the image pipeline is
// covered by the browser e2e test (npm run test:e2e).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    environment: 'node',
  },
});
