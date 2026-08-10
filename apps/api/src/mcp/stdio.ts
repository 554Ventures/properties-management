// Stdio MCP entrypoint (ARCHITECTURE §7) — `npm run mcp -w apps/api`.
// Local single-user: the seeded demo account, with write tools behind
// HEARTH_MCP_ENABLE_WRITE=true. The remote connector (routes/mcp.ts) resolves
// a real user per request instead.
//
// Deliberately a separate file from ./index.ts, which routes/mcp.ts imports
// into the API server bundle: this file is the only place allowed to have
// start-a-server side effects, and nothing in the API imports it.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './index';
import { getDemoAccountId } from '../plugins/auth';

const accountId = await getDemoAccountId();
const allowWrites = process.env.HEARTH_MCP_ENABLE_WRITE === 'true';
const server = createMcpServer({ accountId, allowWrites });
await server.connect(new StdioServerTransport());
// stdout is the JSON-RPC channel — human output goes to stderr only.
console.error(
  `hearth MCP server ready on stdio (write tools ${allowWrites ? 'ENABLED' : 'disabled'})`,
);
