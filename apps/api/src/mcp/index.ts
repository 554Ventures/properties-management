// 554 Properties MCP server factory (ARCHITECTURE §7). Backs both surfaces:
// the stdio entrypoint (./stdio.ts, `npm run mcp -w apps/api`) and the remote
// Streamable HTTP route (routes/mcp.ts), which builds one server per request
// from the caller's own account and permissions.
//
// This module must stay free of import-time side effects: routes/mcp.ts pulls
// it into the API server bundle, so anything that runs (or throws) at import
// takes the whole API down at boot. The stdio entrypoint lives in ./stdio.ts
// for exactly that reason — when bundled, `process.argv[1]` and
// `import.meta.url` both point at dist/server.js, so an "am I the entrypoint?"
// guard here would evaluate true inside the API process and start a stdio
// server against a demo account production does not have.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMcpResources } from './resources';
import { registerMcpTools } from './tools';

const here = path.dirname(fileURLToPath(import.meta.url));

// `here` is src/mcp/ when running from source (dev, tests) but apps/api/dist/
// in the esbuild bundle, so apps/api/package.json sits two levels up in one
// layout and one level up in the other. Resolved lazily and never allowed to
// throw: this module is imported by routes/mcp.ts, so a top-level readFileSync
// that missed took down the whole API at boot — the container's runtime stage
// ships apps/api/package.json but no apps/package.json, so the src-relative
// path resolved to a file that does not exist there.
let cachedVersion: string | null = null;
function serverVersion(): string {
  if (cachedVersion) return cachedVersion;
  for (const rel of ['../../package.json', '../package.json']) {
    try {
      const parsed = JSON.parse(readFileSync(path.resolve(here, rel), 'utf8')) as {
        version?: string;
      };
      if (parsed.version) return (cachedVersion = parsed.version);
    } catch {
      // Wrong layout — try the next candidate.
    }
  }
  return (cachedVersion = '0.0.0');
}

export interface CreateMcpServerOptions {
  accountId: string;
  allowWrites: boolean;
  /** Tool names to leave unregistered for this caller — the remote surface
   *  passes `deniedWriteTools(role, permissions)` so a member can't reach a
   *  write tool their REST route would refuse. Stdio omits it (owner-equivalent). */
  deniedTools?: Set<string>;
}

/** Build the server without connecting a transport (tests pass options directly). */
export function createMcpServer({
  accountId,
  allowWrites,
  deniedTools,
}: CreateMcpServerOptions): McpServer {
  const server = new McpServer({ name: 'hearth', version: serverVersion() });
  registerMcpTools(server, { accountId, allowWrites, deniedTools });
  registerMcpResources(server, { accountId });
  return server;
}
