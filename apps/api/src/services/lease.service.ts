import type {
  AcceptRenewalInput,
  AddLeaseTenantInput,
  CreateLeaseInput,
  EsignEnvelopeResponse,
  EsignStatus,
  Lease,
  LeaseDetailResponse,
  LeaseListResponse,
  LeaseStatus,
  LeaseWithContext,
  RenewalDraftResponse,
  UpdateLeaseInput,
} from '@hearth/shared';
import type {
  Lease as DbLease,
  Prisma,
  Property as DbProperty,
  Tenant as DbTenant,
  Unit as DbUnit,
} from '@prisma/client';
import { addDays, iso, isoOrNull, startOfUtcDay } from '../lib/dates';
import { ConflictError, NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { mockDocusign } from '../integrations/mock/mock-docusign';
import { writeAudit, type AuditActor } from './audit.service';
import { coveredDaysInPeriod, deriveRentStatus, proratedRentShare } from './rent.service';
import { toApiTenant } from './tenant.service';

export function toApiLease(l: DbLease): Lease {
  return {
    id: l.id,
    unitId: l.unitId,
    rentCents: l.rentCents,
    dueDay: l.dueDay,
    startDate: iso(l.startDate),
    endDate: iso(l.endDate),
    status: l.status as LeaseStatus,
    esignEnvelopeId: l.esignEnvelopeId,
    esignStatus: l.esignStatus as EsignStatus | null,
    createdAt: iso(l.createdAt),
  };
}

type LeaseWithJoins = DbLease & {
  unit: DbUnit & { property: DbProperty };
  leaseTenants: Array<{ isPrimary: boolean; tenant: DbTenant }>;
};

function toLeaseWithContext(l: LeaseWithJoins): LeaseWithContext {
  return {
    ...toApiLease(l),
    unitLabel: l.unit.label,
    propertyId: l.unit.propertyId,
    propertyLabel: l.unit.property.nickname ?? l.unit.property.addressLine1,
    tenants: l.leaseTenants.map((lt) => toApiTenant(lt.tenant)),
  };
}

const contextInclude = {
  unit: { include: { property: true } },
  leaseTenants: { include: { tenant: true }, orderBy: { isPrimary: 'desc' } },
} as const;

export async function list(
  accountId: string,
  filter?: { status?: LeaseStatus },
): Promise<LeaseListResponse> {
  const rows = await prisma.lease.findMany({
    where: {
      // Archived unit/property hides its leases from the list (detail still resolves).
      unit: { archivedAt: null, property: { accountId, archivedAt: null } },
      ...(filter?.status ? { status: filter.status } : {}),
    },
    orderBy: { endDate: 'asc' },
  });
  return rows.map(toApiLease);
}

async function getOwned(accountId: string, id: string): Promise<DbLease> {
  const row = await prisma.lease.findFirst({
    where: { id, unit: { property: { accountId } } },
  });
  if (!row) throw new NotFoundError('lease', id);
  return row;
}

/** Reload with joins (used by every path that returns LeaseWithContext). */
async function getContext(accountId: string, id: string): Promise<LeaseWithJoins> {
  const row = await prisma.lease.findFirst({
    where: { id, unit: { property: { accountId } } },
    include: contextInclude,
  });
  if (!row) throw new NotFoundError('lease', id);
  return row as LeaseWithJoins;
}

export async function getDetail(accountId: string, id: string): Promise<LeaseDetailResponse> {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const lease = await prisma.lease.findFirst({
    // Detail resolves an archived unit/property (history retention).
    where: { id, unit: { property: { accountId } } },
    include: { ...contextInclude, rentPayments: { orderBy: { dueDate: 'desc' } } },
  });
  if (!lease) throw new NotFoundError('lease', id);

  return {
    lease: toLeaseWithContext(lease as LeaseWithJoins),
    rentPayments: lease.rentPayments.map((p) => {
      const derived = deriveRentStatus(p, account.graceDays);
      return {
        id: p.id,
        period: p.period,
        dueDate: iso(p.dueDate),
        amountCents: p.amountCents,
        paidCents: p.paidCents,
        status: derived.status,
        ...(derived.daysLate !== undefined ? { daysLate: derived.daysLate } : {}),
        method: p.method as 'online' | 'manual' | 'bank' | null,
        paidAt: isoOrNull(p.paidAt),
      };
    }),
  };
}

export async function create(
  accountId: string,
  input: CreateLeaseInput,
  actor: AuditActor = 'user',
): Promise<Lease> {
  const unit = await prisma.unit.findFirst({
    where: { id: input.unitId, property: { accountId } },
  });
  if (!unit) throw new NotFoundError('unit', input.unitId);
  const tenants = await prisma.tenant.findMany({
    where: { id: { in: input.tenantIds }, accountId },
  });
  if (tenants.length !== input.tenantIds.length) throw new NotFoundError('tenant');

  const row = await prisma.lease.create({
    data: {
      unitId: input.unitId,
      rentCents: input.rentCents,
      dueDay: input.dueDay,
      startDate: new Date(input.startDate),
      endDate: new Date(input.endDate),
      status: 'active',
      leaseTenants: {
        create: input.tenantIds.map((tenantId, i) => ({ tenantId, isPrimary: i === 0 })),
      },
    },
  });
  await writeAudit(accountId, {
    actor,
    action: 'create',
    entityType: 'lease',
    entityId: row.id,
    detail: { unitId: row.unitId, rentCents: row.rentCents, tenantIds: input.tenantIds },
  });
  return toApiLease(row);
}

export async function update(
  accountId: string,
  id: string,
  input: UpdateLeaseInput,
  actor: AuditActor = 'user',
): Promise<Lease> {
  await getOwned(accountId, id);
  const row = await prisma.lease.update({
    where: { id },
    data: {
      ...(input.rentCents !== undefined ? { rentCents: input.rentCents } : {}),
      ...(input.dueDay !== undefined ? { dueDay: input.dueDay } : {}),
      ...(input.startDate !== undefined ? { startDate: new Date(input.startDate) } : {}),
      ...(input.endDate !== undefined ? { endDate: new Date(input.endDate) } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
  });
  await writeAudit(accountId, {
    actor,
    action: 'update',
    entityType: 'lease',
    entityId: id,
    detail: { rentCents: row.rentCents, dueDay: row.dueDay, status: row.status },
  });
  return toApiLease(row);
}

interface ChargeAdjustment {
  action: 'rent_payment.adjusted' | 'rent_payment.voided';
  rentPaymentId: string;
  period: string;
  priorAmountCents: number;
  amountCents?: number;
}

/**
 * Reconcile the open (due/failed) expected charges of a lease that was just
 * shortened to cover [lease.startDate, endExclusive): charges for months the
 * lease no longer touches are voided, and the cut month's charge re-prorates
 * to the lease's remaining days — plus, on a renewal switchover, the
 * successor lease's share of the rest of that month, rounded once on the
 * blended sum (the unit-level materialization guard then keeps the successor
 * from adding its own row for that month). Paid/processing rows are never
 * touched: money received or in flight is history, not a projection. Runs
 * inside the caller's transaction and returns what changed so the caller can
 * audit after commit.
 */
async function reconcileShortenedLeaseCharges(
  tx: Prisma.TransactionClient,
  lease: { id: string; rentCents: number; startDate: Date },
  endExclusive: Date,
  successor?: { rentCents: number; startDate: Date; endDate: Date },
): Promise<ChargeAdjustment[]> {
  const open = await tx.rentPayment.findMany({
    where: { leaseId: lease.id, status: { in: ['due', 'failed'] } },
  });
  const adjustments: ChargeAdjustment[] = [];
  for (const row of open) {
    if (coveredDaysInPeriod(row.period, lease.startDate, endExclusive) === 0) {
      await tx.rentPayment.delete({ where: { id: row.id } });
      adjustments.push({
        action: 'rent_payment.voided',
        rentPaymentId: row.id,
        period: row.period,
        priorAmountCents: row.amountCents,
      });
      continue;
    }
    const blended = Math.round(
      proratedRentShare(lease.rentCents, row.period, lease.startDate, endExclusive) +
        (successor
          ? proratedRentShare(
              successor.rentCents,
              row.period,
              successor.startDate,
              addDays(startOfUtcDay(successor.endDate), 1),
            )
          : 0),
    );
    if (blended !== row.amountCents) {
      await tx.rentPayment.update({ where: { id: row.id }, data: { amountCents: blended } });
      adjustments.push({
        action: 'rent_payment.adjusted',
        rentPaymentId: row.id,
        period: row.period,
        priorAmountCents: row.amountCents,
        amountCents: blended,
      });
    }
  }
  return adjustments;
}

async function auditChargeAdjustments(
  accountId: string,
  actor: AuditActor,
  reason: 'lease_terminated' | 'lease_renewal_switchover',
  adjustments: ChargeAdjustment[],
): Promise<void> {
  for (const a of adjustments) {
    await writeAudit(accountId, {
      actor,
      action: a.action,
      entityType: 'rent_payment',
      entityId: a.rentPaymentId,
      detail: {
        period: a.period,
        priorAmountCents: a.priorAmountCents,
        ...(a.amountCents !== undefined ? { amountCents: a.amountCents } : {}),
        reason,
      },
    });
  }
}

/**
 * End a lease now: status → 'ended', endDate → today unless already in the
 * past. Open charges the shortened lease no longer earns are voided, and the
 * final month's unpaid charge re-prorates to the days actually occupied
 * (endDate stays the inclusive last covered day).
 */
export async function terminate(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<Lease> {
  const existing = await getOwned(accountId, id);
  const today = startOfUtcDay(new Date());
  const endDate = existing.endDate < today ? existing.endDate : today;
  const { row, adjustments } = await prisma.$transaction(async (tx) => {
    const updated = await tx.lease.update({
      where: { id },
      data: { status: 'ended', endDate },
    });
    const changes = await reconcileShortenedLeaseCharges(
      tx,
      existing,
      addDays(startOfUtcDay(endDate), 1),
    );
    return { row: updated, adjustments: changes };
  });
  await writeAudit(accountId, {
    actor,
    action: 'terminate',
    entityType: 'lease',
    entityId: id,
    detail: { endDate: iso(endDate) },
  });
  await auditChargeAdjustments(accountId, actor, 'lease_terminated', adjustments);
  return toApiLease(row);
}

export async function addTenant(
  accountId: string,
  leaseId: string,
  input: AddLeaseTenantInput,
  actor: AuditActor = 'user',
): Promise<LeaseWithContext> {
  await getOwned(accountId, leaseId);
  const tenant = await prisma.tenant.findFirst({
    where: { id: input.tenantId, accountId, archivedAt: null },
  });
  if (!tenant) throw new NotFoundError('tenant', input.tenantId);

  const existing = await prisma.leaseTenant.findUnique({
    where: { leaseId_tenantId: { leaseId, tenantId: input.tenantId } },
  });
  if (existing) throw new ConflictError('Tenant is already on this lease.');

  const makePrimary = input.isPrimary ?? false;
  await prisma.$transaction(async (tx) => {
    if (makePrimary) {
      await tx.leaseTenant.updateMany({ where: { leaseId }, data: { isPrimary: false } });
    }
    await tx.leaseTenant.create({
      data: { leaseId, tenantId: input.tenantId, isPrimary: makePrimary },
    });
  });
  await writeAudit(accountId, {
    actor,
    action: 'add_tenant',
    entityType: 'lease',
    entityId: leaseId,
    detail: { tenantId: input.tenantId, isPrimary: makePrimary },
  });
  return toLeaseWithContext(await getContext(accountId, leaseId));
}

export async function removeTenant(
  accountId: string,
  leaseId: string,
  tenantId: string,
  actor: AuditActor = 'user',
): Promise<LeaseWithContext> {
  await getOwned(accountId, leaseId);
  const link = await prisma.leaseTenant.findUnique({
    where: { leaseId_tenantId: { leaseId, tenantId } },
  });
  if (!link) throw new NotFoundError('tenant', tenantId);

  const all = await prisma.leaseTenant.findMany({ where: { leaseId } });
  if (all.length <= 1) {
    throw new ConflictError('A lease must keep at least one tenant.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.leaseTenant.delete({ where: { leaseId_tenantId: { leaseId, tenantId } } });
    // Auto-promote the next tenant when the removed one was primary.
    if (link.isPrimary) {
      const next = all.find((lt) => lt.tenantId !== tenantId);
      if (next) {
        await tx.leaseTenant.update({
          where: { leaseId_tenantId: { leaseId, tenantId: next.tenantId } },
          data: { isPrimary: true },
        });
      }
    }
  });
  await writeAudit(accountId, {
    actor,
    action: 'remove_tenant',
    entityType: 'lease',
    entityId: leaseId,
    detail: { tenantId, wasPrimary: link.isPrimary },
  });
  return toLeaseWithContext(await getContext(accountId, leaseId));
}

/**
 * Immediate switchover: create a new active lease on the same unit and end the
 * source lease at the new lease's start date. The source lease's open charges
 * are reconciled in the same transaction: months it no longer touches are
 * voided, and the switchover month's unpaid charge becomes the blended
 * old-share + new-share proration, so the unit is never billed twice for one
 * month. Paid/processing rows keep their original amounts.
 */
export async function createRenewal(
  accountId: string,
  leaseId: string,
  input: AcceptRenewalInput,
  actor: AuditActor = 'user',
): Promise<Lease> {
  const source = await prisma.lease.findFirst({
    where: { id: leaseId, unit: { property: { accountId } } },
    include: { leaseTenants: { orderBy: { isPrimary: 'desc' } } },
  });
  if (!source) throw new NotFoundError('lease', leaseId);

  // Tenant set: explicit override (primary = first) or a copy of the source's.
  let tenantLinks: Array<{ tenantId: string; isPrimary: boolean }>;
  if (input.tenantIds) {
    const tenants = await prisma.tenant.findMany({
      where: { id: { in: input.tenantIds }, accountId, archivedAt: null },
    });
    if (tenants.length !== input.tenantIds.length) throw new NotFoundError('tenant');
    tenantLinks = input.tenantIds.map((tenantId, i) => ({ tenantId, isPrimary: i === 0 }));
  } else {
    tenantLinks = source.leaseTenants.map((lt) => ({
      tenantId: lt.tenantId,
      isPrimary: lt.isPrimary,
    }));
  }

  const startDate = new Date(input.startDate);
  const { created, adjustments } = await prisma.$transaction(async (tx) => {
    const newLease = await tx.lease.create({
      data: {
        unitId: source.unitId,
        rentCents: input.rentCents,
        dueDay: input.dueDay,
        startDate,
        endDate: new Date(input.endDate),
        status: 'active',
        leaseTenants: { create: tenantLinks },
      },
    });
    await tx.lease.update({
      where: { id: leaseId },
      data: { status: 'ended', endDate: startDate },
    });
    // The old lease now covers only the days before the switchover.
    const changes = await reconcileShortenedLeaseCharges(tx, source, startDate, {
      rentCents: newLease.rentCents,
      startDate: newLease.startDate,
      endDate: newLease.endDate,
    });
    return { created: newLease, adjustments: changes };
  });

  await writeAudit(accountId, {
    actor,
    action: 'renew',
    entityType: 'lease',
    entityId: created.id,
    detail: { sourceLeaseId: leaseId, rentCents: created.rentCents, startDate: iso(startDate) },
  });
  await auditChargeAdjustments(accountId, actor, 'lease_renewal_switchover', adjustments);
  return toApiLease(created);
}

/** Market-rent heuristic: unit market rent when it beats current, else +3%. */
export async function draftRenewal(
  accountId: string,
  leaseId: string,
): Promise<RenewalDraftResponse> {
  const lease = await prisma.lease.findFirst({
    where: { id: leaseId, unit: { property: { accountId } } },
    include: { unit: true },
  });
  if (!lease) throw new NotFoundError('lease', leaseId);
  const marketRentCents = lease.unit.marketRentCents;
  const suggestedRentCents =
    marketRentCents && marketRentCents > lease.rentCents
      ? marketRentCents
      : Math.round((lease.rentCents * 1.03) / 100) * 100;
  const proposedStartDate = addDays(lease.endDate, 1);
  const proposedEnd = new Date(proposedStartDate);
  proposedEnd.setUTCFullYear(proposedEnd.getUTCFullYear() + 1);
  return {
    leaseId,
    currentRentCents: lease.rentCents,
    suggestedRentCents,
    marketRentCents,
    proposedStartDate: iso(proposedStartDate),
    proposedEndDate: iso(addDays(proposedEnd, -1)),
    dueDay: lease.dueDay,
  };
}

export async function sendForEsign(
  accountId: string,
  leaseId: string,
): Promise<EsignEnvelopeResponse> {
  const lease = await prisma.lease.findFirst({
    where: { id: leaseId, unit: { property: { accountId } } },
    include: { leaseTenants: { include: { tenant: true }, orderBy: { isPrimary: 'desc' } } },
  });
  if (!lease) throw new NotFoundError('lease', leaseId);
  const signerName = lease.leaseTenants[0]?.tenant.fullName ?? 'tenant';
  const envelope = await mockDocusign.sendEnvelope(leaseId, signerName);
  const now = new Date();
  await prisma.lease.update({
    where: { id: leaseId },
    data: { esignEnvelopeId: envelope.envelopeId, esignStatus: envelope.status },
  });
  return {
    leaseId,
    envelopeId: envelope.envelopeId,
    status: envelope.status,
    sentAt: iso(now),
  };
}
