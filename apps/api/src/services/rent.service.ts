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
  UnlinkedRentDeposit,
} from '@hearth/shared';
import type { RentPayment as DbRentPayment } from '@prisma/client';
import {
  addDays,
  calendarDaysBetween,
  iso,
  isoOrNull,
  monthEndExclusive,
  monthStart,
  startOfUtcDay,
} from '../lib/dates';
import { NotFoundError, BadRequestError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { isUniqueConstraintError } from '../lib/prisma-errors';
import { formatUsd } from '@hearth/shared';
import { createReminderEmailComposer } from '../ai/reminder-email';
import type { UsageLog } from '../ai/agent-loop';
import { mockStripe } from '../integrations/mock/mock-stripe';
import { writeAudit, type AuditActor } from './audit.service';
import { notifyAccount } from './push.service';

export function toApiRentPayment(p: DbRentPayment): RentPayment {
  return {
    id: p.id,
    leaseId: p.leaseId,
    period: p.period,
    dueDate: iso(p.dueDate),
    amountCents: p.amountCents,
    paidCents: p.paidCents,
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
 * through; a row whose deposits cover the charge derives `paid` even if the
 * stored status lagged; 0 < paidCents < amountCents derives `partial` (with
 * daysLate once past dueDate + graceDays — partially paid rent can still be
 * late); else `due` while today ≤ dueDate + graceDays, otherwise `late` with
 * daysLate = whole days past dueDate.
 */
export function deriveRentStatus(
  payment: { status: string; dueDate: Date; amountCents: number; paidCents: number },
  graceDays: number,
  today: Date = new Date(),
): { status: RentStatus; daysLate?: number } {
  const stored = payment.status as RentPaymentStatus;
  if (stored === 'paid' || stored === 'processing' || stored === 'failed') {
    return { status: stored };
  }
  if (payment.paidCents >= payment.amountCents && payment.amountCents > 0) {
    return { status: 'paid' };
  }
  const daysPastDue = calendarDaysBetween(payment.dueDate, today);
  const pastGrace = daysPastDue > graceDays;
  if (payment.paidCents > 0) {
    return pastGrace ? { status: 'partial', daysLate: daysPastDue } : { status: 'partial' };
  }
  if (pastGrace) return { status: 'late', daysLate: daysPastDue };
  return { status: 'due' };
}

const DAY_MS = 86_400_000;

/** Whole days of [start, endExclusive) that fall inside `period`. */
export function coveredDaysInPeriod(period: string, start: Date, endExclusive: Date): number {
  const from = Math.max(monthStart(period).getTime(), startOfUtcDay(start).getTime());
  const to = Math.min(monthEndExclusive(period).getTime(), startOfUtcDay(endExclusive).getTime());
  return Math.max(0, Math.round((to - from) / DAY_MS));
}

/**
 * Unrounded rent share for the slice of `period` covered by [start,
 * endExclusive) — exactly rentCents when the whole period is covered. Kept
 * unrounded so a blended charge (old + new lease around a switchover) rounds
 * once on the sum instead of accumulating per-share rounding.
 */
export function proratedRentShare(
  rentCents: number,
  period: string,
  start: Date,
  endExclusive: Date,
): number {
  const daysInPeriod = Math.round(
    (monthEndExclusive(period).getTime() - monthStart(period).getTime()) / DAY_MS,
  );
  const covered = coveredDaysInPeriod(period, start, endExclusive);
  return covered >= daysInPeriod ? rentCents : (rentCents * covered) / daysInPeriod;
}

/**
 * Derivation rule (ARCHITECTURE §4, binding): the expected charge for a
 * period is the full rent when the lease covers the whole month, otherwise
 * prorated by covered days (lease endDate is the inclusive last day).
 */
export function expectedChargeCents(
  lease: { rentCents: number; startDate: Date; endDate: Date },
  period: string,
): number {
  return Math.round(
    proratedRentShare(
      lease.rentCents,
      period,
      lease.startDate,
      addDays(startOfUtcDay(lease.endDate), 1),
    ),
  );
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
    select: { id: true, unitId: true, rentCents: true, dueDay: true, startDate: true, endDate: true },
  });
  // One charge per unit per month: rows from *any* lease on the unit count,
  // so a renewal's successor lease never adds a second charge to a month the
  // outgoing lease already materialized (the switchover reconciliation in
  // lease.service adjusts that row instead).
  const existing = await prisma.rentPayment.findMany({
    where: { period, lease: { unitId: { in: activeLeases.map((l) => l.unitId) } } },
    select: { leaseId: true, lease: { select: { unitId: true } } },
  });
  const haveRows = new Set(existing.map((e) => e.leaseId));
  const chargedUnits = new Set(existing.map((e) => e.lease.unitId));
  const missing = activeLeases.filter((l) => !haveRows.has(l.id) && !chargedUnits.has(l.unitId));
  if (missing.length > 0) {
    const data = missing.map((l) => {
      // A lease starting mid-month can't be due before it begins.
      const nominalDue = addDays(periodStart, l.dueDay - 1);
      const startDay = startOfUtcDay(l.startDate);
      return {
        leaseId: l.id,
        period,
        dueDate: nominalDue < startDay ? startDay : nominalDue,
        amountCents: expectedChargeCents(l, period),
        status: 'due',
      };
    });
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
      deposits: { orderBy: { paidAt: 'asc' } },
    },
    orderBy: { dueDate: 'asc' },
  });

  const rows: RentTrackerRow[] = payments.map((p) => {
    const derived = deriveRentStatus(p, account.graceDays);
    const primaryTenant = p.lease.leaseTenants[0]?.tenant;
    const property = p.lease.unit.property;

    // Per-co-tenant shares (plan §C): stored shareCents, or an even split of
    // the charge when unspecified (first tenant absorbs the rounding
    // remainder). Per-tenant paid derives from deposits attributed via
    // deposit.tenantId; unattributed deposits count toward the unit total
    // only. Shares compare against the *charge* (prorated months included)
    // only when every share is stored; the even split always sums exactly.
    const links = p.lease.leaseTenants;
    const evenBase = links.length > 0 ? Math.floor(p.amountCents / links.length) : 0;
    const allSpecified = links.length > 0 && links.every((lt) => lt.shareCents != null);
    const specifiedSum = links.reduce((s, lt) => s + (lt.shareCents ?? 0), 0);
    const tenants = links.map((lt, i) => {
      const shareCents =
        lt.shareCents ?? (i === 0 ? p.amountCents - evenBase * (links.length - 1) : evenBase);
      const paidCents = p.deposits
        .filter((d) => d.tenantId === lt.tenantId)
        .reduce((s, d) => s + d.amountCents, 0);
      return {
        tenantId: lt.tenantId,
        tenantName: lt.tenant.fullName,
        isPrimary: lt.isPrimary,
        shareCents,
        shareSpecified: lt.shareCents != null,
        paidCents,
        settled: paidCents >= shareCents && shareCents > 0,
      };
    });

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
      paidCents: p.paidCents,
      dueDate: iso(p.dueDate),
      status: derived.status,
      ...(derived.daysLate !== undefined ? { daysLate: derived.daysLate } : {}),
      method: p.method as RentPaymentMethod | null,
      paidAt: isoOrNull(p.paidAt),
      deposits: p.deposits.map((d) => ({
        id: d.id,
        transactionId: d.transactionId,
        amountCents: d.amountCents,
        tenantId: d.tenantId,
        method: d.method as RentPaymentMethod | null,
        paidAt: iso(d.paidAt),
      })),
      tenants,
      sharesMismatch: allSpecified && specifiedSum !== p.amountCents,
    };
  });

  // Partials count toward collected and shrink (not zero) outstanding — the
  // received/receivable split stays exact whatever mix of full and partial.
  return {
    period,
    collectedCents: rows.reduce((sum, r) => sum + Math.min(r.paidCents, r.amountCents), 0),
    outstandingCents: rows.reduce((sum, r) => sum + Math.max(0, r.amountCents - r.paidCents), 0),
    paidUnits: rows.filter((r) => r.status === 'paid').length,
    partialUnits: rows.filter((r) => r.status === 'partial').length,
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
  paidCents: number; // remaining = amountCents − paidCents is what deposits match against
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
      paidCents: p.paidCents,
    };
  });
}

