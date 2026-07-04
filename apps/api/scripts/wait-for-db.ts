// Blocks until the database DATABASE_URL points at accepts connections, so
// `npm run dev` can start db+api+web in parallel without a boot race.
import { isListening, loadApiEnv, parseDatabaseUrl } from './pg';

loadApiEnv();
const target = parseDatabaseUrl(process.env.DATABASE_URL);

const deadline = Date.now() + 30_000;
while (!(await isListening(target))) {
  if (Date.now() > deadline) {
    console.error(
      `[wait-for-db] nothing listening on ${target.host}:${target.port} after 30s — ` +
        'start the database with `npm run db:serve -w apps/api` (or `npm run db:setup` first).',
    );
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 250));
}
