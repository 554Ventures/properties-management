// Read-only AI tool coverage (gap analysis, 2026-08-09). The registry exposed
// the dashboard KPIs and series but not the expense breakdown, NOI comparison
// or activity feed; it exposed the rent tracker but not open charges or the
// unlinked-deposit reconciliation gap; and it had list_contractors with no
// detail tool while every other entity had one. These nine wrap existing
// service functions with no new business logic.
//
// `get_account_settings` joined them on 2026-08-13 (WHATS_NEXT §4 "the late-fee
// policy is unreadable before it's applied"): apply_late_fee falls back to the
// lease override else Account.defaultLateFeeCents, which nothing in the registry
// could read — so the assistant could fire the write but never quote the fee
// first. It mirrors the ungated GET /settings/account, so it is a read.
//
// Every case parses the tool's return value with the shared response schema
// rather than asserting an ad hoc shape — same contract enforcement the route
// tests apply, so a contract change fails here instead of surprising a client.
import {
  AccountSettingsSchema,
  ActivityItemSchema,
  BankDiscrepancyListResponseSchema,
  ContractorDetailResponseSchema,
  ContractorListResponseSchema,
  ExpenseBreakdownResponseSchema,
  OpenRentChargesResponseSchema,
  PropertyNoiResponseSchema,
  ReportListResponseSchema,
  UnlinkedRentDepositsResponseSchema,
  WeeklyBriefLatestResponseSchema,
} from '@hearth/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { findServiceTool, WRITE_TOOL_PERMISSIONS } from '../ai/tools';
import { prisma } from '../lib/prisma';
import { createMcpServer } from '../mcp/index';
import { getDemoAccountId } from '../plugins/auth';

const NEW_READ_TOOLS = [
  'get_expense_breakdown',
  'get_noi_by_property',
  'get_recent_activity',
  'list_open_charges',
  'list_unlinked_deposits',
  'list_bank_discrepancies',
  'get_contractor',
  'list_monthly_reviews',
  'get_latest_weekly_brief',
  'get_account_settings',
];

const EMAIL_SUFFIX = '@readtooltest.example';
const created: string[] = [];

async function makeEmptyAccount(tag: string): Promise<string> {
  const account = await prisma.account.create({
    data: { name: `Read Tool Co ${tag}`, email: `read-tool-${tag}${EMAIL_SUFFIX}` },
  });
  created.push(account.id);
  return account.id;
}

/** Run a tool the way the agent loop does: parsed input, service execution. */
async function run(name: string, input: Record<string, unknown> = {}, accountId?: string) {
  const tool = findServiceTool(name);
  expect(tool, `${name} is not registered`).toBeDefined();
  const id = accountId ?? (await getDemoAccountId());
  return tool!.execute(id, tool!.inputSchema.parse(input), 'system');
}

afterAll(async () => {
  if (created.length) {
    await prisma.account.deleteMany({ where: { id: { in: created } } });
  }
});

