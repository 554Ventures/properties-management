// Mortgage/valuation AI write tools (PLAN-REAL-EQUITY §4 Phase 1 item 4):
// create_mortgage / update_mortgage / record_property_valuation exist in the
// shared tool registry, are gated on the 'properties' member permission,
// audit the invoking actor, and ride the MCP server behind allowWrites. Own
// throwaway account, cleaned up in afterAll — never touches the seeded demo
// account. Modeled closely on property-unit-tools.test.ts.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { createMcpServer } from '../mcp/index';
import * as mortgageService from '../services/mortgage.service';
import { deniedWriteTools, findServiceTool, WRITE_TOOL_PERMISSIONS } from '../ai/tools';

const EMAIL_SUFFIX = '@mortgagetooltest.example';
const MORTGAGE_TOOLS = ['create_mortgage', 'update_mortgage', 'record_property_valuation'];

async function makeAccount(tag: string): Promise<string> {
  const account = await prisma.account.create({
    data: { name: `Mortgage Tool Co ${tag}`, email: `mortgage-tool-${tag}${EMAIL_SUFFIX}` },
  });
  return account.id;
}

async function makeProperty(accountId: string, addressLine1: string): Promise<string> {
  const property = (await findServiceTool('create_property')!.execute(
    accountId,
    { addressLine1, city: 'Springfield', state: 'CA', zip: '90000', units: [{ label: '1' }] },
    'system',
  )) as { id: string };
  return property.id;
}

afterAll(async () => {
  await prisma.account.deleteMany({ where: { email: { endsWith: EMAIL_SUFFIX } } });
});

describe('mortgage/valuation write tools — registry + permission gating', () => {
  it('registers all three as properties-gated write tools', () => {
    for (const name of MORTGAGE_TOOLS) {
      expect(findServiceTool(name)?.write, name).toBe(true);
      expect(WRITE_TOOL_PERMISSIONS[name], name).toBe('properties');
    }
    // Archive/restore/delete deliberately have no tool (DELETEs never ship
    // from chat, matching the property/unit precedent).
    expect(findServiceTool('archive_mortgage')).toBeUndefined();
    expect(findServiceTool('restore_mortgage')).toBeUndefined();
    expect(findServiceTool('delete_valuation')).toBeUndefined();
  });

  it("denies a member without the 'properties' area, allows with it, never gates owners", () => {
    for (const name of MORTGAGE_TOOLS) {
      expect(deniedWriteTools('member', []).has(name), name).toBe(true);
      expect(deniedWriteTools('member', ['ai']).has(name), name).toBe(true);
      expect(deniedWriteTools('member', ['ai', 'properties']).has(name), name).toBe(false);
      expect(deniedWriteTools('owner', []).has(name), name).toBe(false);
    }
  });
});

