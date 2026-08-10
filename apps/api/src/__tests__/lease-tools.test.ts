// Lease + tenant AI write tools: the registry had no lease writes at all, so
// draft_lease_renewal could propose terms the assistant had no way to enact.
// create/update/renew/terminate_lease, add/remove_tenant_from_lease and
// create/update_tenant now exist in the shared registry, are gated on the
// 'tenants' member permission (matching requirePermission('tenants') in
// routes/leases.ts + routes/tenants.ts), audit the invoking actor, and ride the
// MCP server behind allowWrites. Own throwaway accounts, cleaned up in
// afterAll — never touches the seeded demo account.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { createMcpServer } from '../mcp/index';
import { deniedWriteTools, findServiceTool, WRITE_TOOL_PERMISSIONS } from '../ai/tools';

const EMAIL_SUFFIX = '@leasetooltest.example';

const TENANT_AREA_TOOLS = [
  'create_lease',
  'update_lease',
  'renew_lease',
  'terminate_lease',
  'add_tenant_to_lease',
  'remove_tenant_from_lease',
  'create_tenant',
  'update_tenant',
];

const DAY_MS = 24 * 60 * 60 * 1000;
/** ISO datetime N days from now (negative = in the past). */
function isoDaysOut(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

async function makeAccount(tag: string): Promise<string> {
  const account = await prisma.account.create({
    data: { name: `Lease Tool Co ${tag}`, email: `lease-tool-${tag}${EMAIL_SUFFIX}` },
  });
  return account.id;
}

/** A property with `unitCount` units plus one tenant, all via the tools. */
async function makeFixture(
  tag: string,
  unitCount = 1,
): Promise<{ accountId: string; unitIds: string[]; tenantId: string }> {
  const accountId = await makeAccount(tag);
  const property = (await findServiceTool('create_property')!.execute(
    accountId,
    {
      addressLine1: `${tag} Lease Ln`,
      city: 'Springfield',
      state: 'CA',
      zip: '90000',
      units: Array.from({ length: unitCount }, (_, i) => ({ label: `U${i + 1}` })),
    },
    'system',
  )) as { id: string };
  const units = await prisma.unit.findMany({
    where: { propertyId: property.id },
    orderBy: { label: 'asc' },
  });
  const tenant = (await findServiceTool('create_tenant')!.execute(
    accountId,
    { fullName: `Primary ${tag}`, email: `primary-${tag}${EMAIL_SUFFIX}` },
    'system',
  )) as { id: string };
  return { accountId, unitIds: units.map((u) => u.id), tenantId: tenant.id };
}

async function expectAudit(
  accountId: string,
  action: string,
  entityType: string,
  entityId: string,
): Promise<void> {
  const audit = await prisma.auditLog.findFirstOrThrow({
    where: { accountId, action, entityType, entityId },
  });
  expect(audit.actor).toBe('system');
}

afterAll(async () => {
  await prisma.account.deleteMany({ where: { email: { endsWith: EMAIL_SUFFIX } } });
});

describe('lease/tenant write tools — registry + permission gating', () => {
  it("registers every lease and tenant write tool under the 'tenants' area", () => {
    for (const name of TENANT_AREA_TOOLS) {
      expect(findServiceTool(name)?.write, name).toBe(true);
      expect(WRITE_TOOL_PERMISSIONS[name], name).toBe('tenants');
    }
  });

  it('registers get_lease as a read tool and the other new writes under their route areas', () => {
    expect(findServiceTool('get_lease')?.write).toBe(false);
    expect(WRITE_TOOL_PERMISSIONS['get_lease']).toBeUndefined();
    expect(findServiceTool('update_contractor')?.write).toBe(true);
    expect(WRITE_TOOL_PERMISSIONS['update_contractor']).toBe('properties');
    expect(findServiceTool('update_transaction')?.write).toBe(true);
    expect(WRITE_TOOL_PERMISSIONS['update_transaction']).toBe('money');
  });

  it('has no tool for the destructive lease/tenant routes (DELETEs never ship from chat)', () => {
    // remove_tenant_from_lease is the deliberate exception: it deletes no
    // record, only the lease↔tenant link, and add_tenant_to_lease restores it.
    expect(findServiceTool('delete_lease')).toBeUndefined();
    expect(findServiceTool('archive_tenant')).toBeUndefined();
    expect(findServiceTool('erase_tenant_pii')).toBeUndefined();
  });

  it("denies a member without the 'tenants' area, allows with it, never gates owners", () => {
    for (const name of TENANT_AREA_TOOLS) {
      expect(deniedWriteTools('member', []).has(name), name).toBe(true);
      expect(deniedWriteTools('member', ['ai']).has(name), name).toBe(true);
      expect(deniedWriteTools('member', ['ai', 'properties']).has(name), name).toBe(true);
      expect(deniedWriteTools('member', ['ai', 'tenants']).has(name), name).toBe(false);
      expect(deniedWriteTools('owner', []).has(name), name).toBe(false);
    }
  });
});

describe('lease write tools — execution + audit attribution', () => {
  it('create_lease creates an active lease with its tenants and audits the passed actor', async () => {
    const { accountId, unitIds, tenantId } = await makeFixture('create');
    const lease = (await findServiceTool('create_lease')!.execute(
      accountId,
      {
        unitId: unitIds[0],
        tenantIds: [tenantId],
        rentCents: 185000,
        dueDay: 1,
        startDate: isoDaysOut(-30),
        endDate: isoDaysOut(335),
      },
      'system',
    )) as { id: string; status: string; rentCents: number };
    expect(lease.status).toBe('active');
    expect(lease.rentCents).toBe(185000);

    const detail = (await findServiceTool('get_lease')!.execute(
      accountId,
      { leaseId: lease.id },
      'system',
    )) as { lease: { tenants: Array<{ id: string; isPrimary: boolean }>; unitLabel: string } };
    expect(detail.lease.tenants.map((t) => t.id)).toEqual([tenantId]);
    expect(detail.lease.tenants[0]!.isPrimary).toBe(true);
    expect(detail.lease.unitLabel).toBe('U1');

    await expectAudit(accountId, 'create', 'lease', lease.id);
  });

  it('update_lease patches only the provided fields and audits', async () => {
    const { accountId, unitIds, tenantId } = await makeFixture('update');
    const lease = (await findServiceTool('create_lease')!.execute(
      accountId,
      {
        unitId: unitIds[0],
        tenantIds: [tenantId],
        rentCents: 150000,
        dueDay: 1,
        startDate: isoDaysOut(-10),
        endDate: isoDaysOut(355),
      },
      'system',
    )) as { id: string };

    const updated = (await findServiceTool('update_lease')!.execute(
      accountId,
      { leaseId: lease.id, rentCents: 162500 },
      'system',
    )) as { rentCents: number; dueDay: number; status: string };
    expect(updated.rentCents).toBe(162500);
    expect(updated.dueDay).toBe(1); // untouched
    expect(updated.status).toBe('active'); // untouched

    await expectAudit(accountId, 'update', 'lease', lease.id);
  });

  it('add/remove_tenant_from_lease maintain the roster, promote a primary, and audit', async () => {
    const { accountId, unitIds, tenantId } = await makeFixture('roster');
    const lease = (await findServiceTool('create_lease')!.execute(
      accountId,
      {
        unitId: unitIds[0],
        tenantIds: [tenantId],
        rentCents: 200000,
        dueDay: 1,
        startDate: isoDaysOut(-5),
        endDate: isoDaysOut(360),
      },
      'system',
    )) as { id: string };
    const coTenant = (await findServiceTool('create_tenant')!.execute(
      accountId,
      { fullName: 'Co Tenant', phone: '555-0100' },
      'system',
    )) as { id: string };

    const withCoTenant = (await findServiceTool('add_tenant_to_lease')!.execute(
      accountId,
      { leaseId: lease.id, tenantId: coTenant.id, shareCents: 100000 },
      'system',
    )) as { tenants: Array<{ id: string; isPrimary: boolean; shareCents: number | null }> };
    expect(withCoTenant.tenants).toHaveLength(2);
    expect(withCoTenant.tenants.find((t) => t.id === coTenant.id)?.shareCents).toBe(100000);
    await expectAudit(accountId, 'add_tenant', 'lease', lease.id);

    // Removing the primary promotes the remaining tenant.
    const afterRemoval = (await findServiceTool('remove_tenant_from_lease')!.execute(
      accountId,
      { leaseId: lease.id, tenantId },
      'system',
    )) as { tenants: Array<{ id: string; isPrimary: boolean }> };
    expect(afterRemoval.tenants.map((t) => t.id)).toEqual([coTenant.id]);
    expect(afterRemoval.tenants[0]!.isPrimary).toBe(true);
    await expectAudit(accountId, 'remove_tenant', 'lease', lease.id);

    // A lease must keep at least one tenant.
    await expect(
      findServiceTool('remove_tenant_from_lease')!.execute(
        accountId,
        { leaseId: lease.id, tenantId: coTenant.id },
        'system',
      ),
    ).rejects.toThrow(/at least one tenant/i);

    // The tenant records themselves survive the unlink.
    expect(await prisma.tenant.count({ where: { accountId } })).toBe(2);
  });

  it('renew_lease creates a real successor lease and ends the source one', async () => {
    const { accountId, unitIds, tenantId } = await makeFixture('renew');
    const source = (await findServiceTool('create_lease')!.execute(
      accountId,
      {
        unitId: unitIds[0],
        tenantIds: [tenantId],
        rentCents: 170000,
        dueDay: 1,
        startDate: isoDaysOut(-300),
        endDate: isoDaysOut(20),
      },
      'system',
    )) as { id: string };

    const draft = (await findServiceTool('draft_lease_renewal')!.execute(
      accountId,
      { leaseId: source.id },
      'system',
    )) as { suggestedRentCents: number; proposedStartDate: string; proposedEndDate: string };

    const renewed = (await findServiceTool('renew_lease')!.execute(
      accountId,
      {
        leaseId: source.id,
        rentCents: draft.suggestedRentCents,
        dueDay: 1,
        startDate: draft.proposedStartDate,
        endDate: draft.proposedEndDate,
      },
      'system',
    )) as { id: string; status: string; rentCents: number; unitId: string };

    expect(renewed.id).not.toBe(source.id);
    expect(renewed.status).toBe('active');
    expect(renewed.rentCents).toBe(draft.suggestedRentCents);
    expect(renewed.unitId).toBe(unitIds[0]);

    // Tenants carried over; the source lease is now ended.
    const successorTenants = await prisma.leaseTenant.findMany({ where: { leaseId: renewed.id } });
    expect(successorTenants.map((lt) => lt.tenantId)).toEqual([tenantId]);
    const sourceRow = await prisma.lease.findUniqueOrThrow({ where: { id: source.id } });
    expect(sourceRow.status).toBe('ended');

    await expectAudit(accountId, 'renew', 'lease', renewed.id);
  });

  it('terminate_lease ends the lease today and audits', async () => {
    const { accountId, unitIds, tenantId } = await makeFixture('terminate');
    const lease = (await findServiceTool('create_lease')!.execute(
      accountId,
      {
        unitId: unitIds[0],
        tenantIds: [tenantId],
        rentCents: 140000,
        dueDay: 1,
        startDate: isoDaysOut(-60),
        endDate: isoDaysOut(300),
      },
      'system',
    )) as { id: string };

    const terminated = (await findServiceTool('terminate_lease')!.execute(
      accountId,
      { leaseId: lease.id },
      'system',
    )) as { status: string; endDate: string };
    expect(terminated.status).toBe('ended');
    expect(new Date(terminated.endDate).getTime()).toBeLessThan(Date.now() + DAY_MS);

    await expectAudit(accountId, 'terminate', 'lease', lease.id);
  });

  it('create_tenant / update_tenant write the directory record and audit', async () => {
    const accountId = await makeAccount('tenantrec');
    const tenant = (await findServiceTool('create_tenant')!.execute(
      accountId,
      { fullName: 'Dana Rivers', email: `dana${EMAIL_SUFFIX}`, phone: '555-0199' },
      'system',
    )) as { id: string; fullName: string };
    expect(tenant.fullName).toBe('Dana Rivers');
    await expectAudit(accountId, 'create', 'tenant', tenant.id);

    const updated = (await findServiceTool('update_tenant')!.execute(
      accountId,
      { tenantId: tenant.id, phone: '555-0200' },
      'system',
    )) as { phone: string | null; fullName: string; email: string | null };
    expect(updated.phone).toBe('555-0200');
    expect(updated.fullName).toBe('Dana Rivers'); // untouched
    expect(updated.email).toBe(`dana${EMAIL_SUFFIX}`); // untouched
    await expectAudit(accountId, 'update', 'tenant', tenant.id);
  });
});

describe('lease write tools — cross-account isolation', () => {
  it("refuses to lease another account's unit or read/patch its lease", async () => {
    const mine = await makeFixture('isolate-a');
    const theirs = await makeFixture('isolate-b');

    await expect(
      findServiceTool('create_lease')!.execute(
        theirs.accountId,
        {
          unitId: mine.unitIds[0],
          tenantIds: [theirs.tenantId],
          rentCents: 100000,
          dueDay: 1,
          startDate: isoDaysOut(-1),
          endDate: isoDaysOut(364),
        },
        'system',
      ),
    ).rejects.toThrow(/unit/i);

    const lease = (await findServiceTool('create_lease')!.execute(
      mine.accountId,
      {
        unitId: mine.unitIds[0],
        tenantIds: [mine.tenantId],
        rentCents: 100000,
        dueDay: 1,
        startDate: isoDaysOut(-1),
        endDate: isoDaysOut(364),
      },
      'system',
    )) as { id: string };

    await expect(
      findServiceTool('get_lease')!.execute(theirs.accountId, { leaseId: lease.id }, 'system'),
    ).rejects.toThrow(/lease/i);
    await expect(
      findServiceTool('update_lease')!.execute(
        theirs.accountId,
        { leaseId: lease.id, rentCents: 1 },
        'system',
      ),
    ).rejects.toThrow(/lease/i);
    await expect(
      findServiceTool('terminate_lease')!.execute(theirs.accountId, { leaseId: lease.id }, 'system'),
    ).rejects.toThrow(/lease/i);
  });

  it("add_tenant_to_lease refuses a tenant from another account", async () => {
    const mine = await makeFixture('isolate-c');
    const theirs = await makeFixture('isolate-d');
    const lease = (await findServiceTool('create_lease')!.execute(
      mine.accountId,
      {
        unitId: mine.unitIds[0],
        tenantIds: [mine.tenantId],
        rentCents: 100000,
        dueDay: 1,
        startDate: isoDaysOut(-1),
        endDate: isoDaysOut(364),
      },
      'system',
    )) as { id: string };

    await expect(
      findServiceTool('add_tenant_to_lease')!.execute(
        mine.accountId,
        { leaseId: lease.id, tenantId: theirs.tenantId },
        'system',
      ),
    ).rejects.toThrow(/tenant/i);
  });
});

describe('lease write tools — MCP', () => {
  it('creates a lease via the MCP server with system attribution', async () => {
    const { accountId, unitIds, tenantId } = await makeFixture('mcp');

    const server = createMcpServer({ accountId, allowWrites: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'lease-tool-test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const res = (await client.callTool({
        name: 'create_lease',
        arguments: {
          unitId: unitIds[0],
          tenantIds: [tenantId],
          rentCents: 210000,
          dueDay: 5,
          startDate: isoDaysOut(-2),
          endDate: isoDaysOut(363),
        },
      })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      expect(res.isError ?? false).toBe(false);
      const lease = JSON.parse(res.content[0]!.text) as { id: string; rentCents: number };
      expect(lease.rentCents).toBe(210000);

      await expectAudit(accountId, 'create', 'lease', lease.id);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
