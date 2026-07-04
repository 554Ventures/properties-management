// Single definition of the test database connection string, imported by both
// vitest.config.ts (worker env) and the global setup (cluster boot). Port 5434
// deliberately differs from the dev default (5433) so tests never touch dev
// data; override with HEARTH_TEST_DATABASE_URL if 5434 is taken.
export const TEST_DATABASE_URL =
  process.env.HEARTH_TEST_DATABASE_URL ?? 'postgresql://hearth:hearth@127.0.0.1:5434/hearth_test';
