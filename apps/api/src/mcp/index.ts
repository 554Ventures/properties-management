// 554 Properties MCP server entrypoint (ARCHITECTURE §7) — stdio transport.
// Run: `npm run mcp -w apps/api`. Same demo account and service layer as the
// REST API; write tools are gated behind HEARTH_MCP_ENABLE_WRITE=true.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getDemoAccountId } from '../plugins/auth';
import { registerMcpResources } from './resources';
import { registerMcpTools } from './tools';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(here, '../../package.json'), 'utf8')) as {
  version: string;
};

export interface CreateMcpServerOptions {
  accountId: string;
  allowWrites: boolean;
}

/** Build the server without connecting a transport (tests pass options directly). */
export function createMcpServer({ accountId, allowWrites }: CreateMcpServerOptions): McpServer {
  const server = new McpServer({ name: 'hearth', version: pkg.version });
  registerMcpTools(server, { accountId, allowWrites });
  registerMcpResources(server, { accountId });
  return server;
}

async function main(): Promise<void> {
  // Resolve the seeded demo account once at startup (same lookup as plugins/auth.ts).
  const accountId = await getDemoAccountId();
  const allowWrites = process.env.HEARTH_MCP_ENABLE_WRITE === 'true';
  const server = createMcpServer({ accountId, allowWrites });
  await server.connect(new StdioServerTransport());
  // stdout is the JSON-RPC channel — human output goes to stderr only.
  console.error(`hearth MCP server ready on stdio (write tools ${allowWrites ? 'ENABLED' : 'disabled'})`);
}

// Only start stdio when run as the entrypoint (tests import createMcpServer).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
