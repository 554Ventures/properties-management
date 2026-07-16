import { defineConfig } from 'vitest/config';
import { TEST_DATABASE_URL } from './src/__tests__/setup/test-db-url';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    globalSetup: './src/__tests__/setup/global-setup.ts',
    // Throwaway embedded Postgres per run (booted + migrated + seeded by the
    // global setup; setup/test-db-url.ts defines the shared connection string).
    // TZ='UTC' pins the process timezone (WS4): all period math takes an
    // explicit tz, so an accidental process-tz read surfaces as a test failure
    // rather than passing only because the CI box happened to be on UTC.
    env: { DATABASE_URL: TEST_DATABASE_URL, TZ: 'UTC' },
    // One database shared by all test files — run them sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
