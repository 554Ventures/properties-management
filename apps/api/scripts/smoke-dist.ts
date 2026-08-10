// Boots the *built* artifact (dist/server.js) and waits for /healthz.
//
// Why this exists: the test suite imports TypeScript source, so it cannot see
// bugs that only appear in the esbuild bundle — where `import.meta.url` points
// at apps/api/dist/ instead of apps/api/src/<dir>/, breaking any module-level
// path resolution relative to it. Exactly that shipped once: mcp/index.ts read
// `../../package.json` at import time, which is apps/api/package.json from
// src/mcp/ but a nonexistent apps/package.json from dist/. It was harmless
// while that module was the stdio entrypoint only, and became a boot crash the
// moment routes/mcp.ts pulled it into the server bundle. `npm run build`
// succeeds either way — nothing ran the output.
//
// Runs against a throwaway embedded Postgres (same helper the tests use) in
// demo mode with the scheduler off; it only asserts the process *boots* and
// serves, not any behaviour the vitest suites already cover.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3098;
const TIMEOUT_MS = 30_000;

async function waitForHealthz(signal: () => string | null): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const died = signal();
    if (died) throw new Error(`server exited before serving /healthz:\n${died}`);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/healthz`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`/healthz did not respond within ${TIMEOUT_MS}ms`);
}

const entry = path.join(apiRoot, 'dist', 'server.js');
const child = spawn(process.execPath, [entry], {
  cwd: path.resolve(apiRoot, '../..'),
  env: {
    ...process.env,
    PORT: String(PORT),
    HEARTH_DISABLE_SCHEDULER: 'true',
    // Demo mode: no Supabase project needed. DATABASE_URL is inherited from the
    // caller (CI points it at the embedded Postgres); boot does not query it.
    NODE_ENV: 'development',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let exited: string | null = null;
child.stdout.on('data', (c: Buffer) => (output += c.toString()));
child.stderr.on('data', (c: Buffer) => (output += c.toString()));
child.on('exit', (code) => {
  exited = `exit code ${code}\n${output}`;
});

try {
  await waitForHealthz(() => exited);
  console.log(`✓ dist/server.js boots and serves /healthz on :${PORT}`);
  process.exitCode = 0;
} catch (err) {
  console.error(`✗ ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
}
