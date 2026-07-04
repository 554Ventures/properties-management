// Long-running local dev database (deployment plan §4.2): starts the
// npm-managed embedded Postgres on whatever DATABASE_URL points at, with data
// persisted in prisma/pgdata (gitignored). Run via `npm run db:serve`, or let
// the root `npm run dev` start it alongside api+web. Ctrl-C stops it cleanly.
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

if (await isListening(target)) {
  console.log(`[db:serve] something is already listening on ${target.host}:${target.port} — reusing it.`);
  process.exit(0);
}

const databaseDir = path.join(apiRoot, 'prisma', 'pgdata');
const pg = createEmbedded(target, { databaseDir, persistent: true });

await initialiseIfNeeded(pg, databaseDir);
await pg.start();
await ensureDatabase(pg, target.database);
console.log(
  `[db:serve] Postgres ready on ${target.host}:${target.port}/${target.database} (data: prisma/pgdata). Ctrl-C to stop.`,
);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log('\n[db:serve] stopping Postgres…');
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
