// MCP server (ARCHITECTURE §7): real in-process client ↔ server over a linked
// transport pair against the seeded test DB. Write gating is passed as a
// factory option (env is only read in mcp/index.ts main), so no process.env
// mutation is needed here.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXPENSES_MTD_CENTS,
  NET_CASHFLOW_MTD_CENTS,
  OKAFOR_DAYS_LATE,
  OKAFOR_NAME,
  PAID_UNITS,
  TOTAL_UNITS,
} from '../../prisma/seed-constants';
import { prisma } from '../lib/prisma';
import { createMcpServer } from '../mcp/index';
import { getDemoAccountId } from '../plugins/auth';

const open: Array<{ close(): Promise<void> }> = [];

async function connectClient(allowWrites: boolean): Promise<Client> {
  const accountId = await getDemoAccountId();
  const server = createMcpServer({ accountId, allowWrites });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hearth-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  open.push(client, server);
  return client;
}

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function callToolJson(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  expect(result.isError ?? false).toBe(false);
  expect(result.content[0]?.type).toBe('text');
  return JSON.parse(result.content[0]!.text) as any;
}

const WRITE_TOOLS = [
  'create_transaction',
  'confirm_transaction',
  'record_rent_payment',
  'send_rent_reminders',
  'generate_report',
  'email_report',
  'dismiss_insight',
];
const RENDER_TOOLS = ['render_chart', 'render_table', 'propose_action', 'ask_user_question'];

describe('MCP server', () => {
  it('lists only read tools when writes are disabled', async () => {
    const client = await connectClient(false);
    const names = (await client.listTools()).tools.map((t) => t.name);

    expect(names).toContain('get_portfolio_summary');
    expect(names).toContain('get_dashboard_kpis');
    expect(names).toContain('get_rent_status');
    expect(names).toContain('list_properties');
    expect(names).toContain('list_transactions');
    for (const name of WRITE_TOOLS) expect(names).not.toContain(name);
    for (const name of RENDER_TOOLS) expect(names).not.toContain(name);
  });

  it('lists write tools when allowWrites is on (HEARTH_MCP_ENABLE_WRITE)', async () => {
    const client = await connectClient(true);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of WRITE_TOOLS) expect(names).toContain(name);
    for (const name of RENDER_TOOLS) expect(names).not.toContain(name);
  });

  it('get_dashboard_kpis returns the pinned seed figures as JSON', async () => {
    const client = await connectClient(false);
    const kpis = await callToolJson(client, 'get_dashboard_kpis');
    expect(kpis.netCashFlowMtdCents).toBe(NET_CASHFLOW_MTD_CENTS); // 845000
    expect(kpis.expensesMtdCents).toBe(EXPENSES_MTD_CENTS); // 311000
    expect(kpis.paidUnits).toBe(PAID_UNITS);
    expect(kpis.totalUnits).toBe(TOTAL_UNITS);
  });

  it('get_rent_status includes the Okafor late row', async () => {
    const client = await connectClient(false);
    const tracker = await callToolJson(client, 'get_rent_status');
    const okafor = tracker.rows.find((r: { tenantName: string }) => r.tenantName === OKAFOR_NAME);
    expect(okafor).toBeDefined();
    expect(okafor.status).toBe('late');
    expect(okafor.daysLate).toBe(OKAFOR_DAYS_LATE);
  });

  it('reads the hearth://portfolio/summary resource as text', async () => {
    const client = await connectClient(false);
    const result = await client.readResource({ uri: 'hearth://portfolio/summary' });
    const content = result.contents[0] as { mimeType?: string; text: string };
    expect(content.mimeType).toBe('text/plain');
    expect(content.text.length).toBeGreaterThan(0);
    expect(content.text).toContain('properties');
  });

  it('dismiss_insight succeeds with writes on and leaves exactly one audit row', async () => {
    const accountId = await getDemoAccountId();
    // A throwaway insight so seeded rows (asserted by other tests) stay intact.
    const insight = await prisma.insight.create({
      data: {
        accountId,
        scope: 'portfolio',
        type: 'late_rent',
        severity: 'info',
        title: 'MCP test insight',
        body: 'Created by mcp.test.ts',
        dedupeKey: `mcp_test:${Date.now()}`,
        status: 'active',
      },
    });

    const client = await connectClient(true);
    const dismissed = await callToolJson(client, 'dismiss_insight', { insightId: insight.id });
    expect(dismissed.status).toBe('dismissed');

    // The service already audits (insight.dismissed) — the MCP layer must not
    // double-log — and an MCP-invoked write is attributed to 'system'.
    const rows = await prisma.auditLog.findMany({
      where: { accountId, entityType: 'insight', entityId: insight.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('insight.dismissed');
    expect(rows[0]!.actor).toBe('system');
  });

  it('email_report writes exactly one report.emailed audit row as system', async () => {
    const accountId = await getDemoAccountId();
    const report = await prisma.report.findFirstOrThrow({ where: { accountId } });

    const client = await connectClient(true);
    const sent = await callToolJson(client, 'email_report', {
      reportId: report.id,
      to: 'accountant@example.com',
    });
    expect(sent).toEqual({ sent: true, to: 'accountant@example.com' });

    const rows = await prisma.auditLog.findMany({
      where: { accountId, action: 'report.emailed', entityId: report.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe('system');
    expect(JSON.parse(rows[0]!.detailJson!)).toEqual({ to: 'accountant@example.com' });
  });
});
