// MCP tool surface (ARCHITECTURE §7): thin wrapper over the shared service-tool
// registry in ai/tools.ts. Only `serviceTools` is exposed — the four render/ask
// tools (render_chart, render_table, propose_action, ask_user_question) are
// chat-UI concerns and never appear on this surface (PRD §10 non-goal).
// Write tools register only when allowWrites (HEARTH_MCP_ENABLE_WRITE, read in
// index.ts) is set.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { serviceTools } from '../ai/tools';
import { writeAudit } from '../services/audit.service';

/**
 * Audit coverage per write tool (checked in the services):
 * - create_transaction    → transactionService.create audits `transaction.created`
 * - confirm_transaction   → transactionService.confirm audits `transaction.confirmed`
 * - record_rent_payment   → rentService.recordPayment audits `rent_payment.recorded`
 * - send_rent_reminders   → rentService.sendReminders audits `rent.reminder_sent` per row
 * - generate_report       → reportService.generate audits `report.generated`
 * - dismiss_insight       → insightService.dismiss audits `insight.dismissed`
 * - email_report          → reportService.emailToAccountant audits NOTHING
 * So only email_report gets an MCP-level `mcp:<toolname>` row here — the rest
 * would double-log.
 */
const MCP_AUDIT_FALLBACK: Record<
  string,
  (input: unknown) => { entityType: string; entityId: string; detail?: unknown }
> = {
  email_report: (input) => {
    const { reportId, to } = input as { reportId: string; to: string };
    return { entityType: 'report', entityId: reportId, detail: { to } };
  },
};

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
        const result = await tool.execute(accountId, input);
        const auditFallback = tool.write ? MCP_AUDIT_FALLBACK[tool.name] : undefined;
        if (auditFallback) {
          await writeAudit(accountId, {
            actor: 'system',
            action: `mcp:${tool.name}`,
            ...auditFallback(input),
          });
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    );
  }
}
