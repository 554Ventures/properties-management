# Property App — Deployment Plan

**Status:** Revised after codebase audit (2026-07-03)
**Team model:** Small team (owner + a few collaborators)
**Phase 1 scope:** Web app only. Mobile is explicitly deferred to Phase 2.

---

## 1. Goals & Constraints

- Ship a **staging + production** pipeline, not just a single prod push.
- Use only the accounts already in hand: **Cloudflare, Supabase, GitHub, Anthropic**. No new vendors unless there's a hard blocker.
- Backend is **Node/TypeScript (Fastify) + Prisma**, currently on SQLite, moving to cloud Postgres.
- Small team — pipeline should be simple enough that one person can safely deploy, but should still block bad merges (CI gates, environment protection).
- Mobile is out of scope for this plan; the architecture below should not preclude adding a mobile client later (the API is already client-agnostic — REST + SSE, no server-rendered views).

---

## 2. Infrastructure Map

| Layer | Service | Notes |
|---|---|---|
| DNS / CDN / WAF | Cloudflare | Domain proxied through Cloudflare regardless of where compute lands |
| Frontend hosting | Cloudflare Pages | Static Vite build, preview deployments per PR |
| Backend/API compute | **Cloudflare Containers** (decided — see §3) | Fastify app in a container, fronted by a Worker |
| Database | Supabase (Postgres) | One project per environment (see §5) |
| Auth | Supabase Auth | Login/signup via supabase-js in the frontend; API verifies the JWT (see §4.1) |
| File storage | Supabase Storage | Future — no upload features exist yet beyond CSV import (held in memory) |
| AI / Chat | Anthropic API | Chat completions, tool use; MCP stays local-only in Phase 1 (see §8) |
| Source control / CI | GitHub + GitHub Actions | Monorepo; **no workflows exist yet — CI is built from scratch, see §6** |
| Secrets | GitHub Environments + Cloudflare/Supabase native secret stores | No secrets in repo, ever |

---

## 3. Backend Runtime: Cloudflare Containers (Decided)

**Decision: Cloudflare Containers, keeping the Fastify app intact.** (This reverses an earlier draft that chose Workers — the audit below explains why.)

The earlier Workers plan solved the wrong problem. It addressed Prisma-on-Workers (driver adapters, Hyperdrive) in detail, but the actual blocker is everything around Prisma:

- **The entire API is a Fastify app** (`apps/api/src/app.ts`) — routes, plugins (auth, SSE, multipart, zod-validation), error handling. Fastify does not run on Workers; the whole HTTP layer would need a rewrite to a fetch-handler framework (Hono or similar).
- **The daily scheduler is a `setInterval` in `server.ts`** — Workers isolates aren't long-lived processes.
- **Chat streams SSE over POST with a pausable/resumable agent loop** (state persisted in `ChatSession.providerStateJson`). Technically possible on Workers, but it's the invariant most at risk in a framework rewrite, and the existing test suite exercises Fastify, not a Worker.
- The Prisma-on-Workers path has documented rough edges (per-request client instantiation, pool-release errors on sequential queries) that simply don't exist on a real Node runtime.

On Containers, the migration is "Dockerfile + Postgres" instead of "rewrite the HTTP layer and re-verify the streaming/resume invariants." Same vendor, no new accounts.

**What Containers needs from us:**

- A **Dockerfile** and a real build step. The `start` script currently runs `tsx` (a dev runner); production should compile (`tsc` or esbuild) and run `node dist/server.js`. (§4.4)
- **Workers Paid plan** — Containers requires it. Accept the cost or fall back to Workers+Hono (below).
- **Database connection:** Prisma's standard client works as-is. Use Supabase's connection pooler (Supavisor) URL for runtime traffic — session mode, or transaction mode with `?pgbouncer=true` so Prisma disables prepared statements. Keep the **direct** connection string for migrations only (§6.1). No Hyperdrive needed.
- **Scheduler:** containers can scale to zero, which would silently stop the in-process `setInterval` daily jobs. Move the trigger out of the process: a **Cloudflare Cron Trigger** on the fronting Worker calls an internal endpoint (e.g. `POST /api/v1/internal/run-daily-jobs`, guarded by a shared secret header). The job logic stays in the service layer; only the trigger moves. This also survives container restarts and is observable in Cloudflare's dashboard.
- **Streaming:** containers stream responses through the fronting Worker natively — the SSE-over-POST protocol works unchanged.

