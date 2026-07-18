import type {
  CreatePropertyInput,
  GraceDaysBasis,
  PnlTotals,
  Property,
  PropertyDetailResponse,
  PropertyListResponse,
  PropertyPnlResponse,
  TransactionType,
  UpdatePropertyInput,
} from '@hearth/shared';
import type { Property as DbProperty } from '@prisma/client';
import {
  currentPeriodInTz,
  iso,
  isoOrNull,
  monthEndExclusiveInTz,
  monthStartInTz,
  yearRangeInTz,
} from '../lib/dates';
import { ConflictError, NotFoundError } from '../lib/errors';
import { pnlBucket, pnlSums } from '../lib/pnl';
import { prisma } from '../lib/prisma';
import { writeAudit, type AuditActor } from './audit.service';
import { generateInsights, toApiInsight } from './insight.service';
import { toApiLease } from './lease.service';
import { currentRentSnapshot, deriveRentStatus } from './rent.service';
import { toTenantOnLease } from './tenant.service';

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
async function lateUnitIds(
  accountId: string,
  graceDays: number,
  graceDaysBasis: GraceDaysBasis,
  tz: string,
): Promise<Set<string>> {
  const period = currentPeriodInTz(tz);
  const payments = await prisma.rentPayment.findMany({
    where: {
      period,
      status: { notIn: ['paid'] },
      lease: { unit: { archivedAt: null, property: { accountId, archivedAt: null } } },
    },
    select: {
      status: true,
      dueDate: true,
      amountCents: true,
      paidCents: true,
      lease: { select: { unitId: true } },
    },
  });
  const late = new Set<string>();
  for (const p of payments) {
    // daysLate presence covers both fully-unpaid `late` and partial-but-past-
    // grace rows — a half-paid tenant past the grace window is still late.
    if (deriveRentStatus(p, graceDays, graceDaysBasis, tz).daysLate !== undefined) {
      late.add(p.lease.unitId);
    }
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
  const late = await lateUnitIds(
    accountId,
    account.graceDays,
    account.graceDaysBasis as GraceDaysBasis,
    account.timezone,
  );

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

export async function pnlTotals(
  accountId: string,
  range: { from: Date; to: Date },
  scope: { propertyId?: string; unitId?: string } = {},
): Promise<PnlTotals> {
  const grouped = await prisma.transaction.groupBy({
    by: ['type', 'classification'],
    where: {
      accountId,
      status: 'confirmed',
      date: { gte: range.from, lt: range.to },
      ...(scope.propertyId ? { propertyId: scope.propertyId } : {}),
      ...(scope.unitId ? { unitId: scope.unitId } : {}),
    },
    _sum: { amountCents: true },
  });
  // Transfers/owner contributions never count; refunds net against expenses.
  return pnlSums(grouped);
}

export async function getDetail(accountId: string, id: string): Promise<PropertyDetailResponse> {
  const property = await getOwned(accountId, id);
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const units = await prisma.unit.findMany({
    where: { propertyId: id },
    include: {
      leases: {
        where: { status: { in: ['active', 'pending_signature'] } },
        include: { leaseTenants: { include: { tenant: true }, orderBy: { isPrimary: 'desc' } } },
      },
      _count: { select: { leases: true } },
    },
    orderBy: { label: 'asc' },
  });

  const now = new Date();
  const tz = account.timezone;
  const period = currentPeriodInTz(tz, now);

  // This month's charge per unit, read-only. Keyed by unitId (not leaseId):
  // one charge per unit per month, and a renewal switchover leaves the
  // month's charge on the outgoing lease (rent.service materialization guard).
  const payments = await prisma.rentPayment.findMany({
    where: { period, lease: { unitId: { in: units.map((u) => u.id) } } },
    include: { lease: { select: { unitId: true } } },
  });
  const paymentByUnit = new Map(payments.map((p) => [p.lease.unitId, p]));
  const mtd = await pnlTotals(
    accountId,
    { from: monthStartInTz(period, tz), to: monthEndExclusiveInTz(period, tz) },
    { propertyId: id },
  );
  const ytd = await pnlTotals(
    accountId,
    { from: yearRangeInTz(Number(period.slice(0, 4)), tz).from, to: monthEndExclusiveInTz(period, tz) },
    { propertyId: id },
  );

  // Same staleness fix as getDashboardInsight/list (insight.service.ts): the
  // only other producer of new Insight rows is the once-a-day scheduler, so
  // refresh against current data before reading this property's cards.
  await generateInsights(accountId);
  const insights = await prisma.insight.findMany({
    where: { accountId, propertyId: id, status: 'active' },
    orderBy: { createdAt: 'desc' },
  });

  return {
    property: toApiProperty(property),
    units: units.map((u) => {
      const lease = u.leases.find((l) => l.status === 'active');
      const pending = u.leases.find((l) => l.status === 'pending_signature');

      const rent = currentRentSnapshot(lease, paymentByUnit.get(u.id), {
        period,
        tz,
        graceDays: account.graceDays,
        graceDaysBasis: account.graceDaysBasis as GraceDaysBasis,
        now,
      });

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
          ? { ...toApiLease(lease), tenants: lease.leaseTenants.map(toTenantOnLease) }
          : null,
        rent,
        leaseCount: u._count.leases,
        pendingLease: pending
          ? { ...toApiLease(pending), tenants: pending.leaseTenants.map(toTenantOnLease) }
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
    const b = pnlBucket(t);
    if (!b) continue; // transfers/owner contributions don't count
    if (b.bucket === 'income') incomeCents += b.amountCents;
    else expenseCents += b.amountCents; // refunds arrive here negative
    const key = `${t.categoryId ?? 'uncategorized'}:${b.bucket}`;
    const line = byCategory.get(key) ?? {
      categoryId: t.categoryId,
      categoryName: t.category?.name ?? 'Uncategorized',
      type: b.bucket as TransactionType,
      totalCents: 0,
    };
    line.totalCents += b.amountCents;
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
