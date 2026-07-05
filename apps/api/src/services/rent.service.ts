import type {
  PaymentLinkResponse,
  RecordRentPaymentInput,
  RentPayment,
  RentPaymentMethod,
  RentPaymentStatus,
  RentStatus,
  RentTrackerResponse,
  RentTrackerRow,
  SendRemindersInput,
  SendRemindersResponse,
} from '@hearth/shared';
import { Prisma, type RentPayment as DbRentPayment } from '@prisma/client';
import {
  addDays,
  calendarDaysBetween,
  iso,
  isoOrNull,
  monthEndExclusive,
  monthStart,
} from '../lib/dates';
import { NotFoundError, BadRequestError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { mockEmail } from '../integrations/mock/mock-email';
import { mockStripe } from '../integrations/mock/mock-stripe';
import { writeAudit, type AuditActor } from './audit.service';

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export function toApiRentPayment(p: DbRentPayment): RentPayment {
  return {
    id: p.id,
    leaseId: p.leaseId,
    period: p.period,
    dueDate: iso(p.dueDate),
    amountCents: p.amountCents,
    method: p.method as RentPaymentMethod | null,
    status: p.status as RentPaymentStatus,
    paidAt: isoOrNull(p.paidAt),
    externalRef: p.externalRef,
    transactionId: p.transactionId,
    remindedAt: isoOrNull(p.remindedAt),
  };
}

/**
 * Derivation rule (ARCHITECTURE §4, binding): paid/processing/failed pass
 * through; else `due` while today ≤ dueDate + graceDays, otherwise `late`
 * with daysLate = whole days past dueDate.
 */
export function deriveRentStatus(
  payment: { status: string; dueDate: Date },
  graceDays: number,
  today: Date = new Date(),
): { status: RentStatus; daysLate?: number } {
  const stored = payment.status as RentPaymentStatus;
  if (stored === 'paid' || stored === 'processing' || stored === 'failed') {
    return { status: stored };
  }
  const daysPastDue = calendarDaysBetween(payment.dueDate, today);
  if (daysPastDue > graceDays) return { status: 'late', daysLate: daysPastDue };
  return { status: 'due' };
}

/** Insert any missing expected RentPayment rows for `period`'s active leases. */
export async function materializeExpectedPayments(
  accountId: string,
  period: string,
): Promise<void> {
  const periodStart = monthStart(period);
  const periodEnd = monthEndExclusive(period);

  const activeLeases = await prisma.lease.findMany({
    where: {
      status: 'active',
      unit: { archivedAt: null, property: { accountId, archivedAt: null } },
      startDate: { lt: periodEnd },
      endDate: { gte: periodStart },
    },
    select: { id: true, rentCents: true, dueDay: true },
  });
  const existing = await prisma.rentPayment.findMany({
    where: { period, leaseId: { in: activeLeases.map((l) => l.id) } },
    select: { leaseId: true },
  });
  const haveRows = new Set(existing.map((e) => e.leaseId));
  const missing = activeLeases.filter((l) => !haveRows.has(l.id));
  if (missing.length > 0) {
    const data = missing.map((l) => ({
      leaseId: l.id,
      period,
      dueDate: addDays(periodStart, l.dueDay - 1),
      amountCents: l.rentCents,
      status: 'due',
    }));
    try {
      await prisma.rentPayment.createMany({ data });
    } catch (err) {
      // Concurrent materialization of the same period trips @@unique([leaseId,
      // period]) — SQLite has no skipDuplicates, so re-read once and insert
      // only the rows that are still missing.
      if (!isUniqueConstraintError(err)) throw err;
      const nowHave = new Set(
        (
          await prisma.rentPayment.findMany({
            where: { period, leaseId: { in: missing.map((l) => l.id) } },
            select: { leaseId: true },
          })
        ).map((e) => e.leaseId),
      );
      const stillMissing = data.filter((d) => !nowHave.has(d.leaseId));
      if (stillMissing.length > 0) await prisma.rentPayment.createMany({ data: stillMissing });
    }
  }
}

/** Materialize missing expected RentPayment rows for `period`, then derive. */
export async function getMonthStatus(
  accountId: string,
  period: string,
): Promise<RentTrackerResponse> {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  await materializeExpectedPayments(accountId, period);

  const payments = await prisma.rentPayment.findMany({
    where: {
      period,
      lease: { unit: { archivedAt: null, property: { accountId, archivedAt: null } } },
    },
    include: {
      lease: {
        include: {
          unit: { include: { property: true } },
          leaseTenants: { include: { tenant: true }, orderBy: { isPrimary: 'desc' } },
        },
      },
    },
    orderBy: { dueDate: 'asc' },
  });

  const rows: RentTrackerRow[] = payments.map((p) => {
    const derived = deriveRentStatus(p, account.graceDays);
    const primaryTenant = p.lease.leaseTenants[0]?.tenant;
    const property = p.lease.unit.property;
    return {
      rentPaymentId: p.id,
      leaseId: p.leaseId,
      tenantId: primaryTenant?.id ?? '',
      tenantName: primaryTenant?.fullName ?? 'Unknown tenant',
      unitId: p.lease.unitId,
      unitLabel: p.lease.unit.label,
      propertyId: property.id,
      propertyLabel: property.nickname ?? property.addressLine1,
      amountCents: p.amountCents,
      dueDate: iso(p.dueDate),
      status: derived.status,
      ...(derived.daysLate !== undefined ? { daysLate: derived.daysLate } : {}),
      method: p.method as RentPaymentMethod | null,
      paidAt: isoOrNull(p.paidAt),
    };
  });

  const paidRows = rows.filter((r) => r.status === 'paid');
  return {
    period,
    collectedCents: paidRows.reduce((sum, r) => sum + r.amountCents, 0),
    outstandingCents: rows
      .filter((r) => r.status !== 'paid')
      .reduce((sum, r) => sum + r.amountCents, 0),
    paidUnits: paidRows.length,
    totalUnits: rows.length,
    rows,
  };
}

// ── bank-import rent matching (heuristic suggestion, never auto-applied) ──────

/** How far a deposit's date may sit from the dueDate and still look like that rent. */
export const RENT_MATCH_WINDOW_DAYS = 14;

export interface RentMatchCandidate {
  rentPaymentId: string;
  leaseId: string;
  tenantName: string;
  propertyId: string;
  propertyLabel: string;
  unitId: string;
  unitLabel: string;
  period: string;
  dueDate: Date;
  amountCents: number;
}

/** Open (due/processing) expected rents with a dueDate inside `range`, account-scoped. */
export async function findRentMatchCandidates(
  accountId: string,
  range: { from: Date; to: Date },
): Promise<RentMatchCandidate[]> {
  const payments = await prisma.rentPayment.findMany({
    where: {
      status: { in: ['due', 'processing'] },
      dueDate: { gte: range.from, lte: range.to },
      lease: { unit: { archivedAt: null, property: { accountId, archivedAt: null } } },
    },
    include: {
      lease: {
        include: {
          unit: { include: { property: true } },
          leaseTenants: { include: { tenant: true }, orderBy: { isPrimary: 'desc' } },
        },
      },
    },
  });
  return payments.map((p) => {
    const property = p.lease.unit.property;
    return {
      rentPaymentId: p.id,
      leaseId: p.leaseId,
      tenantName: p.lease.leaseTenants[0]?.tenant.fullName ?? 'Unknown tenant',
      propertyId: property.id,
      propertyLabel: property.nickname ?? property.addressLine1,
      unitId: p.lease.unitId,
      unitLabel: p.lease.unit.label,
      period: p.period,
      dueDate: p.dueDate,
      amountCents: p.amountCents,
    };
  });
}

/**
 * Pick the expected rent a bank deposit looks like: exact amount, dated within
 * RENT_MATCH_WINDOW_DAYS of the due date. Two same-rent candidates in window
 * is ambiguous — suppress the suggestion rather than guess.
 */
export function pickRentMatch(
  txn: { amountCents: number; date: Date },
  candidates: RentMatchCandidate[],
): RentMatchCandidate | null {
  const matches = candidates.filter(
    (c) =>
      c.amountCents === txn.amountCents &&
      Math.abs(calendarDaysBetween(c.dueDate, txn.date)) <= RENT_MATCH_WINDOW_DAYS,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export async function recordPayment(
  accountId: string,
  input: RecordRentPaymentInput,
  actor: AuditActor = 'user',
): Promise<RentPayment> {
  const lease = await prisma.lease.findFirst({
    where: { id: input.leaseId, unit: { property: { accountId } } },
    include: {
      unit: { include: { property: true } },
      leaseTenants: { include: { tenant: true }, orderBy: { isPrimary: 'desc' } },
    },
  });
  if (!lease) throw new NotFoundError('lease', input.leaseId);

  let payment = await prisma.rentPayment.findUnique({
    where: { leaseId_period: { leaseId: input.leaseId, period: input.period } },
  });
  if (!payment) {
    try {
      payment = await prisma.rentPayment.create({
        data: {
          leaseId: input.leaseId,
          period: input.period,
          dueDate: addDays(monthStart(input.period), lease.dueDay - 1),
          amountCents: lease.rentCents,
          status: 'due',
        },
      });
    } catch (err) {
      // Lost the check-then-create race on @@unique([leaseId, period]) — use
      // the row the concurrent request created.
      if (!isUniqueConstraintError(err)) throw err;
      payment = await prisma.rentPayment.findUniqueOrThrow({
        where: { leaseId_period: { leaseId: input.leaseId, period: input.period } },
      });
    }
  }
  if (payment.status === 'paid') {
    throw new BadRequestError(`rent for ${input.period} is already recorded as paid`);
  }

  const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
  let externalRef: string | null = null;
  if (input.method === 'online') {
    const settlement = await mockStripe.settleImmediately(payment.id, input.amountCents);
    externalRef = settlement.externalRef;
  }

  const tenantName = lease.leaseTenants[0]?.tenant.fullName ?? 'tenant';
  const rentCategory = await prisma.category.findFirst({
    where: { name: 'Rent', type: 'income' },
  });

  // Ledger transaction + RentPayment update commit or roll back together; the
  // status re-check inside the transaction makes the double-pay guard hold
  // under concurrent requests.
  const paymentId = payment.id;
  const { ledgerTxn, updated } = await prisma.$transaction(async (tx) => {
    const fresh = await tx.rentPayment.findUniqueOrThrow({ where: { id: paymentId } });
    if (fresh.status === 'paid') {
      throw new BadRequestError(`rent for ${input.period} is already recorded as paid`);
    }
    const createdTxn = await tx.transaction.create({
      data: {
        accountId,
        propertyId: lease.unit.propertyId,
        unitId: lease.unitId,
        categoryId: rentCategory?.id ?? null,
        date: paidAt,
        amountCents: input.amountCents,
        type: 'income',
        description: `Rent payment — ${tenantName} — ${input.period}`,
        source: 'manual',
        status: 'confirmed',
      },
    });
    const updatedPayment = await tx.rentPayment.update({
      where: { id: paymentId },
      data: {
        status: 'paid',
        method: input.method,
        paidAt,
        amountCents: input.amountCents,
        externalRef,
        transactionId: createdTxn.id,
      },
    });
    return { ledgerTxn: createdTxn, updated: updatedPayment };
  });

  await writeAudit(accountId, {
    actor,
    action: 'transaction.created',
    entityType: 'transaction',
    entityId: ledgerTxn.id,
    detail: { amountCents: ledgerTxn.amountCents, type: ledgerTxn.type, source: ledgerTxn.source },
  });
  await writeAudit(accountId, {
    actor,
    action: 'rent_payment.recorded',
    entityType: 'rent_payment',
    entityId: updated.id,
    detail: { period: input.period, amountCents: input.amountCents, method: input.method },
  });
  return toApiRentPayment(updated);
}

export async function createPaymentLink(
  accountId: string,
  rentPaymentId: string,
): Promise<PaymentLinkResponse> {
  const payment = await prisma.rentPayment.findFirst({
    where: { id: rentPaymentId, lease: { unit: { property: { accountId } } } },
  });
  if (!payment) throw new NotFoundError('rent payment', rentPaymentId);
  const { url } = await mockStripe.createPaymentLink(payment.id, payment.amountCents);
  return { url };
}

export async function sendReminders(
  accountId: string,
  input: SendRemindersInput,
  actor: AuditActor = 'user',
): Promise<SendRemindersResponse> {
  const results: SendRemindersResponse['results'] = [];
  for (const rentPaymentId of input.rentPaymentIds) {
    const payment = await prisma.rentPayment.findFirst({
      where: { id: rentPaymentId, lease: { unit: { property: { accountId } } } },
      include: {
        lease: {
          include: {
            unit: { include: { property: true } },
            leaseTenants: { include: { tenant: true }, orderBy: { isPrimary: 'desc' } },
          },
        },
      },
    });
    if (!payment) {
      results.push({ rentPaymentId, status: 'skipped', reason: 'not_found' });
      continue;
    }
    if (payment.status === 'paid') {
      results.push({ rentPaymentId, status: 'skipped', reason: 'already_paid' });
      continue;
    }
    const tenant = payment.lease.leaseTenants[0]?.tenant;
    const property = payment.lease.unit.property;
    await mockEmail.send({
      to: tenant?.email ?? 'tenant@example.com',
      subject: `Rent reminder — ${property.nickname ?? property.addressLine1} ${payment.lease.unit.label}`,
      body: `Hi ${tenant?.fullName ?? 'there'}, this is a friendly reminder that your rent for ${payment.period} is due.`,
    });
    await prisma.rentPayment.update({
      where: { id: payment.id },
      data: { remindedAt: new Date() },
    });
    await writeAudit(accountId, {
      actor,
      action: 'rent.reminder_sent',
      entityType: 'rent_payment',
      entityId: payment.id,
      detail: { period: payment.period, tenantId: tenant?.id ?? null },
    });
    results.push({ rentPaymentId, status: 'sent' });
  }
  return { results };
}