**Documented alternative (not chosen): Workers + Hono rewrite.** If container pricing or cold-start behavior ever becomes a problem: rewrite `src/routes/*` and plugins on Hono, adopt `@prisma/adapter-pg` + Hyperdrive, instantiate PrismaClient per request, convert the scheduler to a `scheduled` handler. The service layer (`src/services/*`) is runtime-agnostic and ports unchanged — that's the escape hatch's real enabler. Budget: every route/plugin/test touched.

---

## 4. Code Readiness Workstreams (pre-deployment)

These are code changes the app needs before any public deploy, in dependency order. §§5–13 assume they're done.

### 4.1 Real authentication — **done (2026-07-04)** — was the launch blocker

Current "auth" (`src/plugins/auth.ts`) attaches the seeded demo account to every request, optionally gated by one shared `DEV_BEARER_TOKEN`. Deployed as-is, anyone on the internet is the demo landlord with write access. Nothing ships publicly before this workstream.

- Frontend: supabase-js with the anon key for signup/login/password-reset; it holds the session and attaches the Supabase JWT as `Authorization: Bearer` on every API call (replaces `VITE_DEV_BEARER_TOKEN` in `api/client.ts` and `api/sse.ts`).
- API: the auth plugin verifies the JWT (Supabase JWKS / JWT secret), maps the Supabase user id to an `Account` row, and sets `req.accountId`. New-user signup creates the `Account`.
- Schema: a `User` (or `supabaseUserId` on `Account`) mapping table — designed for "collaborators later" (one account, many users) even if v1 is 1:1.
- The service layer needs **no changes** — every function already takes `accountId` first. That contract is the tenancy model (see §11).

### 4.2 SQLite → Postgres — **done (2026-07-04)**

