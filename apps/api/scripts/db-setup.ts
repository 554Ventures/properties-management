// One-shot database setup (deployment plan §4.2): migrate + generate + seed.
// Keeps the old `npm run db:setup` contract — works with no server running by
// booting the embedded Postgres just for the duration (data persists in
// prisma/pgdata for the next `db:serve` / `npm run dev`), or reuses an
// already-running one (db:serve, or any Postgres DATABASE_URL points at).
import { execSync } from 'node:child_process';
import path from 'node:path';
import {
  apiRoot,
  createEmbedded,
  ensureDatabase,
  initialiseIfNeeded,
  isListening,
  loadApiEnv,
  parseDatabaseUrl,
} from './pg';

loadApiEnv();
const target = parseDatabaseUrl(process.env.DATABASE_URL);
const databaseDir = path.join(apiRoot, 'prisma', 'pgdata');

const alreadyRunning = await isListening(target);
const pg = alreadyRunning ? null : createEmbedded(target, { databaseDir, persistent: true });

if (pg) {
  await initialiseIfNeeded(pg, databaseDir);
  await pg.start();
  await ensureDatabase(pg, target.database);
  console.log(`[db:setup] started embedded Postgres on ${target.host}:${target.port}`);
} else {
  console.log(`[db:setup] using running Postgres on ${target.host}:${target.port}`);
}

const run = (cmd: string) => execSync(cmd, { cwd: apiRoot, stdio: 'inherit' });

try {
  run('npx prisma migrate deploy');
  run('npx prisma generate');
  run('npx tsx prisma/seed.ts');
} finally {
  if (pg) {
    await pg.stop();
    console.log('[db:setup] stopped embedded Postgres (data kept in prisma/pgdata)');
  }
}
