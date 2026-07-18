import type {
  CreateUnitInput,
  GraceDaysBasis,
  Unit,
  UnitDetailResponse,
  UpdateUnitInput,
} from '@hearth/shared';
import type { Unit as DbUnit } from '@prisma/client';
import {
  currentPeriodInTz,
  iso,
  isoOrNull,
  monthEndExclusiveInTz,
  monthStartInTz,
  yearRangeInTz,
} from '../lib/dates';
import { ConflictError, NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { writeAudit, type AuditActor } from './audit.service';
import { toApiLease } from './lease.service';
import { pnlTotals, propertyLabel } from './property.service';
import { currentRentSnapshot, deriveRentStatus } from './rent.service';
import { toTenantOnLease } from './tenant.service';

export function toApiUnit(u: DbUnit): Unit {
  return {
    id: u.id,
    propertyId: u.propertyId,
    label: u.label,
    bedrooms: u.bedrooms,
    bathrooms: u.bathrooms,
    marketRentCents: u.marketRentCents,
    archivedAt: isoOrNull(u.archivedAt),
  };
}

export async function create(
  accountId: string,
  propertyId: string,
  input: CreateUnitInput,
  actor: AuditActor = 'user',
): Promise<Unit> {
  const property = await prisma.property.findFirst({ where: { id: propertyId, accountId } });
  if (!property) throw new NotFoundError('property', propertyId);
  const row = await prisma.unit.create({
    data: {
      propertyId,
      label: input.label,
      bedrooms: input.bedrooms ?? null,
      bathrooms: input.bathrooms ?? null,
      marketRentCents: input.marketRentCents ?? null,
    },
  });
  await writeAudit(accountId, {
    actor,
    action: 'create',
    entityType: 'unit',
    entityId: row.id,
    detail: { propertyId, label: row.label },
  });
  return toApiUnit(row);
}

async function getOwned(accountId: string, id: string): Promise<DbUnit> {
  const row = await prisma.unit.findFirst({ where: { id, property: { accountId } } });
  if (!row) throw new NotFoundError('unit', id);
  return row;
}

export async function getDetail(accountId: string, id: string): Promise<UnitDetailResponse> {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const unit = await prisma.unit.findFirst({
    // No archivedAt filter — detail resolves an archived unit (history
    // retention), same rationale as lease.service.getDetail.
    where: { id, property: { accountId } },
    include: {
      property: true,
      leases: {
        orderBy: { startDate: 'desc' },
        include: {
          leaseTenants: { include: { tenant: true }, orderBy: { isPrimary: 'desc' } },
          rentPayments: {
            orderBy: { dueDate: 'desc' },
            // Only the newest deposit is needed for lastDepositAt.
            include: { deposits: { orderBy: { paidAt: 'desc' }, take: 1 } },
          },
        },
      },
    },
  });
  if (!unit) throw new NotFoundError('unit', id);

  const toLeaseWithTenants = (l: (typeof unit.leases)[number]) => ({
    ...toApiLease(l),
    tenants: l.leaseTenants.map(toTenantOnLease),
  });
  const currentLeaseRow = unit.leases.find((l) => l.status === 'active');

  const now = new Date();
  const tz = account.timezone;
  const period = currentPeriodInTz(tz, now);

  // Computed once and reused for the embedded unit and the kept top-level
  // currentLease/status so they cannot diverge.
  const currentLease = currentLeaseRow ? toLeaseWithTenants(currentLeaseRow) : null;
  const pendingLeaseRow = unit.leases.find((l) => l.status === 'pending_signature');
  // One charge per unit per month, possibly on the outgoing lease after a renewal
  // switchover — search ALL leases (matches property.service's unitId-keyed lookup).
  const chargeRow = unit.leases.flatMap((l) => l.rentPayments).find((p) => p.period === period);
  const rent = currentRentSnapshot(currentLeaseRow, chargeRow, {
    period,
    tz,
    graceDays: account.graceDays,
    graceDaysBasis: account.graceDaysBasis as GraceDaysBasis,
    now,
  });

  const mtd = await pnlTotals(
    accountId,
    { from: monthStartInTz(period, tz), to: monthEndExclusiveInTz(period, tz) },
    { unitId: id },
  );
  const ytd = await pnlTotals(
    accountId,
    { from: yearRangeInTz(Number(period.slice(0, 4)), tz).from, to: monthEndExclusiveInTz(period, tz) },
    { unitId: id },
  );

  const rentPayments = unit.leases
    .flatMap((l) => l.rentPayments)
    .sort((a, b) => b.dueDate.getTime() - a.dueDate.getTime())
    .map((p) => {
      const derived = deriveRentStatus(p, account.graceDays, account.graceDaysBasis as GraceDaysBasis, tz);
      return {
        id: p.id,
        period: p.period,
        dueDate: iso(p.dueDate),
        amountCents: p.amountCents,
        paidCents: p.paidCents,
        lateFeeCents: p.lateFeeCents,
        status: derived.status,
        ...(derived.daysLate !== undefined ? { daysLate: derived.daysLate } : {}),
        method: p.method as 'online' | 'manual' | 'bank' | null,
        paidAt: isoOrNull(p.paidAt),
        lastDepositAt: p.deposits[0] ? iso(p.deposits[0].paidAt) : null,
      };
    });

  return {
    unit: {
      ...toApiUnit(unit),
      status: currentLeaseRow ? 'occupied' : 'vacant',
      currentLease,
      rent,
      leaseCount: unit.leases.length,
      pendingLease: pendingLeaseRow ? toLeaseWithTenants(pendingLeaseRow) : null,
    },
    propertyId: unit.propertyId,
    propertyLabel: propertyLabel(unit.property),
    status: currentLeaseRow ? 'occupied' : 'vacant',
    currentLease,
    leases: unit.leases.map(toLeaseWithTenants),
    rentPayments,
    pnl: { mtd, ytd },
  };
}

export async function update(
  accountId: string,
  id: string,
  input: UpdateUnitInput,
  actor: AuditActor = 'user',
): Promise<Unit> {
  await getOwned(accountId, id);
  const row = await prisma.unit.update({
    where: { id },
    data: {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.bedrooms !== undefined ? { bedrooms: input.bedrooms } : {}),
      ...(input.bathrooms !== undefined ? { bathrooms: input.bathrooms } : {}),
      ...(input.marketRentCents !== undefined ? { marketRentCents: input.marketRentCents } : {}),
    },
  });
  await writeAudit(accountId, {
    actor,
    action: 'update',
    entityType: 'unit',
    entityId: id,
    detail: { label: row.label },
  });
  return toApiUnit(row);
}

/** Soft-archive; blocked while the unit still has an active lease. */
export async function remove(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<void> {
  await getOwned(accountId, id);
  const activeLease = await prisma.lease.findFirst({ where: { status: 'active', unitId: id } });
  if (activeLease) {
    throw new ConflictError('Terminate the active lease before archiving this unit.');
  }
  await prisma.unit.update({ where: { id }, data: { archivedAt: new Date() } });
  await writeAudit(accountId, { actor, action: 'archive', entityType: 'unit', entityId: id });
}

export async function restore(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<Unit> {
  await getOwned(accountId, id);
  const row = await prisma.unit.update({ where: { id }, data: { archivedAt: null } });
  await writeAudit(accountId, { actor, action: 'restore', entityType: 'unit', entityId: id });
  return toApiUnit(row);
}
