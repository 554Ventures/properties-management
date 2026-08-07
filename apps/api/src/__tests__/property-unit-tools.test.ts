// Property/unit AI write tools (WHATS_NEXT §4 "Chat can't act on properties/
// units"): create_property / update_property / create_unit / update_unit exist
// in the shared tool registry, are gated on the 'properties' member permission,
// audit the invoking actor, and ride the MCP server behind allowWrites. Own
// throwaway account, cleaned up in afterAll — never touches the seeded demo
// account.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { createMcpServer } from '../mcp/index';
import { deniedWriteTools, findServiceTool, WRITE_TOOL_PERMISSIONS } from '../ai/tools';

const EMAIL_SUFFIX = '@proptooltest.example';
const PROPERTY_UNIT_TOOLS = ['create_property', 'update_property', 'create_unit', 'update_unit'];

async function makeAccount(tag: string): Promise<string> {
  const account = await prisma.account.create({
    data: { name: `Prop Tool Co ${tag}`, email: `prop-tool-${tag}${EMAIL_SUFFIX}` },
  });
  return account.id;
}

afterAll(async () => {
  await prisma.account.deleteMany({ where: { email: { endsWith: EMAIL_SUFFIX } } });
});

describe('property/unit write tools — registry + permission gating', () => {
  it('registers all four as properties-gated write tools', () => {
    for (const name of PROPERTY_UNIT_TOOLS) {
      expect(findServiceTool(name)?.write, name).toBe(true);
      expect(WRITE_TOOL_PERMISSIONS[name], name).toBe('properties');
    }
    // Archive/restore deliberately have no tool (DELETEs never ship from chat).
    expect(findServiceTool('archive_property')).toBeUndefined();
    expect(findServiceTool('archive_unit')).toBeUndefined();
  });

  it("denies a member without the 'properties' area, allows with it, never gates owners", () => {
    for (const name of PROPERTY_UNIT_TOOLS) {
      expect(deniedWriteTools('member', []).has(name), name).toBe(true);
      expect(deniedWriteTools('member', ['ai']).has(name), name).toBe(true);
      expect(deniedWriteTools('member', ['ai', 'properties']).has(name), name).toBe(false);
      expect(deniedWriteTools('owner', []).has(name), name).toBe(false);
    }
  });
});

describe('property/unit write tools — execution + audit attribution', () => {
  it('create_property creates the property with its units and audits the passed actor', async () => {
    const accountId = await makeAccount('create');
    const result = (await findServiceTool('create_property')!.execute(
      accountId,
      {
        addressLine1: '7 Registry Rd',
        city: 'Springfield',
        state: 'CA',
        zip: '90000',
        acquisitionCostCents: 25_000_000,
        units: [{ label: 'A' }, { label: 'B', marketRentCents: 150000 }],
      },
      'system',
    )) as { id: string; acquisitionCostCents: number | null };
    expect(result.acquisitionCostCents).toBe(25_000_000);

    const units = await prisma.unit.findMany({ where: { propertyId: result.id } });
    expect(units.map((u) => u.label).sort()).toEqual(['A', 'B']);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { accountId, action: 'create', entityType: 'property', entityId: result.id },
    });
    expect(audit.actor).toBe('system');
  });

  it('update_property and update_unit patch only the provided fields and audit', async () => {
    const accountId = await makeAccount('update');
    const property = (await findServiceTool('create_property')!.execute(
      accountId,
      { addressLine1: '9 Patch Pl', city: 'X', state: 'CA', zip: '00001', units: [{ label: '1' }] },
      'system',
    )) as { id: string };

    const updated = (await findServiceTool('update_property')!.execute(
      accountId,
      { propertyId: property.id, nickname: 'The Nine' },
      'system',
    )) as { nickname: string | null; addressLine1: string };
    expect(updated.nickname).toBe('The Nine');
    expect(updated.addressLine1).toBe('9 Patch Pl'); // untouched

    const unit = (await findServiceTool('create_unit')!.execute(
      accountId,
      { propertyId: property.id, label: '2', bedrooms: 2 },
      'system',
    )) as { id: string; label: string };

    const patchedUnit = (await findServiceTool('update_unit')!.execute(
      accountId,
      { unitId: unit.id, marketRentCents: 180000 },
      'system',
    )) as { marketRentCents: number | null; label: string };
    expect(patchedUnit.marketRentCents).toBe(180000);
    expect(patchedUnit.label).toBe('2'); // untouched

    for (const [entityType, entityId] of [
      ['property', property.id],
      ['unit', unit.id],
    ] as const) {
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { accountId, action: 'update', entityType, entityId },
      });
      expect(audit.actor).toBe('system');
    }
  });

  it('create_unit rejects a property owned by another account', async () => {
    const accountId = await makeAccount('isolate-a');
    const otherAccountId = await makeAccount('isolate-b');
    const property = (await findServiceTool('create_property')!.execute(
      accountId,
      { addressLine1: '1 Mine St', city: 'X', state: 'CA', zip: '00002', units: [{ label: '1' }] },
      'system',
    )) as { id: string };
    await expect(
      findServiceTool('create_unit')!.execute(otherAccountId, { propertyId: property.id, label: 'X' }, 'system'),
    ).rejects.toThrow(/property/i);
  });
});

describe('property/unit write tools — MCP', () => {
  it('creates a unit via the MCP server with system attribution', async () => {
    const accountId = await makeAccount('mcp');
    const property = (await findServiceTool('create_property')!.execute(
      accountId,
      { addressLine1: '3 MCP Way', city: 'X', state: 'CA', zip: '00003', units: [{ label: '1' }] },
      'system',
    )) as { id: string };

    const server = createMcpServer({ accountId, allowWrites: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'prop-tool-test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const res = (await client.callTool({
        name: 'create_unit',
        arguments: { propertyId: property.id, label: 'MCP-1', marketRentCents: 120000 },
      })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      expect(res.isError ?? false).toBe(false);
      const unit = JSON.parse(res.content[0]!.text) as { id: string; label: string };
      expect(unit.label).toBe('MCP-1');

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { accountId, action: 'create', entityType: 'unit', entityId: unit.id },
      });
      expect(audit.actor).toBe('system');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
