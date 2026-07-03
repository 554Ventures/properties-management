import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    globalSetup: './src/__tests__/setup/global-setup.ts',
    // Fresh throwaway SQLite db per run (created + seeded by the global setup).
    env: { DATABASE_URL: 'file:./test.db' },
    // One SQLite file shared by all test files — run them sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