describe('read tool registry', () => {
  it('registers them all as non-write tools', () => {
    for (const name of NEW_READ_TOOLS) {
      const tool = findServiceTool(name);
      expect(tool, `${name} missing from the registry`).toBeDefined();
      expect(tool!.write, `${name} must not be a write tool`).toBeFalsy();
      expect(tool!.description.length).toBeGreaterThan(20);
      // A read is open to any member, so it must never appear in the write map.
      expect(WRITE_TOOL_PERMISSIONS[name], `${name} must not be permission-gated`).toBeUndefined();
    }
  });

  it('exposes them over MCP even with writes disabled (reads are never gated)', async () => {
    const accountId = await getDemoAccountId();
    const server = createMcpServer({ accountId, allowWrites: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'read-tools-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const name of NEW_READ_TOOLS) expect(names).toContain(name);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('read tools return contract-valid data for the seeded account', () => {
  it('get_expense_breakdown', async () => {
    ExpenseBreakdownResponseSchema.parse(await run('get_expense_breakdown'));
  });

  it('get_noi_by_property', async () => {
    const parsed = PropertyNoiResponseSchema.parse(await run('get_noi_by_property'));
    expect(parsed.properties.length).toBeGreaterThan(0);
  });

  it('get_recent_activity honours its limit', async () => {
    const parsed = z.array(ActivityItemSchema).parse(await run('get_recent_activity', { limit: 3 }));
    expect(parsed.length).toBeLessThanOrEqual(3);
    // Default applies when the caller omits it (schema default, not a service default).
    expect(findServiceTool('get_recent_activity')!.inputSchema.parse({})).toEqual({ limit: 10 });
  });

  it('list_open_charges returns only charges with a positive remaining balance', async () => {
    const parsed = OpenRentChargesResponseSchema.parse(await run('list_open_charges'));
    // The seed leaves Okafor and Park unpaid for the current period.
    expect(parsed.items.length).toBeGreaterThan(0);
    // The schema already constrains remainingCents to positive; assert it too so
    // the intent survives a schema loosening.
    for (const c of parsed.items) expect(c.remainingCents).toBeGreaterThan(0);
  });

  it('list_unlinked_deposits accepts an explicit period and defaults without one', async () => {
    UnlinkedRentDepositsResponseSchema.parse(await run('list_unlinked_deposits'));
    UnlinkedRentDepositsResponseSchema.parse(
      await run('list_unlinked_deposits', { period: '2026-08' }),
    );
  });

  it('list_bank_discrepancies', async () => {
    BankDiscrepancyListResponseSchema.parse(await run('list_bank_discrepancies'));
  });

  it('get_contractor returns one contractor in detail', async () => {
    const list = ContractorListResponseSchema.parse(await run('list_contractors'));
    expect(list.length).toBeGreaterThan(0);
    const detail = ContractorDetailResponseSchema.parse(
      await run('get_contractor', { contractorId: list[0]!.id }),
    );
    expect(detail.contractor.id).toBe(list[0]!.id);
  });

  it('list_monthly_reviews returns only monthly reviews', async () => {
    const parsed = ReportListResponseSchema.parse(await run('list_monthly_reviews'));
    // The seed generates one monthly review.
    expect(parsed.length).toBeGreaterThan(0);
    for (const r of parsed) expect(r.type).toBe('monthly_review');
  });

  it('get_latest_weekly_brief', async () => {
    WeeklyBriefLatestResponseSchema.parse(await run('get_latest_weekly_brief'));
  });

  it('get_account_settings returns the same contract GET /settings/account does', async () => {
    const parsed = AccountSettingsSchema.parse(await run('get_account_settings'));
    const account = await prisma.account.findUniqueOrThrow({ where: { id: await getDemoAccountId() } });
    // The late-fee policy the assistant has to quote before apply_late_fee.
    expect(parsed.defaultLateFeeCents).toBe(account.defaultLateFeeCents);
    expect(parsed.graceDays).toBe(account.graceDays);
    expect(parsed.graceDaysBasis).toBe(account.graceDaysBasis);
    expect(parsed.timezone).toBe(account.timezone);
    expect(parsed.taxRatePct).toBe(account.taxRatePct);
  });
});

describe('read tools are account-scoped', () => {
  it('returns nothing from another account for a fresh, empty one', async () => {
    const accountId = await makeEmptyAccount('scope');

    const noi = PropertyNoiResponseSchema.parse(await run('get_noi_by_property', {}, accountId));
    expect(noi.properties).toHaveLength(0);

    const charges = OpenRentChargesResponseSchema.parse(
      await run('list_open_charges', {}, accountId),
    );
    expect(charges.items).toHaveLength(0);

    const reviews = ReportListResponseSchema.parse(await run('list_monthly_reviews', {}, accountId));
    expect(reviews).toHaveLength(0);

    const activity = z
      .array(ActivityItemSchema)
      .parse(await run('get_recent_activity', {}, accountId));
    expect(activity).toHaveLength(0);

    // Settings are per-account: the fresh account reads its own row, not the demo's.
    const settings = AccountSettingsSchema.parse(await run('get_account_settings', {}, accountId));
    expect(settings.id).toBe(accountId);
    expect(settings.id).not.toBe(await getDemoAccountId());
  });

  it('refuses to read a contractor belonging to another account', async () => {
    const accountId = await makeEmptyAccount('cross');
    const demoList = ContractorListResponseSchema.parse(await run('list_contractors'));
    const foreignId = demoList[0]!.id;
    await expect(run('get_contractor', { contractorId: foreignId }, accountId)).rejects.toThrow();
  });
});
