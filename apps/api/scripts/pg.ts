// Shared helpers for the npm-managed embedded Postgres (deployment plan §4.2):
// parses DATABASE_URL so the connection string in .env stays the single source
// of truth for host/port/credentials, and builds configured EmbeddedPostgres
// instances. Production never touches this — DATABASE_URL points at Supabase
// and these scripts are dev/test-only.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface DbTarget {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
}

export function parseDatabaseUrl(url: string | undefined): DbTarget {
  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    throw new Error(
      `DATABASE_URL must be a postgres:// URL (got ${url ? JSON.stringify(url) : 'nothing'}). ` +
        'Copy .env.example to apps/api/.env — the SQLite file: URLs are gone (deployment plan §4.2).',
    );
  }
  const parsed = new URL(url);
  return {
    user: decodeURIComponent(parsed.username || 'hearth'),
    password: decodeURIComponent(parsed.password || 'hearth'),
    host: parsed.hostname || '127.0.0.1',
    port: Number(parsed.port || 5432),
    database: parsed.pathname.replace(/^\//, '') || 'hearth',
  };
}

/** Loads apps/api/.env into process.env (no-op if absent); existing vars win. */
export function loadApiEnv(): void {
  const envPath = path.join(apiRoot, '.env');
  if (!existsSync(envPath)) return;
  const before = { ...process.env };
  process.loadEnvFile(envPath);
  for (const [key, value] of Object.entries(before)) {
    if (value !== undefined) process.env[key] = value;
  }
}

export function createEmbedded(target: DbTarget, opts: { databaseDir: string; persistent: boolean }) {
  return new EmbeddedPostgres({
    databaseDir: opts.databaseDir,
    user: target.user,
    password: target.password,
    port: target.port,
    persistent: opts.persistent,
    // postgres writes routine chatter (checkpoints, shutdown notices) to
    // stderr as "LOG:" lines, which drowns real output around test runs;
    // filter those unless HEARTH_PG_VERBOSE=true. WARNING/ERROR/FATAL pass.
    onLog: process.env.HEARTH_PG_VERBOSE ? console.log : () => {},
    onError: (message) => {
      if (
        !process.env.HEARTH_PG_VERBOSE &&
        typeof message === 'string' &&
        (/ (LOG|HINT|DETAIL|STATEMENT): {2}/.test(message) || message.trim() === '')
      ) {
        return;
      }
      console.error(message);
    },
  });
}

/** True if something is already listening on the target host/port. */
export function isListening(target: DbTarget, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: target.host, port: target.port });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

/** Runs initdb only when the data dir isn't a cluster yet (initdb refuses
 * non-empty dirs, so a second run against prisma/pgdata must skip it). */
export async function initialiseIfNeeded(
  pg: InstanceType<typeof EmbeddedPostgres>,
  databaseDir: string,
): Promise<void> {
  if (existsSync(path.join(databaseDir, 'PG_VERSION'))) return;
  await pg.initialise();
}

/** Creates the target database if missing (embedded cluster only). Not via
 * pg.createDatabase(): on "already exists" that path leaks its client
 * connection, which then dies noisily when the cluster stops. */
export async function ensureDatabase(
  pg: InstanceType<typeof EmbeddedPostgres>,
  database: string,
): Promise<void> {
  const client = pg.getPgClient();
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (exists.rowCount === 0) {
      await client.query(`CREATE DATABASE ${client.escapeIdentifier(database)}`);
    }
  } finally {
    await client.end();
  }
}
