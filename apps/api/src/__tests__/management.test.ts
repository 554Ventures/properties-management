// Phase 2 full-CRUD: soft-archive + restore, archive guards, lease lifecycle
// (terminate, co-tenants, renewal), archive filtering, and audit attribution.
// Every entity this file creates is cleaned up in afterAll so the seeded
// portfolio (asserted by the pinned constants elsewhere) stays pristine.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  LeaseDetailResponseSchema,
  LeaseSchema,
  LeaseWithContextSchema,
  PropertyListResponseSchema,
  PropertySchema,
  RentTrackerResponseSchema,
  TenantSchema,
} from '@hearth/shared';
import {
  NET_CASHFLOW_MTD_CENTS,
  PAID_UNITS,
  TAX_SET_ASIDE_CURRENT_CENTS,
  TAX_SET_ASIDE_TARGET_CENTS,
  TOTAL_UNITS,
} from '../../prisma/seed-constants';
import { buildApp } from '../app';
import { currentPeriod, iso } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';

let app: FastifyInstance;
let accountId: string;

// Everything created here (any id that could carry an AuditLog) is torn down.
const createdPropertyIds: string[] = [];
const createdTenantIds: string[] = [];
const createdTransactionIds: string[] = [];
const touchedEntityIds = new Set<string>();

const API = '/api/v1';

beforeAll(async () => {
  app = await buildApp();
  accountId = await getDemoAccountId();
});

afterAll(async () => {
  // Some tests below hit GET /properties/:id, which runs generateInsights as a
  // side effect (property.service.ts → insight.service.ts) before this file's
  // temp properties/tenants are archived — Insight→Property/Tenant is SetNull,
  // not Cascade, so deleting them would leave the generated row behind,
  // "active" forever with a null propertyId/tenantId, and leak into any other
  // file's exact-dedupeKey assertions (insights.test.ts). Clean those up first.
  await prisma.insight.deleteMany({
    where: {
      OR: [
        { propertyId: { in: createdPropertyIds } },
        { tenantId: { in: createdTenantIds } },
      ],
    },
  });
  // Transactions first: Transaction→Property is SetNull, so deleting a property
  // would orphan its transactions as account-level rows and skew other files' KPIs.
  await prisma.transaction.deleteMany({ where: { id: { in: createdTransactionIds } } });
  // Properties cascade to units → leases → leaseTenants/rentPayments.
  await prisma.property.deleteMany({ where: { id: { in: createdPropertyIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [...touchedEntityIds] } } });
  await app.close();
});

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `${API}${url}`, payload: payload as never });
}

/** Create an isolated property + unit + tenant + active lease for lifecycle tests. */
async function makeSandboxLease(opts?: { label?: string }): Promise<{
  propertyId: string;
  unitId: string;
  tenantId: string;
  leaseId: string;
}> {
  const propRes = await inject('POST', '/properties', {
    addressLine1: `Sandbox ${Math.random().toString(36).slice(2, 8)}`,
    city: 'Springfield',
    state: 'IL',
    zip: '62704',
    units: [{ label: opts?.label ?? 'Main', bedrooms: 2, bathrooms: 1, marketRentCents: 100000 }],
  });
  const property = PropertySchema.parse(propRes.json());
  createdPropertyIds.push(property.id);
  touchedEntityIds.add(property.id);
  const unit = await prisma.unit.findFirstOrThrow({ where: { propertyId: property.id } });
  touchedEntityIds.add(unit.id);

  const tenantRes = await inject('POST', '/tenants', { fullName: 'Sandbox Tenant' });
  const tenant = TenantSchema.parse(tenantRes.json());
  createdTenantIds.push(tenant.id);
  touchedEntityIds.add(tenant.id);

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), 1));
  const leaseRes = await inject('POST', '/leases', {
    unitId: unit.id,
    tenantIds: [tenant.id],
    rentCents: 100000,
    dueDay: 1,
    startDate: iso(start),
    endDate: iso(end),
  });
  const lease = LeaseSchema.parse(leaseRes.json());
  touchedEntityIds.add(lease.id);
  return { propertyId: property.id, unitId: unit.id, tenantId: tenant.id, leaseId: lease.id };
}

