// Remote MCP surface (ARCHITECTURE §7): the same tool/resource registry the
// stdio server exposes, reachable over Streamable HTTP so Claude Desktop can
// add it as a custom connector. Registered at the ROOT (not under /api/v1) —
// the connector URL is https://app.554properties.com/mcp.
//
// Stateless by design: one McpServer + transport per request, torn down when
// the response closes. The production container scales to zero (sleepAfter
// 15m, max_instances 1), so no session state could outlive a request anyway;
// stateless also means GET/DELETE have nothing to serve → 405.
//
// Authorization: the auth plugin has already resolved the bearer token to an
// account + role + permissions, so writes are enabled here and then narrowed
// by `deniedWriteTools` — the exact rule the chat agent applies, so a member
// cannot reach through an AI client to a write their REST route would refuse.
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { deniedWriteTools } from '../ai/tools';
import { createMcpServer } from '../mcp/index';

// Per-account limit on MCP calls (deployment plan §4.5) — a connector can loop
// tool calls far faster than a human, and each one hits the database.
function mcpRateLimit() {
  return {
    rateLimit: {
      max: Number(process.env.MCP_RATE_LIMIT_MAX ?? 120),
      timeWindow: '1 minute',
    },
  };
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  app.post('/mcp', { config: mcpRateLimit() }, async (req, reply) => {
    const server = createMcpServer({
      accountId: req.accountId,
      allowWrites: true,
      deniedTools: deniedWriteTools(req.userRole, req.userPermissions),
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    // The SDK writes the JSON-RPC response straight onto the Node response, so
    // Fastify must step out of the way and take back no part of the lifecycle.
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error(err, 'MCP request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
      }
      if (!reply.raw.writableEnded) {
        reply.raw.end(
          JSON.stringify({ error: { code: 'internal_error', message: 'Something went wrong' } }),
        );
      }
    }
  });

  // No server-initiated streams and no sessions to delete in stateless mode.
  // Clients treat 405 here as "SSE not offered" and carry on over POST.
  app.route({
    method: ['GET', 'DELETE'],
    url: '/mcp',
    handler: async (_req, reply) =>
      reply
        .code(405)
        .header('allow', 'POST')
        .send({
          error: { code: 'method_not_allowed', message: 'The MCP endpoint only accepts POST.' },
        }),
  });
}
