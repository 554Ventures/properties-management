// Vitest global setup (deployment plan §4.2): boot a throwaway embedded
// Postgres in a temp dir, apply the real migrations, and run the real seed
// script. The connection string here must match the static DATABASE_URL in
// vitest.config.ts (the workers read it from there). Teardown stops the
// cluster; the temp data dir is discarded (persistent: false).
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apiRoot, createEmbedded, ensureDatabase, parseDatabaseUrl } from '../../../scripts/pg';
import { TEST_DATABASE_URL } from './test-db-url';

export default async function setup(): Promise<() => Promise<void>> {
  const target = parseDatabaseUrl(TEST_DATABASE_URL);
  const pg = createEmbedded(target, {
    databaseDir: mkdtempSync(path.join(tmpdir(), 'hearth-test-pg-')),
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await ensureDatabase(pg, target.database);

  const env = { ...process.env, DATABASE_URL: TEST_DATABASE_URL };
  execSync('npx prisma migrate deploy', { cwd: apiRoot, env, stdio: 'inherit' });
  execSync('npx tsx prisma/seed.ts', { cwd: apiRoot, env, stdio: 'inherit' });

  return async () => {
    await pg.stop();
  };
}