// Runs first: the exact-count assertions require a pristine seed, and the
// sandbox leases the later describes leave active (until afterAll) would inflate
// totalUnits. The archive-effect test cleans up its own unit's tracker impact.
describe('seed invariance + archive effect on derivations', () => {
  it('KPIs equal the pinned constants when nothing is archived', async () => {
    const kpis = (await inject('GET', '/dashboard/kpis')).json();
    expect(kpis.totalUnits).toBe(TOTAL_UNITS);
    expect(kpis.paidUnits).toBe(PAID_UNITS);
    expect(kpis.netCashFlowMtdCents).toBe(NET_CASHFLOW_MTD_CENTS);
    expect(kpis.taxSetAside.currentCents).toBe(TAX_SET_ASIDE_CURRENT_CENTS);
    expect(kpis.taxSetAside.targetCents).toBe(TAX_SET_ASIDE_TARGET_CENTS);
  });

  it('archiving an occupied unit drops totalUnits by 1 and clears it from the tracker', async () => {
    const period = currentPeriod();
    const { unitId, leaseId } = await makeSandboxLease({ label: 'Trackable' });

    const before = RentTrackerResponseSchema.parse(
      (await inject('GET', `/rent/tracker?period=${period}`)).json(),
    );
    expect(before.totalUnits).toBe(TOTAL_UNITS + 1);
    expect(before.rows.some((r) => r.unitId === unitId)).toBe(true);

    // Guard requires terminating the active lease before the unit can be archived.
    expect((await inject('POST', `/leases/${leaseId}/terminate`)).statusCode).toBe(200);
    expect((await inject('DELETE', `/units/${unitId}`)).statusCode).toBe(204);

    const after = RentTrackerResponseSchema.parse(
      (await inject('GET', `/rent/tracker?period=${period}`)).json(),
    );
    expect(after.totalUnits).toBe(TOTAL_UNITS);
    expect(after.rows.some((r) => r.unitId === unitId)).toBe(false);

    // KPIs are back to the pinned baseline once the sandbox unit is gone.
    const kpis = (await inject('GET', '/dashboard/kpis')).json();
    expect(kpis.totalUnits).toBe(TOTAL_UNITS);
    expect(kpis.netCashFlowMtdCents).toBe(NET_CASHFLOW_MTD_CENTS);
  });
});

describe('archived-property money treatment (dashboard excludes, reports retain)', () => {
  it('drops an archived property from dashboard KPIs but keeps it in the property P&L', async () => {
    const propRes = await inject('POST', '/properties', {
      addressLine1: 'Money Rd',
      city: 'Springfield',
      state: 'IL',
      zip: '62704',
      units: [{ label: 'Main' }],
    });
    const property = PropertySchema.parse(propRes.json());
    createdPropertyIds.push(property.id);
    touchedEntityIds.add(property.id);

    // A confirmed income transaction dated this month, tied to the property.
    const amountCents = 77_700;
    const txn = await prisma.transaction.create({
      data: {
        accountId,
        propertyId: property.id,
        date: new Date(),
        amountCents,
        type: 'income',
        description: 'Sandbox income',
        source: 'manual',
        status: 'confirmed',
      },
    });
    createdTransactionIds.push(txn.id);

    const before = (await inject('GET', '/dashboard/kpis')).json();
    expect(before.netCashFlowMtdCents).toBe(NET_CASHFLOW_MTD_CENTS + amountCents);

    // Archive is allowed (no active lease); the property leaves the active portfolio.
    expect((await inject('DELETE', `/properties/${property.id}`)).statusCode).toBe(204);

    const after = (await inject('GET', '/dashboard/kpis')).json();
    expect(after.netCashFlowMtdCents).toBe(NET_CASHFLOW_MTD_CENTS);

    // But the per-property P&L (a financial report) still includes the income —
    // archived history is retained for accounting/tax accuracy.
    const pnl = await inject('GET', `/properties/${property.id}/pnl`);
    expect(pnl.statusCode).toBe(200);
    expect(pnl.json().incomeCents).toBeGreaterThanOrEqual(amountCents);
  });
});

