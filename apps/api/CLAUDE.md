# CLAUDE.md — apps/api

Workspace-specific rules; the root CLAUDE.md and `docs/ARCHITECTURE.md` govern overall.

## Layout

- `src/services/` — all business logic; functions take `accountId` first, optional trailing `actor` on audited writes
- `src/routes/` — thin Fastify handlers; validate with `@hearth/shared` schemas via `plugins/zod-validation.ts`
- `src/ai/` — agent loop, tool registry (`tools.ts` — shared with MCP), Anthropic + mock clients, scripts
- `src/mcp/` — stdio MCP entrypoint wrapping `ai/tools.ts` (`createMcpServer({accountId, allowWrites})` for tests)
- `src/integrations/` — adapter interfaces + mock impls (Plaid/Stripe/Docusign/email); real impls replace mocks 1:1
- `prisma/seed.ts` + `prisma/seed-constants.ts` — the demo portfolio; tests assert these exact numbers

## Rules

- **SQLite:** no Prisma `enum`, no `Decimal` (schema header enforces by convention). Enum columns are Strings validated by shared Zod enums. No `createMany({skipDuplicates})` — catch P2002 and re-read instead (see `rent.service.ts` materialization).
- **Adding a chat/MCP tool:** add it to `src/ai/tools.ts` only (name, description stating side effects plainly, zod inputSchema, execute binding, `write` flag). Chat and MCP both pick it up; MCP excludes the four render/ask tools automatically.
- **Writes must audit:** call `audit.service` with the right actor; model/MCP/scheduler-invoked writes are `'system'`. The mock-mode tests and `mcp.test.ts` assert attribution.
- **Agent loop invariants:** every SSE stream ends with a terminal event even on error (the `guarded` wrapper); pending text is flushed into persisted blocks on failure; `ask_user_question` pauses by persisting `providerStateJson` and must remain resumable after process restart (tested by rebuilding the app between send and answer).
- **Mock scripts** (`ai/mock-scripts.ts`) are regex-keyed, generator-style (they react to tool results), and must execute real tools so figures come from the DB. If you change them, keep the web composer's suggested prompts in sync.
- **Route ordering:** static segments before parameterized (`/transactions/review` before `/transactions/:id`).
- **Tests:** suite seeds a throwaway `prisma/test.db` via global setup and runs files sequentially (one shared SQLite file). Don't use `prisma db push --force-reset` (blocked for agents) — delete the db file and push.
- Dev server binds `127.0.0.1` (HOST env to override). Scheduler disabled with `HEARTH_DISABLE_SCHEDULER=true` (tests do this).
