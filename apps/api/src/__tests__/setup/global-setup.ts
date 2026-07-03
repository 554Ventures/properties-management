// Vitest global setup: push the schema into a fresh throwaway SQLite file and
// run the real seed script against it. The old file is deleted first (instead
// of `--force-reset`, which trips Prisma's destructive-action guard).
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export default function setup(): void {
  const env = { ...process.env, DATABASE_URL: 'file:./test.db' };
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    rmSync(path.join(apiRoot, 'prisma', `test.db${suffix}`), { force: true });
  }
  execSync('npx prisma db push --skip-generate', { cwd: apiRoot, env, stdio: 'inherit' });
  execSync('npx tsx prisma/seed.ts', { cwd: apiRoot, env, stdio: 'inherit' });
}