describe('soft-archive + restore round-trip', () => {
  it('archives a property (hidden from list, still resolvable), then restores it', async () => {
    const propRes = await inject('POST', '/properties', {
      addressLine1: 'Archive Me Rd',
      city: 'Springfield',
      state: 'IL',
      zip: '62704',
      units: [{ label: 'Main' }],
    });
    const property = PropertySchema.parse(propRes.json());
    createdPropertyIds.push(property.id);
    touchedEntityIds.add(property.id);

    const listBefore = PropertyListResponseSchema.parse((await inject('GET', '/properties')).json());
    expect(listBefore.some((p) => p.id === property.id)).toBe(true);

    const del = await inject('DELETE', `/properties/${property.id}`);
    expect(del.statusCode).toBe(204);

    const listAfter = PropertyListResponseSchema.parse((await inject('GET', '/properties')).json());
    expect(listAfter.some((p) => p.id === property.id)).toBe(false);

    // Detail still resolves the archived property (history retention).
    const detail = await inject('GET', `/properties/${property.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().property.archivedAt).not.toBeNull();

    const restore = await inject('POST', `/properties/${property.id}/restore`);
    expect(restore.statusCode).toBe(200);
    expect(PropertySchema.parse(restore.json()).archivedAt).toBeNull();

    const listRestored = PropertyListResponseSchema.parse(
      (await inject('GET', '/properties')).json(),
    );
    expect(listRestored.some((p) => p.id === property.id)).toBe(true);

    // Audit: archive + restore recorded with actor 'user'.
    const archiveAudit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'archive', entityType: 'property', entityId: property.id },
    });
    expect(archiveAudit?.actor).toBe('user');
    const restoreAudit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'restore', entityType: 'property', entityId: property.id },
    });
    expect(restoreAudit?.actor).toBe('user');
  });

  it('archives + restores a tenant with no active lease', async () => {
    const tenantRes = await inject('POST', '/tenants', { fullName: 'Zzz Archivable' });
    const tenant = TenantSchema.parse(tenantRes.json());
    createdTenantIds.push(tenant.id);
    touchedEntityIds.add(tenant.id);

    expect((await inject('DELETE', `/tenants/${tenant.id}`)).statusCode).toBe(204);
    const list = (await inject('GET', '/tenants')).json() as Array<{ id: string }>;
    expect(list.some((t) => t.id === tenant.id)).toBe(false);
    // Detail still resolves.
    expect((await inject('GET', `/tenants/${tenant.id}`)).statusCode).toBe(200);

    const restore = await inject('POST', `/tenants/${tenant.id}/restore`);
    expect(restore.statusCode).toBe(200);
    const list2 = (await inject('GET', '/tenants')).json() as Array<{ id: string }>;
    expect(list2.some((t) => t.id === tenant.id)).toBe(true);
  });
});

describe('archive guard (active lease blocks archiving)', () => {
  it('rejects archiving a property/unit/tenant that still has an active lease', async () => {
    const { propertyId, unitId, tenantId } = await makeSandboxLease();

    const prop = await inject('DELETE', `/properties/${propertyId}`);
    expect(prop.statusCode).toBe(409);
    expect(prop.json().error.code).toBe('conflict');

    expect((await inject('DELETE', `/units/${unitId}`)).statusCode).toBe(409);
    expect((await inject('DELETE', `/tenants/${tenantId}`)).statusCode).toBe(409);
  });
});

describe('lease lifecycle', () => {
  it('GET /leases/:id returns a LeaseDetailResponse', async () => {
    const leases = (await inject('GET', '/leases?status=active')).json() as Array<{ id: string }>;
    const detail = await inject('GET', `/leases/${leases[0]!.id}`);
    expect(detail.statusCode).toBe(200);
    const parsed = LeaseDetailResponseSchema.parse(detail.json());
    expect(parsed.lease.tenants.length).toBeGreaterThanOrEqual(1);
    expect(parsed.lease.propertyLabel.length).toBeGreaterThan(0);
  });

  it('terminate sets status ended and audits with actor user', async () => {
    const { leaseId } = await makeSandboxLease();
    const res = await inject('POST', `/leases/${leaseId}/terminate`);
    expect(res.statusCode).toBe(200);
    expect(LeaseSchema.parse(res.json()).status).toBe('ended');

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'terminate', entityType: 'lease', entityId: leaseId },
    });
    expect(audit?.actor).toBe('user');
  });

  it('adds/removes co-tenants with last-tenant guard and primary auto-promotion', async () => {
    const { leaseId } = await makeSandboxLease();
    const primary = await prisma.leaseTenant.findFirstOrThrow({ where: { leaseId } });
    const primaryTenantId = primary.tenantId;

    // Second tenant.
    const t2Res = await inject('POST', '/tenants', { fullName: 'Co Tenant' });
    const t2 = TenantSchema.parse(t2Res.json());
    createdTenantIds.push(t2.id);
    touchedEntityIds.add(t2.id);

    const add = await inject('POST', `/leases/${leaseId}/tenants`, { tenantId: t2.id });
    expect(add.statusCode).toBe(200);
    const ctx = LeaseWithContextSchema.parse(add.json());
    expect(ctx.tenants.map((t) => t.id).sort()).toEqual([primaryTenantId, t2.id].sort());

    // Adding the same tenant again conflicts.
    expect((await inject('POST', `/leases/${leaseId}/tenants`, { tenantId: t2.id })).statusCode).toBe(
      409,
    );

    // Remove the primary → the remaining tenant is auto-promoted.
    const remove = await inject('DELETE', `/leases/${leaseId}/tenants/${primaryTenantId}`);
    expect(remove.statusCode).toBe(200);
    LeaseWithContextSchema.parse(remove.json());
    const promoted = await prisma.leaseTenant.findFirstOrThrow({
      where: { leaseId, tenantId: t2.id },
    });
    expect(promoted.isPrimary).toBe(true);

    // Cannot remove the last remaining tenant.
    const removeLast = await inject('DELETE', `/leases/${leaseId}/tenants/${t2.id}`);
    expect(removeLast.statusCode).toBe(409);

    const addAudit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'add_tenant', entityType: 'lease', entityId: leaseId },
    });
    expect(addAudit?.actor).toBe('user');
    const removeAudit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'remove_tenant', entityType: 'lease', entityId: leaseId },
    });
    expect(removeAudit?.actor).toBe('user');
  });

  it('renewal creates a new active lease with copied tenants and ends the source', async () => {
    const { leaseId, tenantId } = await makeSandboxLease();
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear() + 2, now.getUTCMonth(), 1));

    const res = await inject('POST', `/leases/${leaseId}/renewal`, {
      rentCents: 105000,
      dueDay: 1,
      startDate: iso(start),
      endDate: iso(end),
    });
    expect(res.statusCode).toBe(201);
    const newLease = LeaseSchema.parse(res.json());
    touchedEntityIds.add(newLease.id);
    expect(newLease.status).toBe('active');
    expect(newLease.rentCents).toBe(105000);
    expect(newLease.id).not.toBe(leaseId);

    // Source lease ended at the new lease's start boundary.
    const source = await prisma.lease.findUniqueOrThrow({ where: { id: leaseId } });
    expect(source.status).toBe('ended');
    expect(iso(source.endDate)).toBe(iso(start));

    // Tenants copied to the new lease.
    const newTenants = await prisma.leaseTenant.findMany({ where: { leaseId: newLease.id } });
    expect(newTenants.map((lt) => lt.tenantId)).toContain(tenantId);

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'renew', entityType: 'lease', entityId: newLease.id },
    });
    expect(audit?.actor).toBe('user');
  });
});

describe('create/update audit attribution', () => {
  it('logs create + update for property, unit, tenant, lease with actor user', async () => {
    const { propertyId, tenantId, leaseId } = await makeSandboxLease();
    // Units created inline with the property are covered by the property audit;
    // a standalone unit create (POST /properties/:id/units) is audited on its own.
    const unitRes = await inject('POST', `/properties/${propertyId}/units`, { label: 'Audited' });
    const unitId = (unitRes.json() as { id: string }).id;
    touchedEntityIds.add(unitId);

    for (const [entityType, entityId] of [
      ['property', propertyId],
      ['unit', unitId],
      ['tenant', tenantId],
      ['lease', leaseId],
    ] as const) {
      const create = await prisma.auditLog.findFirst({
        where: { accountId, action: 'create', entityType, entityId },
      });
      expect(create?.actor, `create ${entityType}`).toBe('user');
    }

    // PATCH each and assert an update audit.
    await inject('PATCH', `/properties/${propertyId}`, { nickname: 'Renamed' });
    await inject('PATCH', `/units/${unitId}`, { label: 'Renamed' });
    await inject('PATCH', `/tenants/${tenantId}`, { fullName: 'Renamed Tenant' });
    await inject('PATCH', `/leases/${leaseId}`, { rentCents: 101000 });

    for (const [entityType, entityId] of [
      ['property', propertyId],
      ['unit', unitId],
      ['tenant', tenantId],
      ['lease', leaseId],
    ] as const) {
      const update = await prisma.auditLog.findFirst({
        where: { accountId, action: 'update', entityType, entityId },
      });
      expect(update?.actor, `update ${entityType}`).toBe('user');
    }
  });
});
