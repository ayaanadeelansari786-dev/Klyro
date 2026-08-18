import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The database suite boots a real Postgres per file and runs from
    // `vitest.db.config.ts` instead. See `npm run test:db`.
    exclude: ['tests/db/**'],
    // Every test drives a stubbed fetch. A test that reaches the real network
    // is a test that fails in CI on someone else's bad day, so the stub throws
    // on anything it was not given a fixture for.
    restoreMocks: true,
  },
});
