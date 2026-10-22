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
    //
    // ANTHROPIC_API_KEY is blanked for the same reason, and because the
    // failure is worse: every AI factory picks its client with a truthy check
    // on this var, so a real key in apps/api/.env silently flips the whole
    // suite onto the live API — slow, non-deterministic, and billed. CI has no
    // key, so this only ever bit a developer who had one configured. Tests
    // that need the real-client path still set it themselves (with the SDK
    // mocked); '' is falsy, so the default stays mock.
    env: { DATABASE_URL: TEST_DATABASE_URL, TZ: 'UTC', ANTHROPIC_API_KEY: '' },
    // One database shared by all test files — run them sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
