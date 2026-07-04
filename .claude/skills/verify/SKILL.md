---
name: verify
description: How to boot and drive the Hearth API/web app for runtime verification — server launch per auth mode, JWT minting, SSE driving, cleanup.
---

# Verifying Hearth changes at runtime

## API (Fastify, apps/api)

Boot on a throwaway port so the dev server (3001) is untouched. `npx tsx src/server.ts` from `apps/api`; env comes from `apps/api/.env` plus overrides.

```bash
# demo mode (default): demo account attached to every request
PORT=3101 npx tsx src/server.ts

# Supabase mode: JWT required on every request
SUPABASE_JWT_SECRET='<any 32+ char string>' CRON_SECRET='<secret>' PORT=3102 npx tsx src/server.ts
```

Mint Supabase-shaped HS256 JWTs with the workspace's own `jose` (run from repo root so ESM resolution finds it):

```bash
node --input-type=module -e "
import { SignJWT } from 'jose';
const t = await new SignJWT({ email: 'x@verify.example', aud: 'authenticated' })
  .setProtectedHeader({ alg: 'HS256' }).setSubject('sub-verify-1')
  .setExpirationTime('1h').sign(new TextEncoder().encode('<same secret>'));
console.log(t);"
```

Flows worth driving: `GET /api/v1/healthz` (always open), `GET /api/v1/properties` with/without token, `POST /api/v1/internal/run-daily-jobs` with `x-cron-secret`, and chat SSE:

```bash
SID=$(curl -s -X POST :PORT/api/v1/chat/sessions -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{}' | jq -r .id)
curl -N -X POST :PORT/api/v1/chat/sessions/$SID/messages -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' -d '{"text":"How is rent collection going?"}' --max-time 20
```

Chat streams work offline (mock mode, no ANTHROPIC_API_KEY) and execute real tools — a fresh account answers with $0/0-units figures, which doubles as a tenancy-scoping check.

## Gotchas

- Supabase-mode requests **provision real rows** in `dev.db`. Use `@verify.example` emails / `sub-verify*` subs and delete them after:
  ```bash
  node --input-type=module -e "
  import { PrismaClient } from '@prisma/client';
  const p = new PrismaClient();
  await p.user.deleteMany({ where: { supabaseUserId: { startsWith: 'sub-verify' } } });
  await p.account.deleteMany({ where: { email: { endsWith: '@verify.example' } } });
  await p.\$disconnect();"   # run from apps/api
  ```
- A token whose email matches a user-less existing account (e.g. seeded `demo@hearth.app`) **links to it** by design.
- Scheduler runs once at boot; `HEARTH_DISABLE_SCHEDULER=true` to silence.
- Server binds 127.0.0.1 by default.

## Web (apps/web)

`npm run dev` from repo root serves web on :5173 proxying `/api` to :3001. Demo mode shows no login screen. The login screen only appears with `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` in `apps/web/.env.local` — driving it end-to-end needs a real Supabase project; without one, the Login component tests are the coverage.