- Provider flipped to `postgresql`; baseline migration generated Postgres-shaped in `prisma/migrations` (the old `db push` flow is retired everywhere — dev uses `prisma migrate dev`, CI/prod use `prisma migrate deploy`).
- **Local dev/tests use an npm-managed embedded Postgres** (`embedded-postgres`, PG 17 to match Supabase's major) instead of docker-compose — no system install, `npm install` is still the only setup step. `npm run dev` boots db+api+web; `npm run db:setup` stays one-shot (boots the db itself if needed); the vitest global setup boots a throwaway cluster per run and applies the real migrations.
- **CI simplification:** no Postgres service container needed in §6 — `npm test` is self-contained.
- **Seeding:** the demo seed is dev/test-only. Production is **never** seeded with demo data; pinned-seed-number tests run against local/CI clusters only.
- String-enum columns deliberately stay Strings (`@hearth/shared` Zod enums remain the single source of truth); native Postgres enums are a possible later migration, not a launch item.

### 4.3 Scheduler multi-tenancy — **done (2026-07-04)**

Daily jobs (`services/jobs.service.ts`) iterate all accounts with per-account error isolation, and `POST /api/v1/internal/run-daily-jobs` (guarded by `CRON_SECRET`) is ready for the Cloudflare Cron Trigger per §3. Known nit: a brand-new empty account gets a $0 monthly review on the first run — consider skipping accounts with no transactions.

### 4.4 Production build — **done (2026-07-04)**

`npm run build -w apps/api` bundles the API with esbuild into `dist/server.js` (`@hearth/shared` inlined, `@prisma/client` external); `start` runs `node dist/server.js`. `apps/api/Dockerfile` (multi-stage, node:22-slim, non-root, healthcheck on `/api/v1/healthz`) builds from the repo root; Prisma `binaryTargets` pin engines for darwin (dev), linux-arm64 and linux-x64 (containers). Verified end-to-end: image + postgres:17 container, JWT auth, chat SSE streaming, cron endpoint, usage logs — all inside the container. Migrations are CI's job, never the container's.

### 4.5 Chat hardening — **done (2026-07-04)**

- **Token-usage logging**: every model call emits a `usage` provider event; the agent loop logs a structured `aiUsage` line (account, session, message, iteration, model, input/output tokens) through the request logger. Mock mode reports model `mock` with character-estimate counts so the pipeline is always exercised.
- **Rate limiting**: `@fastify/rate-limit` on the three turn-starting chat routes, keyed per account (IP fallback), `CHAT_RATE_LIMIT_MAX`/minute (default 30), 429s in the ApiError envelope. Auth endpoints live on Supabase (their rate limiting applies there); add the Cloudflare edge rule on `/api/v1/chat/*` at DNS setup time.

### 4.6 Config hygiene

- CORS origin is hardcoded to localhost in `app.ts` — make it env-driven. (With same-origin routing per §9 it's nearly moot in prod, but previews and local dev still need it.)
- Health endpoint already exists at **`/api/v1/healthz`** — use that path in smoke tests and uptime checks (not `/health`).

### 4.7 Known stubs — acknowledge, don't block on

- PDF export renders a plain-text placeholder (`lib/pdf.ts`) — labeled as such; swap in a real renderer post-launch.
- Plaid/Stripe/Docusign/email integrations are mocks behind adapter interfaces — fine to ship dark.
- Without `ANTHROPIC_API_KEY`, chat runs in deterministic mock mode — production sets the real key (§7); mock mode remains the dev/CI default.

---

## 5. Environment Strategy

**One environment for now: Production.** Staging is deliberately deferred — noted below as the main risk to accept consciously, with a clear path to add it later.

| Environment | Branch | Cloudflare env | Supabase project | Purpose |
|---|---|---|---|---|
| Production | `main` | Production (Pages + Container) | `property-app-prod` | Real users, real data — the only environment that exists |
| PR previews | any `feature/*` PR | Pages preview URL per PR (free) | **points at `property-app-prod`** | Visual/functional review before merge — see risk note |

Flow: `feature/*` → PR (CI + preview URL) → review → merge to `main` → deploy to production.

**Risk you're accepting:** PR preview builds call the production API and database. That's fine for read-heavy review and low-risk changes, but a bug in a preview build can act on real data. Mitigations even without full staging:
1. Code review specifically asks: "does this PR's preview build risk mutating real data if someone clicks around it?"
2. Migrations stay additive-only (§6.1) so a half-tested PR can't break the schema for everyone else.
3. Auth (§4.1) means preview users still only touch their own account's data — the accountId scoping applies to previews too.

**When to revisit:** the moment you have real user data you'd be unhappy to lose, or more than one person deploying independently, staging earns its keep. Adding it later: a second Supabase project, a `staging` branch, and a parallel GitHub Actions job — additive, not a rework.

---

## 6. CI/CD Pipeline (GitHub Actions)

**Status: the PR-gate workflow exists** (`.github/workflows/ci.yml`, added 2026-07-04): install → prisma generate → typecheck → tests (self-contained embedded Postgres) → web+API build → Docker image build. The merge-to-main deploy stage is a commented template in the same file, ready to enable once the Cloudflare/Supabase secrets exist. Monorepo layout (matches the repo):

```
/apps
  /web        (React + Vite frontend)
  /api        (Fastify backend)
/packages
  /shared     (Zod contract: API shapes, chat blocks, SSE events)
```

**Pipeline stages (on every PR):**
1. Install + cache dependencies (npm workspaces)
2. Typecheck (`npm run typecheck`) — all workspaces
3. Tests — self-contained: the API suite boots its own throwaway embedded Postgres (§4.2); web suite (vitest + jsdom + axe) as-is
4. Build (web `vite build`, API compile + Docker image build to validate the Dockerfile)
5. Deploy PR preview (Cloudflare Pages preview)
6. Post preview URL as a PR comment

**On merge to `main`:**
1. Require: all CI checks green via **required status checks** (branch protection). *Do not* require an approving review while solo — GitHub won't let you approve your own PR, so that rule would deadlock every merge. Add required reviewers when a second regular contributor exists.
2. Run `prisma migrate deploy` against `property-app-prod` (see §6.1 — with no staging buffer, treat every migration as if it's already in front of real users)
3. Deploy the API container to Cloudflare (wrangler)
4. Deploy the Pages build to production
5. Post-deploy smoke test: hit `/api/v1/healthz`, load the dashboard, confirm the chat endpoint responds
6. Tag the release (`vX.Y.Z`) for rollback reference

### 6.1 Migration Safety

- **Prisma Migrate**, run as `prisma migrate deploy` in CI — never `prisma migrate dev` outside a local machine (it can prompt interactively).
- Migrations run against the **direct Supabase connection string**, not the pooler — poolers are for runtime query traffic; schema changes need a direct connection.
- Migrations are **additive-first**: add columns/tables nullable, backfill, tighten constraints in a follow-up. Avoids a broken window where old code hits a new required column.
- Never drop a column/table in the same PR as the code that stops using it — two steps: (1) stop using it, deploy, (2) drop it later.
- With no staging environment, give production migrations a manual read before merge — `prisma migrate diff` locally is a cheap sanity check.

---

## 7. Secrets & Environment Variables

| Secret | Where it lives | Notes |
|---|---|---|
| Anthropic API key | Cloudflare container secret (via wrangler) | Set billing/usage alerts now (§13); CI does **not** need it — tests run in mock mode |
| Supabase JWT verification (JWKS URL / JWT secret) | Container secret / env | Used by the API auth plugin (§4.1) |
| Supabase anon/public key | Safe to embed in frontend build | Used by supabase-js for the auth flow only — all data access goes through the API |
| Supabase service role key | **Only if a server-side admin need arises** — container secret, never frontend | The API talks to Postgres via Prisma, not the Supabase data API, so this key may not be needed at all. Don't provision it "just in case." |
| `DATABASE_URL` (pooler) | Container secret | Runtime Prisma connection through Supavisor |
| `DATABASE_URL_DIRECT` | GitHub Actions secret | Direct connection, used only by the CI migration step |
| Internal cron secret | Container secret + Worker secret | Shared header guarding `POST /api/v1/internal/run-daily-jobs` (§3) |
| Cloudflare API token, Supabase access token | GitHub **Environment** secrets (`production` environment) | Environments (not plain repo secrets) so required reviewers can be added later without restructuring |

**Rule of thumb:** if a key can write data or cost money, it lives server-side only. Nothing sensitive in committed `.env` files — `.env.example` documents shape only (already the repo's convention).

---

## 8. AI Chatbot + MCP Layer

- **MCP stays local-only in Phase 1.** The MCP server is a stdio transport (`src/mcp/index.ts`) wrapping the same tool registry as chat — it's a local-process integration surface, not a deployable service. Exposing it remotely means adding a streamable-HTTP transport plus auth; defer until there's a concrete consumer. (Write tools stay gated by `HEARTH_MCP_ENABLE_WRITE`.)
- **Streaming:** SSE-over-POST works unchanged through the Worker → container path (§3).
- **Tool-use safety:** chat tools already route through the same service layer and `accountId` scoping as REST — no separate permission model to build, just make sure the chat routes sit behind the same auth plugin (§4.1). Write auditing (`AuditLog` actor attribution) is already in place and tested.
- **Cost control:** token-usage logging per §4.5.
- **Rate limiting:** per §4.5 — in-app on chat + auth endpoints, plus a Cloudflare edge rule on the chat path specifically.

---

## 9. Domain & DNS

1. Add the domain to Cloudflare (if not already).
2. Production: `app.yourdomain.com` → Cloudflare Pages production deployment.
3. API: same-origin — `app.yourdomain.com/api/*` routed to the Worker fronting the container. Avoids CORS in production entirely; the frontend already uses relative `/api/v1` paths, so no client changes needed.
4. When staging is added later, `staging.yourdomain.com` slots in without touching production records.

---

## 10. Monitoring & Observability

Minimum viable setup for launch (all within existing accounts or free tiers):
- Cloudflare Workers/Containers analytics + Pages analytics for request volume/errors/latency.
- Supabase dashboard for DB performance, slow queries, connection counts.
- Structured JSON logs from the API — Fastify's logger already does this; pipe to Cloudflare's log stream initially, with a note to add a proper sink (e.g. Logflare, native Supabase integration) if volume grows.
- Uptime check (Cloudflare's own or a free external one) hitting `/api/v1/healthz`.
- Token-usage logs (§4.5) reviewed during the post-launch window.

---

## 11. Security Model & Checklist

**Tenancy is enforced in the service layer, not by RLS.** The frontend never talks to Supabase's data API — every read/write goes through the Fastify API, and Prisma connects to Postgres as a privileged role where **RLS policies do not apply**. The actual isolation mechanism is the codebase's own binding convention: every service function takes `accountId` first, resolved from the verified JWT (§4.1). An earlier draft leaned on Supabase RLS as the primary control — that model fits apps where the browser holds an anon key and queries PostgREST directly, which this app deliberately doesn't do.

RLS can still be enabled on all tables as **defense in depth** (it protects against a leaked anon key or future direct-access features and costs little), but the thing to *verify* is accountId scoping through the API.

- [ ] Auth plugin rejects unauthenticated requests on every route except `/api/v1/healthz` (§4.1)
- [ ] **Cross-account isolation verified through the API**: with two real accounts, confirm account B cannot read or mutate account A's data via REST, chat tools, or action cards
- [ ] RLS enabled on all tables as defense-in-depth (with a note that Prisma bypasses it by design)
- [ ] Service role key not provisioned unless a concrete server-side need exists; never in any frontend bundle
- [ ] CORS locked to the actual frontend origin(s), env-driven (§4.6)
- [ ] Rate limiting on auth endpoints and the chat endpoint (§4.5)
- [ ] Internal cron endpoint rejects requests without the shared secret (§3)
- [ ] Dependency scanning enabled (GitHub Dependabot alerts, minimum)
- [ ] Secrets rotated on any team member offboarding
- [ ] Backups: confirm Supabase's automatic backup schedule/retention matches recovery needs; **test a restore once before launch**, not after an incident

---

## 12. Rollback Plan

- **Frontend:** Cloudflare Pages keeps prior deployments — rollback is re-promoting the previous one, near-instant.
- **API:** redeploy the prior tagged image / `wrangler rollback` on the fronting Worker.
- **Database:** additive-only migrations (§6.1) mean rollback is usually reverting code, not schema; destructive migrations always trail the code change by a release.
- **Trigger criteria** (fill in real thresholds once baselines exist): error-rate spike, P95 latency spike, auth-failure spike, or any data-integrity report.

---

## 13. Launch Checklist

- [ ] §4 workstreams complete — **auth (§4.1) is the hard gate; nothing deploys publicly before it**
- [ ] All CI checks green on `main`
- [ ] Cross-account isolation verified with a second, non-owner account in production (§11) — deliberately before real data piles up, since there's no staging
- [ ] Smoke test against production: sign up → create property/tenant/lease → chatbot interaction (real API key) → logout
- [ ] Demo seed confirmed **not** run against production
- [ ] Cron Trigger firing and daily-jobs endpoint verified (check for the monthly review report)
- [ ] DNS cutover plan confirmed (TTL lowered in advance if switching an existing domain)
- [ ] Rollback steps documented and mentally rehearsed
- [ ] Anthropic API billing alerts configured
- [ ] Supabase billing/usage alerts configured
- [ ] Cloudflare Workers Paid plan active (Containers requirement)
- [ ] Post-launch monitoring window planned (who watches dashboards + token-usage logs the first few hours)
- [ ] Known stubs acknowledged in whatever passes for release notes: PDF export is a placeholder, integrations are mocks (§4.7)

---

## 14. Decision Log

1. **Backend runtime** — Cloudflare Containers, keeping Fastify (§3). Reverses the earlier Workers decision: the audit showed the HTTP layer, scheduler, stdio MCP, and SSE/resume invariants all favor a Node runtime; Workers+Hono documented as the fallback.
2. **Migration tool** — Prisma Migrate (`migrate deploy` in CI against the direct connection). Baseline migration generated **after** the Postgres provider switch (§4.2), since no migrations directory exists yet.
3. **Same-origin API vs. subdomain** — same-origin (§9); frontend already uses relative paths.
4. **Tenancy enforcement** — service-layer `accountId` scoping as the primary control; RLS demoted to defense-in-depth (§11).
5. **Branch protection** — required status checks only while solo; required reviews added when a second contributor exists (§6).
6. **Collaborator access** — collaborators work through the owner; revisit if that changes.
7. **MCP exposure** — local-only (stdio) for Phase 1; remote transport deferred until a concrete consumer exists (§8).

### Open items

1. Accept Workers Paid plan cost for Containers (or consciously pick the Workers+Hono rewrite instead).
2. Container sizing/scale-to-zero settings — decide after first load testing; the cron design (§3) already assumes scale-to-zero is possible.
3. Auth detail: 1:1 user-per-account for v1, or build the `User ↔ Account` join now (§4.1 recommends designing the schema for many-users-per-account even if v1 behavior is 1:1).