/**
 * Pick the expected rent a bank deposit looks like: exactly the charge's
 * *remaining* balance (full amount for untouched charges, the shortfall for
 * partials — so the second roommate check matches, and a completed charge
 * never does), dated within RENT_MATCH_WINDOW_DAYS of the due date. Two
 * same-remaining candidates in window is ambiguous — suppress the suggestion
 * rather than guess. Below-remaining partials are deliberately not suggested
 * here (that's the Rent-page nudge's broader tier, plan §C5).
 */
export function pickRentMatch(
  txn: { amountCents: number; date: Date },
  candidates: RentMatchCandidate[],
): RentMatchCandidate | null {
  const matches = candidates.filter(
    (c) =>
      c.amountCents - c.paidCents === txn.amountCents &&
      c.amountCents - c.paidCents > 0 &&
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
  // Attribution integrity: a deposit can only credit a tenant who is actually
  // on this lease — otherwise per-tenant share tracking would silently lie.
  if (input.tenantId && !lease.leaseTenants.some((lt) => lt.tenantId === input.tenantId)) {
    throw new BadRequestError('tenant is not on this lease');
  }

  let payment = await prisma.rentPayment.findUnique({
    where: { leaseId_period: { leaseId: input.leaseId, period: input.period } },
  });
  if (!payment) {
    // Same derivation as materializeExpectedPayments: prorated charge for
    // partial-coverage months, due date never before the lease starts.
    const nominalDue = addDays(monthStart(input.period), lease.dueDay - 1);
    const startDay = startOfUtcDay(lease.startDate);
    try {
      payment = await prisma.rentPayment.create({
        data: {
          leaseId: input.leaseId,
          period: input.period,
          dueDate: nominalDue < startDay ? startDay : nominalDue,
          amountCents: expectedChargeCents(lease, input.period),
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
  if (payment.status === 'paid' || payment.paidCents >= payment.amountCents) {
    throw new BadRequestError(`rent for ${input.period} is already recorded as paid`);
  }
  // Deposits may undershoot the remaining balance (partial payment) but never
  // overshoot it — an overpayment would silently inflate collectedCents past
  // the charge and hide a real bookkeeping problem (wrong unit, wrong month).
  if (input.amountCents > payment.amountCents - payment.paidCents) {
    throw new BadRequestError(
      `payment of ${formatUsd(input.amountCents)} exceeds the ${formatUsd(payment.amountCents - payment.paidCents)} remaining for ${input.period} — ` +
        `record the rent portion here and log any excess as a separate income transaction`,
    );
  }

  const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
  let externalRef: string | null = null;
  if (input.method === 'online') {
    const settlement = await mockStripe.settleImmediately(payment.id, input.amountCents);
    externalRef = settlement.externalRef;
  }

  // Attributed payer's name when given (ledger description + push), else primary.
  const tenantName =
    (input.tenantId
      ? lease.leaseTenants.find((lt) => lt.tenantId === input.tenantId)?.tenant.fullName
      : undefined) ??
    lease.leaseTenants[0]?.tenant.fullName ??
    'tenant';
  // Scoped like suggestCategory: never pick up another account's custom "Rent".
  const rentCategory = await prisma.category.findFirst({
    where: { name: 'Rent', type: 'income', OR: [{ isSystem: true }, { accountId }] },
    orderBy: { isSystem: 'desc' },
  });

  // Ledger transaction + deposit + RentPayment update commit or roll back
  // together; the re-read inside the transaction makes the double-pay and
  // over-remaining guards hold under concurrent requests (two concurrent
  // partials must not overshoot the charge between them).
  const paymentId = payment.id;
  const { ledgerTxn, updated } = await prisma.$transaction(async (tx) => {
    const fresh = await tx.rentPayment.findUniqueOrThrow({ where: { id: paymentId } });
    if (fresh.status === 'paid' || fresh.paidCents >= fresh.amountCents) {
      throw new BadRequestError(`rent for ${input.period} is already recorded as paid`);
    }
    if (input.amountCents > fresh.amountCents - fresh.paidCents) {
      throw new BadRequestError(
        `payment of ${formatUsd(input.amountCents)} exceeds the ${formatUsd(fresh.amountCents - fresh.paidCents)} remaining for ${input.period}`,
      );
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
    await tx.rentPaymentDeposit.create({
      data: {
        rentPaymentId: paymentId,
        transactionId: createdTxn.id,
        amountCents: input.amountCents,
        tenantId: input.tenantId ?? null,
        method: input.method,
        paidAt,
      },
    });
    // amountCents (the charge) is never overwritten; paidCents accumulates.
    // Stored status flips to 'paid' only when fully covered — a shortfall
    // stays stored 'due' and derives 'partial'. The legacy transactionId link
    // is set only for the single-full-payment case; deposits are the source
    // of truth either way.
    const newPaidCents = fresh.paidCents + input.amountCents;
    const covered = newPaidCents >= fresh.amountCents;
    const updatedPayment = await tx.rentPayment.update({
      where: { id: paymentId },
      data: {
        paidCents: newPaidCents,
        ...(covered
          ? {
              status: 'paid',
              method: input.method,
              paidAt,
              externalRef,
              ...(fresh.paidCents === 0 ? { transactionId: createdTxn.id } : {}),
            }
          : {}),
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
    detail: {
      period: input.period,
      amountCents: input.amountCents,
      method: input.method,
      paidCents: updated.paidCents,
      outstandingCents: Math.max(0, updated.amountCents - updated.paidCents),
    },
  });
  // Landlord push notification — never throws, must not fail the payment.
  const paidInFull = updated.paidCents >= updated.amountCents;
  await notifyAccount(accountId, {
    title: 'Rent received',
    body: paidInFull
      ? `${tenantName} paid ${formatUsd(input.amountCents)} for ${input.period}`
      : `${tenantName} paid ${formatUsd(input.amountCents)} of ${formatUsd(updated.amountCents)} for ${input.period}`,
    deepLink: '/rent',
  });
  return toApiRentPayment(updated);
}

/**
 * Remove one deposit from a charge (plan §B4): deletes the RentPaymentDeposit
 * link, recomputes paidCents from the surviving deposits, and reverts the
 * stored status/method/paidAt when the charge is no longer fully covered. The
 * ledger Transaction itself survives — unlinked, it's an ordinary confirmed
 * row again (editable/deletable now that no link guard sees it).
 */
export async function unlinkDeposit(
  accountId: string,
  rentPaymentId: string,
  depositId: string,
  actor: AuditActor = 'user',
): Promise<RentPayment> {
  const deposit = await prisma.rentPaymentDeposit.findFirst({
    where: {
      id: depositId,
      rentPaymentId,
      rentPayment: { lease: { unit: { property: { accountId } } } },
    },
    include: { rentPayment: true },
  });
  if (!deposit) throw new NotFoundError('rent deposit', depositId);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.rentPaymentDeposit.delete({ where: { id: deposit.id } });
    const remaining = await tx.rentPaymentDeposit.aggregate({
      where: { rentPaymentId },
      _sum: { amountCents: true },
    });
    const paidCents = remaining._sum.amountCents ?? 0;
    const fresh = await tx.rentPayment.findUniqueOrThrow({ where: { id: rentPaymentId } });
    const covered = paidCents >= fresh.amountCents && paidCents > 0;
    return tx.rentPayment.update({
      where: { id: rentPaymentId },
      data: {
        paidCents,
        // Clear the legacy single-payment link when it pointed at the deposit
        // being removed — otherwise remove()/update() guards would keep
        // protecting a transaction that no longer backs the charge.
        ...(fresh.transactionId === deposit.transactionId ? { transactionId: null } : {}),
        ...(covered
          ? {}
          : { status: 'due', method: null, paidAt: null, externalRef: null }),
      },
    });
  });

  await writeAudit(accountId, {
    actor,
    action: 'rent_payment.deposit_unlinked',
    entityType: 'rent_payment',
    entityId: rentPaymentId,
    detail: {
      period: updated.period,
      amountCents: deposit.amountCents,
      transactionId: deposit.transactionId,
      paidCents: updated.paidCents,
    },
  });
  return toApiRentPayment(updated);
}

/**
 * The "silently still late" fix (plan §C5): Rent-categorized, confirmed
 * income transactions that aren't linked as deposits but could apply to a
 * still-open charge of `period` — dated within the match window of the due
 * date, no larger than the remaining balance, and attribution-compatible
 * (same unit; same property with no unit; or unattributed). Broader than the
 * review-queue chip: below-remaining partials surface here too, as a
 * question. A transaction fitting more than one charge is suppressed rather
 * than guessed at.
 */
export async function findUnlinkedRentDeposits(
  accountId: string,
  period: string,
): Promise<{ items: UnlinkedRentDeposit[] }> {
  await materializeExpectedPayments(accountId, period);
  const charges = await prisma.rentPayment.findMany({
    where: {
      period,
      status: { in: ['due', 'processing'] },
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
  const open = charges.filter((c) => c.paidCents < c.amountCents);
  if (open.length === 0) return { items: [] };

  const rentCategories = await prisma.category.findMany({
    where: { name: 'Rent', type: 'income', OR: [{ isSystem: true }, { accountId }] },
    select: { id: true },
  });
  if (rentCategories.length === 0) return { items: [] };

  const dueTimes = open.map((c) => c.dueDate.getTime());
  const candidates = await prisma.transaction.findMany({
    where: {
      accountId,
      type: 'income',
      status: 'confirmed',
      classification: null, // a transfer/refund is by definition not rent
      categoryId: { in: rentCategories.map((c) => c.id) },
      rentDeposit: null, // not already applied as a deposit…
      rentPayment: null, // …nor via the legacy single-payment link
      date: {
        gte: addDays(new Date(Math.min(...dueTimes)), -RENT_MATCH_WINDOW_DAYS),
        lte: addDays(new Date(Math.max(...dueTimes)), RENT_MATCH_WINDOW_DAYS),
      },
    },
    orderBy: { date: 'desc' },
  });

  const items: UnlinkedRentDeposit[] = [];
  for (const txn of candidates) {
    const fits = open.filter((c) => {
      const remaining = c.amountCents - c.paidCents;
      if (txn.amountCents > remaining) return false;
      if (Math.abs(calendarDaysBetween(c.dueDate, txn.date)) > RENT_MATCH_WINDOW_DAYS) return false;
      if (txn.unitId) return txn.unitId === c.lease.unitId;
      if (txn.propertyId) return txn.propertyId === c.lease.unit.propertyId;
      return true; // unattributed — allowed only if it fits exactly one charge
    });
    if (fits.length !== 1) continue;
    const charge = fits[0] as (typeof open)[number];
    const property = charge.lease.unit.property;
    items.push({
      transactionId: txn.id,
      description: txn.description,
      amountCents: txn.amountCents,
      date: iso(txn.date),
      rentPaymentId: charge.id,
      leaseId: charge.leaseId,
      tenantName: charge.lease.leaseTenants[0]?.tenant.fullName ?? 'Unknown tenant',
      unitLabel: charge.lease.unit.label,
      propertyLabel: property.nickname ?? property.addressLine1,
      period: charge.period,
      remainingCents: charge.amountCents - charge.paidCents,
    });
  }
  return { items };
}

/** Set or clear (null) a co-tenant's expected share of the lease rent. */
export async function setTenantShare(
  accountId: string,
  leaseId: string,
  tenantId: string,
  shareCents: number | null,
  actor: AuditActor = 'user',
): Promise<void> {
  const link = await prisma.leaseTenant.findFirst({
    where: { leaseId, tenantId, lease: { unit: { property: { accountId } } } },
  });
  if (!link) throw new NotFoundError('lease tenant', tenantId);
  await prisma.leaseTenant.update({
    where: { leaseId_tenantId: { leaseId, tenantId } },
    data: { shareCents },
  });
  await writeAudit(accountId, {
    actor,
    action: 'lease.tenant_share_set',
    entityType: 'lease',
    entityId: leaseId,
    detail: { tenantId, shareCents },
  });
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
  log?: UsageLog,
): Promise<SendRemindersResponse> {
  const reminderEmailComposer = createReminderEmailComposer();
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
    if (payment.status === 'paid' || payment.paidCents >= payment.amountCents) {
      results.push({ rentPaymentId, status: 'skipped', reason: 'already_paid' });
      continue;
    }
    const tenant = payment.lease.leaseTenants[0]?.tenant;
    const property = payment.lease.unit.property;
    const to = tenant?.email ?? 'tenant@example.com';
    const { subject, body } = await reminderEmailComposer.compose({
      accountId,
      tenantName: tenant?.fullName ?? 'there',
      propertyLabel: property.nickname ?? property.addressLine1,
      unitLabel: payment.lease.unit.label,
      // A partially paid charge reminds for what's still owed, not the full rent.
      amountCents: payment.amountCents - payment.paidCents,
      dueDate: payment.dueDate.toISOString(),
      period: payment.period,
      log,
    });
    // No real email provider is wired up — compose a mailto: link so the
    // landlord reviews and sends it from their own mail client instead.
    const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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
    results.push({ rentPaymentId, status: 'sent', mailto, subject });
  }
  return { results };
}
