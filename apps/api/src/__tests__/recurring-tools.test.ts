// Recurring-template AI tools (PLAN-REAL-EQUITY §4 Phase 2b item 7):
// create_recurring_template / list_recurring_templates exist in the shared
// tool registry, the write tool is gated on the 'money' member permission
// (a template's whole job is minting ledger rows), and writes audit the
// invoking actor. Own throwaway account, cleaned up in afterAll — never
// touches the seeded demo account. Modeled closely on mortgage-tools.test.ts.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { createMcpServer } from '../mcp/index';
import { deniedWriteTools, findServiceTool, WRITE_TOOL_PERMISSIONS } from '../ai/tools';

const EMAIL_SUFFIX = '@recurringtooltest.example';

async function makeAccount(tag: string): Promise<string> {
  const account = await prisma.account.create({
    data: { name: `Recurring Tool Co ${tag}`, email: `recurring-tool-${tag}${EMAIL_SUFFIX}` },
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

// Far enough in the future that draft-on-create never fires — keeps these
// tests focused on the tool/permission surface, not the drafting logic that
// recurring.service.ts already owns and tests itself. A calendar date, like
// every date on this contract.
const FUTURE_ANCHOR = '2030-01-01';

afterAll(async () => {
  await prisma.account.deleteMany({ where: { email: { endsWith: EMAIL_SUFFIX } } });
});

describe('recurring-template tools — registry + permission gating', () => {
  it('registers create_recurring_template as a money-gated write tool and list_recurring_templates as a read tool', () => {
    expect(findServiceTool('create_recurring_template')?.write).toBe(true);
    expect(WRITE_TOOL_PERMISSIONS.create_recurring_template).toBe('money');
    expect(findServiceTool('list_recurring_templates')?.write).toBe(false);
    // Archive/restore/edit deliberately have no tool (DELETE-shaped or
    // edit-shaped writes never ship from chat, matching precedent).
    expect(findServiceTool('update_recurring_template')).toBeUndefined();
    expect(findServiceTool('archive_recurring_template')).toBeUndefined();
    expect(findServiceTool('restore_recurring_template')).toBeUndefined();
  });

  it("denies a member without the 'money' area, allows with it, never gates owners", () => {
    expect(deniedWriteTools('member', []).has('create_recurring_template')).toBe(true);
    expect(deniedWriteTools('member', ['ai']).has('create_recurring_template')).toBe(true);
    // 'properties' alone is not enough — this is a money write, not a
    // property-attached record edit.
    expect(deniedWriteTools('member', ['ai', 'properties']).has('create_recurring_template')).toBe(
      true,
    );
    expect(deniedWriteTools('member', ['ai', 'money']).has('create_recurring_template')).toBe(false);
    expect(deniedWriteTools('owner', []).has('create_recurring_template')).toBe(false);
  });
});

describe('recurring-template tools — execution + audit attribution', () => {
  it('create_recurring_template adds a standing instruction and audits the passed actor', async () => {
    const accountId = await makeAccount('create');
    const propertyId = await makeProperty(accountId, '7 Registry Rd');

    const result = (await findServiceTool('create_recurring_template')!.execute(
      accountId,
      {
        description: 'Mortgage payment',
        propertyId,
        type: 'expense',
        amountCents: 240_000,
        cadence: 'monthly',
        anchorDate: FUTURE_ANCHOR,
      },
      'system',
    )) as { id: string; amountCents: number; cadence: string; lastDraftedOccurrence: string | null };
    expect(result.amountCents).toBe(240_000);
    expect(result.cadence).toBe('monthly');
    // Anchor is in the future, so nothing drafted yet.
    expect(result.lastDraftedOccurrence).toBeNull();

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {
        accountId,
        action: 'recurring_template.created',
        entityType: 'recurring_template',
        entityId: result.id,
      },
    });
    expect(audit.actor).toBe('system');
  });

  it('list_recurring_templates returns active templates by default and includes archived only when asked', async () => {
    const accountId = await makeAccount('list');
    const propertyId = await makeProperty(accountId, '11 Listing Ln');

    const created = (await findServiceTool('create_recurring_template')!.execute(
      accountId,
      {
        description: 'HOA dues',
        propertyId,
        type: 'expense',
        amountCents: 30_000,
        cadence: 'quarterly',
        anchorDate: FUTURE_ANCHOR,
      },
      'system',
    )) as { id: string };

    const active = (await findServiceTool('list_recurring_templates')!.execute(
      accountId,
      {},
      'system',
    )) as Array<{ id: string; description: string }>;
    expect(active.map((t) => t.id)).toContain(created.id);

    await prisma.recurringTemplate.update({
      where: { id: created.id },
      data: { archivedAt: new Date() },
    });

    const activeAfterArchive = (await findServiceTool('list_recurring_templates')!.execute(
      accountId,
      {},
      'system',
    )) as Array<{ id: string }>;
    expect(activeAfterArchive.map((t) => t.id)).not.toContain(created.id);

    const withArchived = (await findServiceTool('list_recurring_templates')!.execute(
      accountId,
      { includeArchived: true },
      'system',
    )) as Array<{ id: string }>;
    expect(withArchived.map((t) => t.id)).toContain(created.id);
  });

  it('create_recurring_template rejects a property owned by another account', async () => {
    const accountId = await makeAccount('isolate-a');
    const otherAccountId = await makeAccount('isolate-b');
    const propertyId = await makeProperty(accountId, '1 Mine St');

    await expect(
      findServiceTool('create_recurring_template')!.execute(
        otherAccountId,
        {
          description: 'Not yours',
          propertyId,
          type: 'expense',
          amountCents: 10_000,
          cadence: 'monthly',
          anchorDate: FUTURE_ANCHOR,
        },
        'system',
      ),
    ).rejects.toThrow(/property/i);
  });

  it('list_recurring_templates only returns the calling account\'s templates', async () => {
    const accountId = await makeAccount('isolate-list-a');
    const otherAccountId = await makeAccount('isolate-list-b');
    const propertyId = await makeProperty(accountId, '2 Mine St');

    await findServiceTool('create_recurring_template')!.execute(
      accountId,
      {
        description: 'Mine',
        propertyId,
        type: 'expense',
        amountCents: 10_000,
        cadence: 'monthly',
        anchorDate: FUTURE_ANCHOR,
      },
      'system',
    );

    const otherList = (await findServiceTool('list_recurring_templates')!.execute(
      otherAccountId,
      {},
      'system',
    )) as unknown[];
    expect(otherList).toEqual([]);
  });
});

describe('recurring-template tools — MCP', () => {
  it('creates a recurring template via the MCP server with system attribution', async () => {
    const accountId = await makeAccount('mcp');
    const propertyId = await makeProperty(accountId, '3 MCP Way');

    const server = createMcpServer({ accountId, allowWrites: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'recurring-tool-test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const res = (await client.callTool({
        name: 'create_recurring_template',
        arguments: {
          description: 'Insurance premium',
          propertyId,
          type: 'expense',
          amountCents: 120_000,
          cadence: 'annual',
          anchorDate: FUTURE_ANCHOR,
        },
      })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      expect(res.isError ?? false).toBe(false);
      const template = JSON.parse(res.content[0]!.text) as { id: string; description: string };
      expect(template.description).toBe('Insurance premium');

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: {
          accountId,
          action: 'recurring_template.created',
          entityType: 'recurring_template',
          entityId: template.id,
        },
      });
      expect(audit.actor).toBe('system');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('refuses create_recurring_template via MCP when writes are disallowed', async () => {
    const accountId = await makeAccount('mcp-readonly');

    const server = createMcpServer({ accountId, allowWrites: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'recurring-tool-readonly-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.some((t) => t.name === 'create_recurring_template')).toBe(false);
      // Reads stay available in read-only MCP mode.
      expect(tools.tools.some((t) => t.name === 'list_recurring_templates')).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
