// Boot-time configuration guards (security remediation, docs/SECURITY_PRIVACY_AUDIT.md).
// Previously, two dangerous configurations only produced a console.warn and
// fell back to an insecure default; both now fail the boot instead, so a
// misconfigured production deploy crashes loudly at startup rather than
// silently running open or storing a bank credential in plaintext.
// Only called from src/server.ts (the real process entrypoint) — never from
// buildApp()/tests, so the test suite's demo-mode/mock-Plaid config is
// unaffected regardless of NODE_ENV.

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function countSet(vars: (string | undefined)[]): number {
  return vars.filter((v) => Boolean(v)).length;
}

/** plugins/auth.ts falls back to attaching the seeded demo account to every
 *  unauthenticated request when neither Supabase mode nor DEV_BEARER_TOKEN is
 *  configured — fine for local/offline demo, a full-write-access-to-anyone
 *  bug if it ever happened in production. */
function assertAuthConfigured(): void {
  const supabaseMode = Boolean(process.env.SUPABASE_JWT_SECRET || process.env.SUPABASE_URL);
  const devToken = Boolean(process.env.DEV_BEARER_TOKEN);
  if (!supabaseMode && !devToken) {
    throw new Error(
      'Refusing to start with NODE_ENV=production and no auth configured: set ' +
        'SUPABASE_JWT_SECRET or SUPABASE_URL (Supabase mode), or DEV_BEARER_TOKEN (demo mode). ' +
        'With neither set, every request is silently granted the seeded demo account\'s ' +
        'full read/write access with no credential check at all.',
    );
  }
}

/** integration.service.ts's encodeAccessToken silently stores the Plaid
 *  access token in plaintext when INTEGRATION_ENCRYPTION_KEY is unset; the
 *  factory already falls back to the mock adapter when the trio is partially
 *  set, but only via a console.warn easy to miss in production logs. Fail
 *  the boot instead so "connected" can never quietly mean "actually mock". */
function assertPlaidConfigured(): void {
  const vars = [
    process.env.PLAID_CLIENT_ID,
    process.env.PLAID_SECRET,
    process.env.INTEGRATION_ENCRYPTION_KEY,
  ];
  const setCount = countSet(vars);
  if (setCount > 0 && setCount < vars.length) {
    throw new Error(
      'Refusing to start with NODE_ENV=production and Plaid partially configured: ' +
        'PLAID_CLIENT_ID, PLAID_SECRET, and INTEGRATION_ENCRYPTION_KEY must be set together, ' +
        'or all left unset. Partial configuration previously fell back to the mock Plaid ' +
        'adapter silently (a console.warn only) — set all three (or none) before deploying.',
    );
  }
}

/** Runs every guard; a no-op outside NODE_ENV=production (local dev, CI,
 *  and the test suite — which never imports this module's caller — are
 *  unaffected). Throws with a message intended to be read directly off a
 *  crashed-container log line. */
export function assertProductionConfig(): void {
  if (!isProduction()) return;
  assertAuthConfigured();
  assertPlaidConfigured();
}
