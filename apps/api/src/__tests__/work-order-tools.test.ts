// Work-order AI write tools (PLAN-MAINTENANCE §5): create_work_order /
// update_work_order exist in the shared tool registry, are gated on the
// 'properties' member permission (matching the maintenance directory's own
// gating precedent), audit the invoking actor, null-clear their reversible
// fields, and ride the MCP server behind allowWrites. Own throwaway account,
// cleaned up in afterAll — never touches the seeded demo account.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { createMcpServer } from '../mcp/index';
import { deniedWriteTools, findServiceTool, WRITE_TOOL_PERMISSIONS } from '../ai/tools';

const EMAIL_SUFFIX = '@workordertooltest.example';
const WORK_ORDER_TOOLS = ['create_work_order', 'update_work_order'];

async function makeAccount(tag: string): Promise<string> {
  const account = await prisma.account.create({
    data: { name: `Work Order Tool Co ${tag}`, email: `wo-tool-${tag}${EMAIL_SUFFIX}` },
  });
  return account.id;
}

async function makeProperty(accountId: string, tag: string): Promise<{ id: string }> {
  return (await findServiceTool('create_property')!.execute(
    accountId,
    { addressLine1: `${tag} Registry Rd`, city: 'Springfield', state: 'CA', zip: '90000', units: [{ label: 'A' }] },
    'system',
  )) as { id: string };
}

afterAll(async () => {
  await prisma.account.deleteMany({ where: { email: { endsWith: EMAIL_SUFFIX } } });
});

describe('work-order write tools — registry + permission gating', () => {
  it('registers both as properties-gated write tools', () => {
    for (const name of WORK_ORDER_TOOLS) {
      expect(findServiceTool(name)?.write, name).toBe(true);
      expect(WRITE_TOOL_PERMISSIONS[name], name).toBe('properties');
    }
    // Archive/restore deliberately have no tool (DELETEs never ship from chat).
    expect(findServiceTool('archive_work_order')).toBeUndefined();
    expect(findServiceTool('restore_work_order')).toBeUndefined();
  });

  it('registers the two read tools', () => {
    expect(findServiceTool('list_work_orders')?.write).toBe(false);
    expect(findServiceTool('get_work_order')?.write).toBe(false);
  });

  it("denies a member without the 'properties' area, allows with it, never gates owners", () => {
    for (const name of WORK_ORDER_TOOLS) {
      expect(deniedWriteTools('member', []).has(name), name).toBe(true);
      expect(deniedWriteTools('member', ['ai']).has(name), name).toBe(true);
      expect(deniedWriteTools('member', ['ai', 'properties']).has(name), name).toBe(false);
      expect(deniedWriteTools('owner', []).has(name), name).toBe(false);
    }
  });
});