describe('mortgage/valuation write tools — execution + audit attribution', () => {
  it('create_mortgage adds a checkpoint mortgage and audits the passed actor', async () => {
    const accountId = await makeAccount('create-mortgage');
    const propertyId = await makeProperty(accountId, '7 Registry Rd');
    const asOfDate = new Date('2026-06-01T00:00:00.000Z').toISOString();

    const result = (await findServiceTool('create_mortgage')!.execute(
      accountId,
      {
        propertyId,
        lender: 'Springfield Federal',
        balanceCents: 31_000_000,
        balanceAsOfDate: asOfDate,
        interestRateMilliPct: 6375,
      },
      'system',
    )) as { id: string; balanceCents: number; currentBalanceCents: number; lender: string };
    expect(result.balanceCents).toBe(31_000_000);
    // Phase 1: no principal-bearing rows exist yet, so the derived current
    // balance always equals the checkpoint.
    expect(result.currentBalanceCents).toBe(31_000_000);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { accountId, action: 'mortgage.created', entityType: 'mortgage', entityId: result.id },
    });
    expect(audit.actor).toBe('system');
  });

  it('update_mortgage re-checkpoints the balance together and audits mortgage.checkpointed', async () => {
    const accountId = await makeAccount('checkpoint');
    const propertyId = await makeProperty(accountId, '9 Checkpoint Ave');
    const mortgage = (await findServiceTool('create_mortgage')!.execute(
      accountId,
      {
        propertyId,
        lender: 'First Landlord Bank',
        balanceCents: 32_000_000,
        balanceAsOfDate: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      },
      'system',
    )) as { id: string };

    const checkpointed = (await findServiceTool('update_mortgage')!.execute(
      accountId,
      {
        mortgageId: mortgage.id,
        balanceCents: 31_000_000,
        balanceAsOfDate: new Date('2026-07-01T00:00:00.000Z').toISOString(),
      },
      'system',
    )) as { balanceCents: number; currentBalanceCents: number; lender: string };
    expect(checkpointed.balanceCents).toBe(31_000_000);
    expect(checkpointed.currentBalanceCents).toBe(31_000_000);
    expect(checkpointed.lender).toBe('First Landlord Bank'); // untouched

    const checkpointAudit = await prisma.auditLog.findFirstOrThrow({
      where: { accountId, action: 'mortgage.checkpointed', entityType: 'mortgage', entityId: mortgage.id },
    });
    expect(checkpointAudit.actor).toBe('system');

    // A field-only edit (no balance) audits the plain 'mortgage.updated' action.
    const relabeled = (await findServiceTool('update_mortgage')!.execute(
      accountId,
      { mortgageId: mortgage.id, lender: 'Second Landlord Bank' },
      'system',
    )) as { lender: string; balanceCents: number };
    expect(relabeled.lender).toBe('Second Landlord Bank');
    expect(relabeled.balanceCents).toBe(31_000_000); // untouched

    const updateAudit = await prisma.auditLog.findFirstOrThrow({
      where: { accountId, action: 'mortgage.updated', entityType: 'mortgage', entityId: mortgage.id },
    });
    expect(updateAudit.actor).toBe('system');
  });

  // The tool's inputSchema stays a FLAT object (see tool-schemas.test.ts — a
  // refined/intersected schema serializes to `allOf` and the Anthropic tool API
  // rejects it), so the balanceCents/balanceAsOfDate pairing rule is enforced by
  // the service. The model can propose a half-checkpoint; it just can't land one.
  it('update_mortgage accepts a flat patch shape but the service refuses a balance without its as-of date', async () => {
    const schema = findServiceTool('update_mortgage')!.inputSchema;
    expect(schema.safeParse({ mortgageId: 'm1', lender: 'Renamed Bank' }).success).toBe(true);
    expect(
      schema.safeParse({
        mortgageId: 'm1',
        balanceCents: 19_000_000,
        balanceAsOfDate: new Date('2026-07-01T00:00:00.000Z').toISOString(),
      }).success,
    ).toBe(true);

    const accountId = await makeAccount('pairing');
    const propertyId = await makeProperty(accountId, '9 Pairing Way');
    const mortgage = (await findServiceTool('create_mortgage')!.execute(
      accountId,
      {
        propertyId,
        lender: 'Pairing Bank',
        balanceCents: 31_000_000,
        balanceAsOfDate: new Date('2026-06-01T00:00:00.000Z').toISOString(),
      },
      'system',
    )) as { id: string };

    await expect(
      findServiceTool('update_mortgage')!.execute(
        accountId,
        { mortgageId: mortgage.id, balanceCents: 19_000_000 },
        'system',
      ),
    ).rejects.toThrow(/together/i);
    expect(
      (await prisma.mortgage.findUniqueOrThrow({ where: { id: mortgage.id } })).balanceCents,
    ).toBe(31_000_000);
  });

  it('record_property_valuation records an owner-provided value and audits valuation.recorded', async () => {
    const accountId = await makeAccount('valuation');
    const propertyId = await makeProperty(accountId, '13 Valuation Ln');

    const result = (await findServiceTool('record_property_valuation')!.execute(
      accountId,
      {
        propertyId,
        valueCents: 42_000_000,
        asOfDate: new Date('2026-08-01T00:00:00.000Z').toISOString(),
        source: 'owner_estimate',
        notes: 'Zestimate-adjacent guess',
      },
      'system',
    )) as { id: string; valueCents: number; source: string };
    expect(result.valueCents).toBe(42_000_000);
    expect(result.source).toBe('owner_estimate');

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { accountId, action: 'valuation.recorded', entityType: 'valuation', entityId: result.id },
    });
    expect(audit.actor).toBe('system');
  });

  it('create_mortgage and record_property_valuation reject a property owned by another account', async () => {
    const accountId = await makeAccount('isolate-a');
    const otherAccountId = await makeAccount('isolate-b');
    const propertyId = await makeProperty(accountId, '1 Mine St');

    await expect(
      findServiceTool('create_mortgage')!.execute(
        otherAccountId,
        {
          propertyId,
          lender: 'Nobody Bank',
          balanceCents: 1000,
          balanceAsOfDate: new Date().toISOString(),
        },
        'system',
      ),
    ).rejects.toThrow(/property/i);

    await expect(
      findServiceTool('record_property_valuation')!.execute(
        otherAccountId,
        { propertyId, valueCents: 1000, asOfDate: new Date().toISOString(), source: 'other' },
        'system',
      ),
    ).rejects.toThrow(/property/i);
  });
});

