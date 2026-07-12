#!/bin/bash
# Fresh-account localhost testing (e.g. the onboarding flow, which never shows
# on the seeded demo account because its data derives every step completed).
#
# Boots a SECOND dev stack that authenticates as "Test User"
# (test-user@local.test) — a brand-new empty account, provisioned on first
# request by the API's Supabase-mode first-login path:
#   - API on  http://localhost:3101  (Supabase mode, local-only JWT secret)
#   - Web on  http://localhost:5184  (proxies /api to :3101)
#
# The normal demo stack (npm run dev → :5173/:3001) is untouched; run both
# side by side. Requires the dev Postgres (npm run dev, or
# npm run db:serve --workspace apps/api).
#
#   bash scripts/dev-test-user.sh           # start (reuses the account)
#   bash scripts/dev-test-user.sh --reset   # wipe Test User first for a clean run
#
# Ctrl-C stops both servers. The account and its data live in the dev database
# (apps/api/prisma/pgdata) until you --reset.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SECRET='local-test-user-secret-0123456789abcdef0123456789abcdef'
EMAIL='test-user@local.test'
API_PORT=3101
WEB_PORT=5184

if [ "${1:-}" = "--reset" ]; then
  echo "[test-user] deleting $EMAIL (cascades its whole portfolio)…"
  (cd "$REPO/apps/api" && node --input-type=module -e "
    import { PrismaClient } from '@prisma/client';
    const p = new PrismaClient();
    const users = await p.user.deleteMany({ where: { supabaseUserId: 'sub-local-test-user' } });
    const accounts = await p.account.deleteMany({ where: { email: '$EMAIL' } });
    console.log('[test-user] removed', users.count, 'user(s),', accounts.count, 'account(s)');
    await p.\$disconnect();")
fi

TOKEN=$(cd "$REPO" && node --input-type=module -e "
  import { SignJWT } from 'jose';
  const t = await new SignJWT({ email: '$EMAIL', aud: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject('sub-local-test-user')
    .setExpirationTime('12h').sign(new TextEncoder().encode('$SECRET'));
  console.log(t);")

API_PID=""
if lsof -ti ":$API_PORT" >/dev/null 2>&1; then
  echo "[test-user] something already listening on :$API_PORT — reusing it."
else
  (cd "$REPO/apps/api" && SUPABASE_JWT_SECRET="$SECRET" HEARTH_DISABLE_SCHEDULER=true \
    PORT=$API_PORT npx tsx src/server.ts) &
  API_PID=$!
fi
trap '[ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true' EXIT

echo "[test-user] web → http://localhost:$WEB_PORT (signed in as $EMAIL, api on :$API_PORT)"
(cd "$REPO/apps/web" && VITE_DEV_BEARER_TOKEN="$TOKEN" \
  HEARTH_API_PROXY="http://localhost:$API_PORT" npx vite --port $WEB_PORT)
