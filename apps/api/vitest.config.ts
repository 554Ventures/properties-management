import { defineConfig } from 'vitest/config';
import { TEST_DATABASE_URL } from './src/__tests__/setup/test-db-url';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    globalSetup: './src/__tests__/setup/global-setup.ts',
    // Throwaway embedded Postgres per run (booted + migrated + seeded by the
    // global setup; setup/test-db-url.ts defines the shared connection string).
    env: { DATABASE_URL: TEST_DATABASE_URL },
    // One database shared by all test files — run them sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
