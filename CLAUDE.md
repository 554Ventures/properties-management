# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Hearth — AI-native property management app for independent landlords. npm-workspaces monorepo: `packages/shared` (Zod contract), `apps/api` (Fastify + Prisma/Postgres), `apps/web` (React + Vite + Tailwind). Local dev/tests run an npm-managed embedded Postgres (no Docker or system install); production points `DATABASE_URL` at Supabase.

## Docs that govern this repo

- `docs/PRD.md` — product requirements (what and why)
- `docs/ARCHITECTURE.md` — the implementation plan; its §4 derivation rules, §5 chat block/SSE protocol, and §10 seed spec are **binding**
- `docs/FEATURES.md` — inventory of what is already implemented (check before building "new" features)
- `docs/WHATS_NEXT.md` — prioritized roadmap of remaining work
- `docs/property-app-deployment-plan.md` — deployment architecture as shipped; `docs/ACCOUNT_SETUP.md` — how the provider accounts are wired

## Production

Live at **https://app.554properties.com** since 2026-07-04: one Cloudflare Worker (`wrangler.jsonc` + `deploy/worker.ts`) serves the web bundle as static assets and routes `/api/*` to the Fastify container; Supabase hosts Postgres + Auth. **Pushing to `main` deploys automatically** (CI `deploy` job: migrate → wrangler deploy → smoke test) — keep migrations additive-first. Deployment credentials live in the gitignored `.secrets.local`; production is never demo-seeded.

## Commands

```bash
npm run db:setup                      # migrate + seed dev database (required before first run; boots embedded Postgres itself)
npm run dev                           # db on :5433 + api on :3001 + web on :5173 together
npm run db:serve --workspace apps/api # dev Postgres alone (data in apps/api/prisma/pgdata)
npm run test --workspace apps/api    # backend suite (vitest; boots a throwaway embedded Postgres on :5434)
npm run test --workspace apps/web    # frontend suite (vitest + jsdom, incl. axe a11y tests)
npm run typecheck                     # all workspaces
npm run build                         # web bundle + API dist/server.js (esbuild)
npm run mcp --workspace apps/api     # MCP server over stdio
docker build -f apps/api/Dockerfile . # production API image (build from repo root)
npx vitest run src/__tests__/chat.test.ts        # single test file (run from the workspace dir)
npx vitest run -t "name substring"               # single test by name
```

The AI assistant runs in deterministic **mock mode** unless `ANTHROPIC_API_KEY` is set in `apps/api/.env` — the whole app demos offline with real seeded numbers. Env vars documented in `.env.example`.

## Architecture (the parts that span multiple files)

**Contract-first:** `packages/shared` is the single source of truth for every API shape, enum, chat content block, and SSE event. Both apps import from `@hearth/shared`; backend route tests `parse()` responses with the shared schemas, so a contract change is a test failure, not a runtime surprise. Treat the contract as frozen — extending it is fine, changing existing shapes requires updating both apps and their tests in the same change.

**One service layer, three adapters:** all business logic lives in `apps/api/src/services/*` (every function takes `accountId` first). Three thin surfaces call it:
1. REST routes (`src/routes/*`)
2. the chat agent loop (`src/ai/agent-loop.ts`) via the tool registry `src/ai/tools.ts`
3. the MCP server (`src/mcp/*`), which wraps **the same** `ai/tools.ts` registry (write tools gated by `HEARTH_MCP_ENABLE_WRITE`)

Never duplicate a business rule in a route/tool/component — fix it once in the service.

**Chat streaming:** chat endpoints stream SSE over POST (client uses `fetch` + ReadableStream, not EventSource — see `apps/web/src/api/sse.ts`). Protocol invariants: every stream ends with `message_complete` | `awaiting_input` | `error`; the `ask_user_question` tool pauses the turn (state persisted in `ChatSession.providerStateJson`, resume survives restart); the `/answer` resume stream re-emits `message_start` with the same messageId and continues the same block index space. Mock mode (`src/ai/mock-scripts.ts`) drives the identical loop with real tool execution; the composer's suggested prompts in `apps/web` are written to match those scripts.

**Write auditing:** every money/tenant-touching write logs to `AuditLog` with an actor — `user` (REST), `ai_suggested_user_confirmed` (user accepting an AI suggestion), or `system` (model- or MCP-invoked, and the scheduler). When adding a write path, thread the `actor` param through; tests assert attribution.

## Binding conventions

- **Money is integer cents** everywhere (`*Cents` fields); format only at the edge with `formatUsd`/`formatUsdWhole` from `@hearth/shared`.
- **No Prisma `enum` or `Decimal`** — enums are String columns validated by the shared Zod enums so `@hearth/shared` stays the single source of truth (native Postgres enums deliberately deferred; schema header comment explains). Money never uses `Decimal` (integer cents only).
- **Schema changes ship as migrations** (`prisma migrate dev --name ...` with the dev database running) — `db push` is no longer part of any flow; tests apply `prisma migrate deploy`, so an unmigrated schema change fails the suite.
- **Seed numbers are pinned:** dashboard/report tests assert exact figures from `apps/api/prisma/seed-constants.ts`. Changing seed data without updating the constants (and knowing why) breaks tests by design.
- **AI-authored content is always visually marked** in the web app via the single `AiSurface` wrapper; chart colors and all UI colors come only from `src/styles/tokens.css` design tokens — no ad hoc hex in components.
- **A11y is merge-blocking:** axe tests run in the web suite; status is never conveyed by color alone; charts require `title` + `description` and provide a "view as table" alternative.
- **Chat action cards execute only allowlisted API calls** (`apps/web/src/components/chat/actionAllowlist.ts`); blocked actions render disabled with a visible note. Extend the allowlist deliberately, never generically.
