# Hearth

AI-native property management for independent landlords (4–15 properties). See [docs/PRD.md](docs/PRD.md) for full product requirements and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the implementation plan.

## Structure

| Path | What it is |
|---|---|
| `packages/shared` | Zod schemas + TypeScript types — the API contract, consumed by both api and web |
| `apps/api` | Fastify REST API, Prisma (SQLite dev), service layer, AI chat agent, MCP server entrypoint |
| `apps/web` | React + Vite + Tailwind frontend |

## Getting started

```bash
npm install
npm run db:setup     # create + seed the dev database
npm run dev          # api on :3001, web on :5173
```

The AI assistant runs in deterministic **mock mode** unless `ANTHROPIC_API_KEY` is set in `apps/api/.env`.

## MCP server

The same service layer is exposed as an MCP server:

```bash
npm run mcp --workspace apps/api    # stdio transport
```

Write tools (send reminder, categorize transaction, generate report) are disabled unless `MCP_ALLOW_WRITES=true`.