describe('work-order write tools — execution + audit attribution', () => {
  it('create_work_order opens the work order and audits the passed actor', async () => {
    const accountId = await makeAccount('create');
    const property = await makeProperty(accountId, 'Create');

    const result = (await findServiceTool('create_work_order')!.execute(
      accountId,
      { propertyId: property.id, title: 'Fix leaking faucet', priority: 'normal' },
      'system',
    )) as { id: string; title: string; status: string };
    expect(result.title).toBe('Fix leaking faucet');
    expect(result.status).toBe('open'); // omitted -> default

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, entityId: result.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.actor).toBe('system');
  });

  it('update_work_order patches only the provided fields and audits', async () => {
    const accountId = await makeAccount('update');
    const property = await makeProperty(accountId, 'Update');
    const created = (await findServiceTool('create_work_order')!.execute(
      accountId,
      { propertyId: property.id, title: 'Replace furnace filter', priority: 'low' },
      'system',
    )) as { id: string };

    const updated = (await findServiceTool('update_work_order')!.execute(
      accountId,
      { workOrderId: created.id, status: 'in_progress' },
      'system',
    )) as { status: string; title: string; priority: string };
    expect(updated.status).toBe('in_progress');
    expect(updated.title).toBe('Replace furnace filter'); // untouched
    expect(updated.priority).toBe('low'); // untouched

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, entityId: created.id, action: { contains: 'update' } },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.actor).toBe('system');
  });

  it('update_work_order null-clears contractorId, scheduledFor, dueBy, unitId and quotedCents', async () => {
    const accountId = await makeAccount('clear');
    const property = await makeProperty(accountId, 'Clear');
    const unit = (await findServiceTool('create_unit')!.execute(
      accountId,
      { propertyId: property.id, label: 'B' },
      'system',
    )) as { id: string };
    const contractor = (await findServiceTool('create_contractor')!.execute(
      accountId,
      { name: 'Rivera Plumbing', trade: 'Plumbing' },
      'system',
    )) as { id: string };

    const created = (await findServiceTool('create_work_order')!.execute(
      accountId,
      {
        propertyId: property.id,
        unitId: unit.id,
        title: 'Emergency pipe burst',
        // Explicit status (rather than omitted) so scheduledFor being set does
        // not auto-promote this to 'scheduled' — that status requires a
        // scheduledFor, which the later null-clear below would violate.
        status: 'open',
        priority: 'emergency',
        contractorId: contractor.id,
        scheduledFor: '2026-09-01',
        dueBy: '2026-09-02',
        quotedCents: 45000,
      },
      'system',
    )) as {
      id: string;
      unitId: string | null;
      contractorId: string | null;
      scheduledFor: string | null;
      dueBy: string | null;
      quotedCents: number | null;
    };
    expect(created.unitId).toBe(unit.id);
    expect(created.contractorId).toBe(contractor.id);
    expect(created.scheduledFor).toBe('2026-09-01');
    expect(created.dueBy).toBe('2026-09-02');
    expect(created.quotedCents).toBe(45000);

    const cleared = (await findServiceTool('update_work_order')!.execute(
      accountId,
      {
        workOrderId: created.id,
        unitId: null,
        contractorId: null,
        scheduledFor: null,
        dueBy: null,
        quotedCents: null,
      },
      'system',
    )) as {
      title: string;
      unitId: string | null;
      contractorId: string | null;
      scheduledFor: string | null;
      dueBy: string | null;
      quotedCents: number | null;
    };
    expect(cleared.unitId).toBeNull();
    expect(cleared.contractorId).toBeNull();
    expect(cleared.scheduledFor).toBeNull();
    expect(cleared.dueBy).toBeNull();
    expect(cleared.quotedCents).toBeNull();
    expect(cleared.title).toBe('Emergency pipe burst'); // omitted fields untouched
  });

  it('create_work_order rejects a property owned by another account', async () => {
    const accountId = await makeAccount('isolate-a');
    const otherAccountId = await makeAccount('isolate-b');
    const property = await makeProperty(accountId, 'Isolate');
    await expect(
      findServiceTool('create_work_order')!.execute(
        otherAccountId,
        { propertyId: property.id, title: 'Should fail' },
        'system',
      ),
    ).rejects.toThrow(/propert/i);
  });

  it('update_work_order rejects a work order owned by another account', async () => {
    const accountId = await makeAccount('cross-a');
    const otherAccountId = await makeAccount('cross-b');
    const property = await makeProperty(accountId, 'Cross');
    const created = (await findServiceTool('create_work_order')!.execute(
      accountId,
      { propertyId: property.id, title: 'Owned by A' },
      'system',
    )) as { id: string };

    await expect(
      findServiceTool('update_work_order')!.execute(
        otherAccountId,
        { workOrderId: created.id, status: 'cancelled' },
        'system',
      ),
    ).rejects.toThrow(/work.?order/i);
  });
});

describe('work-order write tools — MCP', () => {
  it('creates a work order via the MCP server with system attribution', async () => {
    const accountId = await makeAccount('mcp');
    const property = await makeProperty(accountId, 'Mcp');

    const server = createMcpServer({ accountId, allowWrites: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'work-order-tool-test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const res = (await client.callTool({
        name: 'create_work_order',
        arguments: { propertyId: property.id, title: 'MCP-created work order' },
      })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      expect(res.isError ?? false).toBe(false);
      const workOrder = JSON.parse(res.content[0]!.text) as { id: string; title: string };
      expect(workOrder.title).toBe('MCP-created work order');

      const audit = await prisma.auditLog.findFirst({
        where: { accountId, entityId: workOrder.id },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit?.actor).toBe('system');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
