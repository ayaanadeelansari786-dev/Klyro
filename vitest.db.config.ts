import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The database suite, run separately from `npm test`.
 *
 * It is separate for one reason: it is slow. Each file boots a Postgres and
 * replays every migration, which costs seconds rather than milliseconds. The
 * unit suite is meant to be run constantly while editing; this one is run
 * before anything touching the schema, its policies, or the routes that read
 * them.
 *
 * Slow is not the same as optional. These are the only tests that can prove a
 * user cannot read another user's assessment.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/db/**/*.test.ts'],
    // Booting Postgres and replaying the migrations dominates; give it room.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