describe('confirm_transaction carries the mortgage breakdown', () => {
  // The flow that actually happens: the bank delivers a mortgage payment (or a
  // template drafts one), detection stamps its mortgageId, and it is CONFIRMED.
  // The tool used to accept no breakdown at all, so the assistant could only
  // confirm one by expensing the whole debit — full amount into P&L, loan
  // balance untouched, no error raised.
  it('carves out principal and splits the remainder, exactly like the REST path', async () => {
    const accountId = await makeAccount('confirm');
    const propertyId = await makeProperty(accountId, '4 Confirm Ct');
    const mortgage = (await findServiceTool('create_mortgage')!.execute(
      accountId,
      {
        propertyId,
        lender: 'Confirm Federal',
        balanceCents: 25_000_000,
        balanceAsOfDate: new Date('2026-01-01T05:00:00.000Z').toISOString(),
      },
      'system',
    )) as { id: string };

    const interest = await prisma.category.findFirstOrThrow({ where: { name: 'Mortgage Interest' } });
    const taxes = await prisma.category.findFirstOrThrow({ where: { name: 'Property Taxes' } });
    const pending = await prisma.transaction.create({
      data: {
        accountId,
        propertyId,
        date: new Date('2026-08-01T04:00:00.000Z'),
        amountCents: 240_000,
        type: 'expense',
        description: 'CONFIRM FEDERAL MTG PMT',
        vendor: 'Confirm Federal',
        mortgageId: mortgage.id,
        source: 'bank',
        status: 'pending_review',
      },
    });

    await findServiceTool('confirm_transaction')!.execute(
      accountId,
      {
        transactionId: pending.id,
        mortgageId: mortgage.id,
        principalCents: 80_000,
        splits: [
          { categoryId: interest.id, amountCents: 110_000 },
          { categoryId: taxes.id, amountCents: 50_000 },
        ],
      },
      'system',
    );

    const row = await prisma.transaction.findUniqueOrThrow({
      where: { id: pending.id },
      include: { splits: true },
    });
    expect(row.status).toBe('confirmed');
    expect(row.principalCents).toBe(80_000); // NOT an expense
    expect(row.splits.reduce((s, x) => s + x.amountCents, 0)).toBe(160_000); // amount − principal

    // And the money moved: the loan is $800 smaller than its checkpoint.
    const [derived] = await mortgageService.listForProperty(accountId, propertyId);
    expect(derived?.currentBalanceCents).toBe(25_000_000 - 80_000);
  });

  it('refuses a breakdown the ledger would refuse, rather than silently dropping it', async () => {
    const accountId = await makeAccount('confirm-invalid');
    const propertyId = await makeProperty(accountId, '5 Invalid Way');
    const pending = await prisma.transaction.create({
      data: {
        accountId,
        propertyId,
        date: new Date('2026-08-01T04:00:00.000Z'),
        amountCents: 100_000,
        type: 'expense',
        description: 'NOT A MORTGAGE',
        source: 'bank',
        status: 'pending_review',
      },
    });
    // Principal with no mortgage to repay is meaningless — the service owns
    // that rule, and the tool must surface it rather than confirm a half-row.
    await expect(
      findServiceTool('confirm_transaction')!.execute(
        accountId,
        { transactionId: pending.id, principalCents: 50_000 },
        'system',
      ),
    ).rejects.toThrow();
    expect(
      (await prisma.transaction.findUniqueOrThrow({ where: { id: pending.id } })).status,
    ).toBe('pending_review');
  });
});

describe('mortgage/valuation write tools — MCP', () => {
  it('creates a mortgage via the MCP server with system attribution', async () => {
    const accountId = await makeAccount('mcp');
    const propertyId = await makeProperty(accountId, '3 MCP Way');

    const server = createMcpServer({ accountId, allowWrites: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'mortgage-tool-test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const res = (await client.callTool({
        name: 'create_mortgage',
        arguments: {
          propertyId,
          lender: 'MCP Federal',
          balanceCents: 15_000_000,
          balanceAsOfDate: new Date('2026-05-01T00:00:00.000Z').toISOString(),
        },
      })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      expect(res.isError ?? false).toBe(false);
      const mortgage = JSON.parse(res.content[0]!.text) as { id: string; lender: string };
      expect(mortgage.lender).toBe('MCP Federal');

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { accountId, action: 'mortgage.created', entityType: 'mortgage', entityId: mortgage.id },
      });
      expect(audit.actor).toBe('system');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('refuses record_property_valuation via MCP when writes are disallowed', async () => {
    const accountId = await makeAccount('mcp-readonly');
    const propertyId = await makeProperty(accountId, '5 Readonly Rd');

    const server = createMcpServer({ accountId, allowWrites: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'mortgage-tool-readonly-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.some((t) => t.name === 'record_property_valuation')).toBe(false);
      void propertyId;
    } finally {
      await client.close();
      await server.close();
    }
  });
});
