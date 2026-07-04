// MCP tool surface (ARCHITECTURE §7): thin wrapper over the shared service-tool
// registry in ai/tools.ts. Only `serviceTools` is exposed — the four render/ask
// tools (render_chart, render_table, propose_action, ask_user_question) are
// chat-UI concerns and never appear on this surface (PRD §10 non-goal).
// Write tools register only when allowWrites (HEARTH_MCP_ENABLE_WRITE, read in
// index.ts) is set.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { serviceTools } from '../ai/tools';

/**
 * Audit coverage per write tool lives in the services (each audits its own
 * action — transaction.created, rent_payment.recorded, report.generated,
 * report.emailed, insight.dismissed, …). The MCP layer only supplies the
 * actor ('system': a machine client invoked the tool) so nothing double-logs.
 */
export interface McpToolOptions {
  accountId: string;
  allowWrites: boolean;
}

export function registerMcpTools(server: McpServer, { accountId, allowWrites }: McpToolOptions): void {
  for (const tool of serviceTools) {
    if (tool.write && !allowWrites) continue;
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: unknown) => {
        // Re-parse to apply zod defaults/stripping regardless of SDK version.
        const input = tool.inputSchema.parse(args ?? {});
        const result = await tool.execute(accountId, input, 'system');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    );
  }
}
