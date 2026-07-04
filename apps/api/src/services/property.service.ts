import type {
  CreatePropertyInput,
  PnlTotals,
  Property,
  PropertyDetailResponse,
  PropertyListResponse,
  PropertyPnlResponse,
  TransactionType,
  UpdatePropertyInput,
} from '@hearth/shared';
import type { Property as DbProperty } from '@prisma/client';
import { currentPeriod, iso, isoOrNull, monthEndExclusive, monthStart } from '../lib/dates';
import { ConflictError, NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { writeAudit, type AuditActor } from './audit.service';
import { toApiInsight } from './insight.service';
import { toApiLease } from './lease.service';
import { deriveRentStatus } from './rent.service';
import { toApiTenant } from './tenant.service';

export function toApiProperty(p: DbProperty): Property {
  return {
    id: p.id,
    accountId: p.accountId,
    nickname: p.nickname,
    addressLine1: p.addressLine1,
    city: p.city,
    state: p.state,
    zip: p.zip,
    acquisitionDate: isoOrNull(p.acquisitionDate),
    acquisitionCostCents: p.acquisitionCostCents,
    notes: p.notes,
    createdAt: iso(p.createdAt),
    archivedAt: isoOrNull(p.archivedAt),
  };
}

export function propertyLabel(p: { nickname: string | null; addressLine1: string }): string {
  return p.nickname ?? p.addressLine1;
}

/** unitIds with an unpaid, past-due rent payment for the current period. */
async function lateUnitIds(accountId: string, graceDays: number): Promise<Set<string>> {
  const period = currentPeriod();
  const payments = await prisma.rentPayment.findMany({
    where: {
      period,
      status: { notIn: ['paid'] },
      lease: { unit: { archivedAt: null, property: { accountId, archivedAt: null } } },
    },
    select: { status: true, dueDate: true, lease: { select: { unitId: true } } },
  });
  const late = new Set<string>();
  for (const p of payments) {
    if (deriveRentStatus(p, graceDays).status === 'late') late.add(p.lease.unitId);
  }
  return late;
}

export async function list(accountId: string): Promise<PropertyListResponse> {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const properties = await prisma.property.findMany({
    where: { accountId, archivedAt: null },
    include: {
      units: {
        where: { archivedAt: null },
        include: { leases: { where: { status: 'active' } } },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  const late = await lateUnitIds(accountId, account.graceDays);

  return properties.map((p) => {
    const unitCount = p.units.length;
    const occupiedUnits = p.units.filter((u) => u.leases.length > 0);
    const monthlyRentCents = occupiedUnits.reduce(
      (sum, u) => sum + (u.leases[0]?.rentCents ?? 0),
      0,
    );
    const lateCount = p.units.filter((u) => late.has(u.id)).length;
    const vacantCount = unitCount - occupiedUnits.length;
    const statusLabel =
      lateCount > 0
        ? `${lateCount} late`
        : vacantCount > 0
          ? `${vacantCount} vacant`
          : 'Full';
    return {
      ...toApiProperty(p),
      unitCount,
      occupiedCount: occupiedUnits.length,
      monthlyRentCents,
      statusLabel,
    };
  });
}

async function getOwned(accountId: string, id: string): Promise<DbProperty> {
  const row = await prisma.property.findFirst({ where: { id, accountId } });
  if (!row) throw new NotFoundError('property', id);
  return row;
}

async function pnlTotals(
  accountId: string,
  range: { from: Date; to: Date },
  propertyId?: string,
): Promise<PnlTotals> {
  const grouped = await prisma.transaction.groupBy({
    by: ['type'],
    where: {
      accountId,
      status: 'confirmed',
      date: { gte: range.from, lt: range.to },
      ...(propertyId ? { propertyId } : {}),
    },
    _sum: { amountCents: true },
  });
  const incomeCents = grouped.find((g) => g.type === 'income')?._sum.amountCents ?? 0;
  const expenseCents = grouped.find((g) => g.type === 'expense')?._sum.amountCents ?? 0;
  return { incomeCents, expenseCents, netCents: incomeCents - expenseCents };
}

export async function getDetail(accountId: string, id: string): Promise<PropertyDetailResponse> {
  const property = await getOwned(accountId, id);
  const units = await prisma.unit.findMany({
    where: { propertyId: id },
    include: {
      leases: {
        where: { status: 'active' },
        include: { leaseTenants: { include: { tenant: true }, orderBy: { isPrimary: 'desc' } } },
      },
    },
    orderBy: { label: 'asc' },
  });

  const now = new Date();
  const period = currentPeriod(now);
  const mtd = await pnlTotals(
    accountId,
    { from: monthStart(period), to: monthEndExclusive(period) },
    id,
  );
  const ytd = await pnlTotals(
    accountId,
    { from: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)), to: monthEndExclusive(period) },
    id,
  );

  const insights = await prisma.insight.findMany({
    where: { accountId, propertyId: id, status: 'active' },
    orderBy: { createdAt: 'desc' },
  });

  return {
    property: toApiProperty(property),
    units: units.map((u) => {
      const lease = u.leases[0];
      return {
        id: u.id,
        propertyId: u.propertyId,
        label: u.label,
        bedrooms: u.bedrooms,
        bathrooms: u.bathrooms,
        marketRentCents: u.marketRentCents,
        archivedAt: isoOrNull(u.archivedAt),
        status: lease ? ('occupied' as const) : ('vacant' as const),
        currentLease: lease
          ? { ...toApiLease(lease), tenants: lease.leaseTenants.map((lt) => toApiTenant(lt.tenant)) }
          : null,
      };
    }),
    pnl: { mtd, ytd },
    insights: insights.map(toApiInsight),
  };
}

export async function create(
  accountId: string,
  input: CreatePropertyInput,
  actor: AuditActor = 'user',
): Promise<Property> {
  const row = await prisma.property.create({
    data: {
      accountId,
      nickname: input.nickname ?? null,
      addressLine1: input.addressLine1,
      city: input.city,
      state: input.state,
      zip: input.zip,
      acquisitionDate: input.acquisitionDate ? new Date(input.acquisitionDate) : null,
      acquisitionCostCents: input.acquisitionCostCents ?? null,
      notes: input.notes ?? null,
      units: {
        create: input.units.map((u) => ({
          label: u.label,
          bedrooms: u.bedrooms ?? null,
          bathrooms: u.bathrooms ?? null,
          marketRentCents: u.marketRentCents ?? null,
        })),
      },
    },
  });
  await writeAudit(accountId, {
    actor,
    action: 'create',
    entityType: 'property',
    entityId: row.id,
    detail: { addressLine1: row.addressLine1, unitCount: input.units.length },
  });
  return toApiProperty(row);
}

export async function update(
  accountId: string,
  id: string,
  input: UpdatePropertyInput,
  actor: AuditActor = 'user',
): Promise<Property> {
  await getOwned(accountId, id);
  const row = await prisma.property.update({
    where: { id },
    data: {
      ...(input.nickname !== undefined ? { nickname: input.nickname } : {}),
      ...(input.addressLine1 !== undefined ? { addressLine1: input.addressLine1 } : {}),
      ...(input.city !== undefined ? { city: input.city } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(input.zip !== undefined ? { zip: input.zip } : {}),
      ...(input.acquisitionDate !== undefined
        ? { acquisitionDate: new Date(input.acquisitionDate) }
        : {}),
      ...(input.acquisitionCostCents !== undefined
        ? { acquisitionCostCents: input.acquisitionCostCents }
        : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
  });
  await writeAudit(accountId, {
    actor,
    action: 'update',
    entityType: 'property',
    entityId: id,
    detail: { nickname: row.nickname, addressLine1: row.addressLine1 },
  });
  return toApiProperty(row);
}

/**
 * Soft-archive. Blocked while any unit still has an active lease; the property's
 * units/leases are hidden via query filters (not stamped), so restore is trivial.
 */
export async function remove(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<void> {
  await getOwned(accountId, id);
  const activeLease = await prisma.lease.findFirst({
    where: { status: 'active', unit: { propertyId: id } },
  });
  if (activeLease) {
    throw new ConflictError('Terminate the active lease before archiving this property.');
  }
  await prisma.property.update({ where: { id }, data: { archivedAt: new Date() } });
  await writeAudit(accountId, { actor, action: 'archive', entityType: 'property', entityId: id });
}

export async function restore(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<Property> {
  await getOwned(accountId, id);
  const row = await prisma.property.update({ where: { id }, data: { archivedAt: null } });
  await writeAudit(accountId, { actor, action: 'restore', entityType: 'property', entityId: id });
  return toApiProperty(row);
}

export async function getPnl(
  accountId: string,
  id: string,
  range: { from: Date; to: Date },
): Promise<PropertyPnlResponse> {
  await getOwned(accountId, id);
  const txns = await prisma.transaction.findMany({
    where: {
      accountId,
      propertyId: id,
      status: 'confirmed',
      date: { gte: range.from, lt: range.to },
    },
    include: { category: true },
  });
  const byCategory = new Map<
    string,
    { categoryId: string | null; categoryName: string; type: TransactionType; totalCents: number }
  >();
  let incomeCents = 0;
  let expenseCents = 0;
  for (const t of txns) {
    if (t.type === 'income') incomeCents += t.amountCents;
    else expenseCents += t.amountCents;
    const key = `${t.categoryId ?? 'uncategorized'}:${t.type}`;
    const line = byCategory.get(key) ?? {
      categoryId: t.categoryId,
      categoryName: t.category?.name ?? 'Uncategorized',
      type: t.type as TransactionType,
      totalCents: 0,
    };
    line.totalCents += t.amountCents;
    byCategory.set(key, line);
  }
  return {
    propertyId: id,
    from: iso(range.from),
    to: iso(range.to),
    incomeCents,
    expenseCents,
    netCents: incomeCents - expenseCents,
    lines: [...byCategory.values()].sort((a, b) => b.totalCents - a.totalCents),
  };
}
