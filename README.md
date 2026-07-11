# Hearth

AI-native property management for independent landlords (4–15 properties). See [docs/PRD.md](docs/PRD.md) for full product requirements and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the implementation plan.

## Structure

| Path | What it is |
|---|---|
| `packages/shared` | Zod schemas + TypeScript types — the API contract, consumed by both api and web |
| `apps/api` | Fastify REST API, Prisma/Postgres (embedded Postgres for dev/tests), service layer, AI chat agent, MCP server entrypoint |
| `apps/web` | React + Vite + Tailwind frontend |
| `apps/mobile` | iOS Capacitor shell (remote-URL mode — loads the deployed web app; [docs/MOBILE.md](docs/MOBILE.md)) |

## Getting started

```bash
npm install
npm run db:setup     # create + seed the dev database
npm run dev          # api on :3001, web on :5173
```

The AI assistant runs in deterministic **mock mode** unless `ANTHROPIC_API_KEY` is set in `apps/api/.env`.

## MCP server

The same service layer is exposed as an MCP server (server name `hearth`):

```bash
npm run mcp --workspace apps/api    # stdio transport
```

Read tools (portfolio summary, KPIs, properties, tenants, rent status, transactions, insights, reports) and resources (`hearth://portfolio/summary`, `hearth://properties[/{id}]`, `hearth://rent/{period}`, `hearth://reports[/{id}]`, `hearth://insights/active`) are always available. Write tools (create/confirm transaction, record rent payment, send reminders, generate/email report, dismiss insight) are registered only when `HEARTH_MCP_ENABLE_WRITE=true`; every write is audit-logged.

### Connect from Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "hearth": {
      "command": "npm",
      "args": ["run", "mcp", "-w", "apps/api"],
      "cwd": "/absolute/path/to/PropertiesAI",
      "env": { "HEARTH_MCP_ENABLE_WRITE": "false" }
    }
  }
}
```

Run `npm run db:setup` first — the server resolves the seeded demo account at startup.
