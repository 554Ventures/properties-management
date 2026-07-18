import type {
  ApplyLateFeeInput,
  GraceDaysBasis,
  PaymentLinkResponse,
  PropertyDetailUnitRent,
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
  businessDaysBetweenInTz,
  calendarDaysBetween,
  calendarDaysBetweenInTz,
  currentPeriodInTz,
  iso,
  isoOrNull,
  monthEndExclusiveInTz,
  monthStartInTz,
  startOfDayInTz,
} from '../lib/dates';
import { NotFoundError, BadRequestError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { isUniqueConstraintError } from '../lib/prisma-errors';
import { formatUsd } from '@hearth/shared';
import { createReminderEmailComposer } from '../ai/reminder-email';
import type { UsageLog } from '../ai/agent-loop';
import { mockStripe } from '../integrations/mock/mock-stripe';
import { accountTimezone } from './account.service';
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
    lateFeeCents: p.lateFeeCents,
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
 * stored status lagged; 0 < paidCents < totalDue derives `partial` (with
 * daysLate once past grace — partially paid rent can still be late); else
 * `due` while today is within the grace window, otherwise `late` with
 * daysLate = whole calendar days past dueDate.
 *
 * Coverage compares against totalDueCents = amountCents + lateFeeCents (WS7):
 * once a late fee is applied, a charge whose base rent is covered but whose fee
 * is still owed derives `partial`, not `paid`. `lateFeeCents` is optional and
 * defaults to 0 so the pure-helper stays callable with a bare charge shape.
 *
 * Grace-period eligibility is basis-aware (`graceDaysBasis`): 'calendar' (the
 * long-standing default) counts every day past dueDate; 'business' counts
 * only Mon–Fri days elapsed. Either way `daysLate` — the number displayed on
 * every tracker/report row and asserted by pinned seed figures — stays a pure
 * CALENDAR count; only whether that count trips "past grace" changes with the
 * basis.
 */
export function deriveRentStatus(
  payment: {
    status: string;
    dueDate: Date;
    amountCents: number;
    paidCents: number;
    lateFeeCents?: number;
  },
  graceDays: number,
  graceDaysBasis: GraceDaysBasis,
  tz: string,
  today: Date = new Date(),
): { status: RentStatus; daysLate?: number } {
  const stored = payment.status as RentPaymentStatus;
  if (stored === 'paid' || stored === 'processing' || stored === 'failed') {
    return { status: stored };
  }
  const totalDueCents = payment.amountCents + (payment.lateFeeCents ?? 0);
  if (payment.paidCents >= totalDueCents && totalDueCents > 0) {
    return { status: 'paid' };
  }
  // Days late is a local-calendar count in the account's tz (WS4): a payment
  // due "on the 1st" is late by whole days measured against the landlord's wall
  // clock, not UTC's — a 6-day-late charge must read 6 anywhere on earth. This
  // is always CALENDAR days, regardless of graceDaysBasis (display semantics
  // are pinned — see the doc comment above).
  const daysPastDue = calendarDaysBetweenInTz(payment.dueDate, today, tz);
  // Grace elapsed is measured on whichever basis the account configured; the
  // business-day count is only ever computed when it's actually needed.
  const graceElapsed =
    graceDaysBasis === 'business'
      ? businessDaysBetweenInTz(payment.dueDate, today, tz)
      : daysPastDue;
  const pastGrace = graceElapsed > graceDays;
  if (payment.paidCents > 0) {
    return pastGrace ? { status: 'partial', daysLate: daysPastDue } : { status: 'partial' };
  }
  if (pastGrace) return { status: 'late', daysLate: daysPastDue };
  return { status: 'due' };
}

const DAY_MS = 86_400_000;

/** Whole days of [start, endExclusive) that fall inside `period`, measured on
 *  the account's local calendar (WS4) so proration boundaries match the month
 *  boundaries every other rent/KPI surface now uses. */
export function coveredDaysInPeriod(
  period: string,
  start: Date,
  endExclusive: Date,
  tz: string,
): number {
  const from = Math.max(monthStartInTz(period, tz).getTime(), startOfDayInTz(start, tz).getTime());
  const to = Math.min(
    monthEndExclusiveInTz(period, tz).getTime(),
    startOfDayInTz(endExclusive, tz).getTime(),
  );
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
  tz: string,
): number {
  const daysInPeriod = Math.round(
    (monthEndExclusiveInTz(period, tz).getTime() - monthStartInTz(period, tz).getTime()) / DAY_MS,
  );
  const covered = coveredDaysInPeriod(period, start, endExclusive, tz);
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
  tz: string,
): number {
  return Math.round(
    proratedRentShare(
      lease.rentCents,
      period,
      lease.startDate,
      addDays(startOfDayInTz(lease.endDate, tz), 1),
      tz,
    ),
  );
}

/**
 * In-memory expected charge for a lease/period with no RentPayment row yet —
 * same derivation as rent.service's materializeExpectedPayments (prorated
 * charge, due date never before the lease starts) but NEVER persisted: the
 * property detail is a read.
 */
function synthesizeExpectedCharge(
  lease: { rentCents: number; dueDay: number; startDate: Date; endDate: Date },
  period: string,
  tz: string,
): { status: string; dueDate: Date; amountCents: number; paidCents: number } {
  const nominalDue = addDays(monthStartInTz(period, tz), lease.dueDay - 1);
  const startDay = startOfDayInTz(lease.startDate, tz);
  return {
    status: 'due',
    dueDate: nominalDue < startDay ? startDay : nominalDue,
    amountCents: expectedChargeCents(lease, period, tz),
    paidCents: 0,
  };
}

export interface RentSnapshotCtx {
  period: string;
  tz: string;
  graceDays: number;
  graceDaysBasis: GraceDaysBasis;
  now: Date;
}

/** This month's rent snapshot for a unit's active lease — the period's charge
 *  row when one exists, else the expected charge synthesized in memory (same
 *  derivation as materializeExpectedPayments; never persisted). Null when
 *  there is no active lease or the lease doesn't touch the period. */
export function currentRentSnapshot(
  lease: { rentCents: number; dueDay: number; startDate: Date; endDate: Date } | null | undefined,
  chargeRow: { status: string; dueDate: Date; amountCents: number; paidCents: number } | undefined,
  ctx: RentSnapshotCtx,
): PropertyDetailUnitRent | null {
  if (!lease) return null;
  const { period, tz, graceDays, graceDaysBasis, now } = ctx;
  // Charge row when one exists; otherwise (e.g. a lease created after this
  // month's charges materialized) synthesize the expected charge in memory. A
  // lease that doesn't touch this month has no charge.
  const row =
    chargeRow ??
    (lease.startDate < monthEndExclusiveInTz(period, tz) &&
    lease.endDate >= monthStartInTz(period, tz)
      ? synthesizeExpectedCharge(lease, period, tz)
      : undefined);
  if (!row) return null;
  const derived = deriveRentStatus(row, graceDays, graceDaysBasis, tz, now);
  return {
    period,
    status: derived.status,
    daysLate: derived.daysLate ?? null,
    paidCents: row.paidCents,
    amountCents: row.amountCents,
    dueDate: iso(row.dueDate),
  };
}

/** Insert any missing expected RentPayment rows for `period`.
 *  `tz` is the account's timezone (WS4); callers that already loaded the
 *  account pass it to avoid a re-read, otherwise it's fetched here. */
export async function materializeExpectedPayments(
  accountId: string,
  period: string,
  tz?: string,
): Promise<void> {
  const timezone = tz ?? (await accountTimezone(accountId));
  const periodStart = monthStartInTz(period, timezone);
  const periodEnd = monthEndExclusiveInTz(period, timezone);

  // Bill by DATE RANGE regardless of active/ended status. A lease that a
  // renewal flipped to 'ended' still carries an endDate covering this period —
  // either because its successor starts later (a future-dated renewal not yet
  // in effect, or a mid-month switchover), or because this is the switchover
  // month itself. The old `status: 'active'` filter dropped every such lease
  // and silently skipped the charge. 'pending_signature' (an unsigned draft
  // lease) never bills. A *terminated* lease already carries its shortened
  // endDate (lease.service `terminate` sets endDate → the last occupied day), so
  // the `endDate >= periodStart` range filter naturally excludes months after
  // it ended — no explicit status carve-out needed.
  const leases = await prisma.lease.findMany({
    where: {
      status: { in: ['active', 'ended'] },
      unit: { archivedAt: null, property: { accountId, archivedAt: null } },
      startDate: { lt: periodEnd },
      endDate: { gte: periodStart },
    },
    select: { id: true, unitId: true, rentCents: true, dueDay: true, startDate: true, endDate: true },
  });
  if (leases.length === 0) return;

  // One charge per unit per month: rows from *any* lease on the unit count, so
  // a renewal's successor never adds a second charge to a month the outgoing
  // lease already materialized (the switchover reconciliation in lease.service
  // adjusts that row instead).
  const existing = await prisma.rentPayment.findMany({
    where: { period, lease: { unitId: { in: leases.map((l) => l.unitId) } } },
    select: { lease: { select: { unitId: true } } },
  });
  const chargedUnits = new Set(existing.map((e) => e.lease.unitId));

  const byUnit = new Map<string, typeof leases>();
  for (const l of leases) {
    const list = byUnit.get(l.unitId) ?? [];
    list.push(l);
    byUnit.set(l.unitId, list);
  }

  const data: Array<{
    leaseId: string;
    period: string;
    dueDate: Date;
    amountCents: number;
    status: string;
  }> = [];
  for (const [unitId, unitLeases] of byUnit) {
    if (chargedUnits.has(unitId)) continue; // unit already has this month's charge

    // Day attribution mirrors reconcileShortenedLeaseCharges: a lease's endDate
    // is its inclusive last day (→ endExclusive = endDate + 1 day), EXCEPT when
    // a successor lease starts exactly on that day (a renewal switchover). Then
    // the switchover day belongs to the successor, so the outgoing lease ends
    // exclusive *at* its endDate — exactly the boundary reconcile uses when it
    // prorates the outgoing lease up to (not including) the successor's start.
    const covering = unitLeases
      .map((l) => {
        const endDay = startOfDayInTz(l.endDate, timezone);
        const abutsSuccessor = unitLeases.some(
          (m) =>
            m.id !== l.id && startOfDayInTz(m.startDate, timezone).getTime() === endDay.getTime(),
        );
        const endExclusive = abutsSuccessor ? endDay : addDays(endDay, 1);
        return {
          lease: l,
          endExclusive,
          covered: coveredDaysInPeriod(period, l.startDate, endExclusive, timezone),
        };
      })
      .filter((c) => c.covered > 0)
      .sort((a, b) => a.lease.startDate.getTime() - b.lease.startDate.getTime());
    if (covering.length === 0) continue;

    // When two (or more) sequential leases cover parts of this month, the charge
    // is the SUM of each lease's prorated share, rounded ONCE on the sum — the
    // exact figure reconcileShortenedLeaseCharges produces for a month already
    // materialized before the renewal (unrounded shares, one Math.round on the
    // blend), so the materialize-after-renewal path and the reconcile path
    // converge on an identical row.
    const shareSum = covering.reduce(
      (sum, c) =>
        sum + proratedRentShare(c.lease.rentCents, period, c.lease.startDate, c.endExclusive, timezone),
      0,
    );
    // The row belongs to the earliest lease that actually covers days — the same
    // row reconcile keeps (it adjusts the outgoing lease's existing charge and
    // lets the unit-level guard suppress the successor's row). leaseId + dueDate
    // come from that lease; only the amount blends. A lease starting mid-month
    // can't be due before it begins: the due date is local midnight of
    // (1st + dueDay − 1), clamped up to the lease's local start day (WS4).
    const owner = covering[0]!.lease;
    const nominalDue = addDays(periodStart, owner.dueDay - 1);
    const startDay = startOfDayInTz(owner.startDate, timezone);
    data.push({
      leaseId: owner.id,
      period,
      dueDate: nominalDue < startDay ? startDay : nominalDue,
      amountCents: Math.round(shareSum),
      status: 'due',
    });
  }
  if (data.length === 0) return;

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
          where: { period, leaseId: { in: data.map((d) => d.leaseId) } },
          select: { leaseId: true },
        })
      ).map((e) => e.leaseId),
    );
    const stillMissing = data.filter((d) => !nowHave.has(d.leaseId));
    if (stillMissing.length > 0) await prisma.rentPayment.createMany({ data: stillMissing });
  }
}

/** Materialize missing expected RentPayment rows for `period`, then derive.
 *  `period` defaults to the account's current local month (WS4 — route/tool
 *  defaults resolved in the service so they respect the landlord's timezone). */
export async function getMonthStatus(
  accountId: string,
  period?: string,
): Promise<RentTrackerResponse> {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const resolvedPeriod = period ?? currentPeriodInTz(account.timezone);
  await materializeExpectedPayments(accountId, resolvedPeriod, account.timezone);

  const payments = await prisma.rentPayment.findMany({
    where: {
      period: resolvedPeriod,
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
    const derived = deriveRentStatus(
      p,
      account.graceDays,
      account.graceDaysBasis as GraceDaysBasis,
      account.timezone,
    );
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
      lateFeeCents: p.lateFeeCents,
      dueDate: iso(p.dueDate),
      status: derived.status,
      ...(derived.daysLate !== undefined ? { daysLate: derived.daysLate } : {}),
      method: p.method as RentPaymentMethod | null,
      paidAt: isoOrNull(p.paidAt),
      // p.deposits is already loaded ascending by paidAt (for the `deposits`
      // field below) — the last element is the newest, so no extra query.
      lastDepositAt: p.deposits.length > 0 ? iso(p.deposits[p.deposits.length - 1]!.paidAt) : null,
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
  // Both sides are against totalDue = amountCents + lateFeeCents (WS7), so an
  // applied fee grows outstanding and fee money received grows collected.
  return {
    period: resolvedPeriod,
    collectedCents: rows.reduce((sum, r) => sum + Math.min(r.paidCents, r.amountCents + r.lateFeeCents), 0),
    outstandingCents: rows.reduce((sum, r) => sum + Math.max(0, r.amountCents + r.lateFeeCents - r.paidCents), 0),
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
  paidCents: number; // remaining = (amountCents + lateFeeCents) − paidCents is what deposits match against
  lateFeeCents: number; // applied late fee (WS7); part of the total the deposit must clear
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
      lateFeeCents: p.lateFeeCents,
    };
  });
}

/**
 * Pick the expected rent a bank deposit looks like: exactly the charge's
 * *remaining* balance (full total for untouched charges, the shortfall for
 * partials — so the second roommate check matches, and a completed charge
 * never does), dated within RENT_MATCH_WINDOW_DAYS of the due date. Two
 * same-remaining candidates in window is ambiguous — suppress the suggestion
 * rather than guess. Below-remaining partials are deliberately not suggested
 * here (that's the Rent-page nudge's broader tier, plan §C5).
 *
 * Remaining is against totalDue = amountCents + lateFeeCents (WS7). Documented
 * consequence: once a fee is applied, a deposit for exactly the base rent no
 * longer clears the high-confidence exact-match chip (remaining now includes
 * the fee) and falls to the ≤-remaining Rent-page nudge instead — acceptable,
 * and it never wrong-links.
 */
export function pickRentMatch(
  txn: { amountCents: number; date: Date },
  candidates: RentMatchCandidate[],
): RentMatchCandidate | null {
  const matches = candidates.filter(
    (c) =>
      c.amountCents + c.lateFeeCents - c.paidCents === txn.amountCents &&
      c.amountCents + c.lateFeeCents - c.paidCents > 0 &&
      // Deliberately UTC (WS4): the ±14-day window is a pure day-distance
      // heuristic for "does this deposit look like that rent", not a
      // period/late boundary. A ±1-day tz wobble is immaterial against a
      // 14-day tolerance, so this stays timezone-agnostic.
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
    // partial-coverage months, due date never before the lease starts — on the
    // account's local calendar (WS4).
    const tz = await accountTimezone(accountId);
    const nominalDue = addDays(monthStartInTz(input.period, tz), lease.dueDay - 1);
    const startDay = startOfDayInTz(lease.startDate, tz);
    try {
      payment = await prisma.rentPayment.create({
        data: {
          leaseId: input.leaseId,
          period: input.period,
          dueDate: nominalDue < startDay ? startDay : nominalDue,
          amountCents: expectedChargeCents(lease, input.period, tz),
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
  // totalDue = charge + any applied late fee (WS7); coverage/remaining are
  // always against this, so an applied fee reopens an otherwise-covered charge.
  const totalDueCents = payment.amountCents + payment.lateFeeCents;
  if (payment.status === 'paid' || payment.paidCents >= totalDueCents) {
    throw new BadRequestError(`rent for ${input.period} is already recorded as paid`);
  }
  // Deposits may undershoot the remaining balance (partial payment) but never
  // overshoot it — an overpayment would silently inflate collectedCents past
  // the charge and hide a real bookkeeping problem (wrong unit, wrong month).
  if (input.amountCents > totalDueCents - payment.paidCents) {
    throw new BadRequestError(
      `payment of ${formatUsd(input.amountCents)} exceeds the ${formatUsd(totalDueCents - payment.paidCents)} remaining for ${input.period} — ` +
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
  // Cash-basis late-fee income (WS7): a deposit recorded when the base rent is
  // already covered is pure fee money → categorize it 'Late Fees' (Schedule E
  // Line 3, same tax output as Rent). A blended single payment covering base +
  // fee together stays 'Rent'. Looked up the same account-scoped way as Rent.
  const lateFeeCategory = await prisma.category.findFirst({
    where: { name: 'Late Fees', type: 'income', OR: [{ isSystem: true }, { accountId }] },
    orderBy: { isSystem: 'desc' },
  });

  // Ledger transaction + deposit + RentPayment update commit or roll back
  // together; the re-read inside the transaction makes the double-pay and
  // over-remaining guards hold under concurrent requests (two concurrent
  // partials must not overshoot the charge between them).
  const paymentId = payment.id;
  const { ledgerTxn, updated } = await prisma.$transaction(async (tx) => {
    const fresh = await tx.rentPayment.findUniqueOrThrow({ where: { id: paymentId } });
    const freshTotalDue = fresh.amountCents + fresh.lateFeeCents;
    if (fresh.status === 'paid' || fresh.paidCents >= freshTotalDue) {
      throw new BadRequestError(`rent for ${input.period} is already recorded as paid`);
    }
    if (input.amountCents > freshTotalDue - fresh.paidCents) {
      throw new BadRequestError(
        `payment of ${formatUsd(input.amountCents)} exceeds the ${formatUsd(freshTotalDue - fresh.paidCents)} remaining for ${input.period}`,
      );
    }
    // Base rent already covered before this deposit → this is fee money (WS7).
    const feeOnly = fresh.paidCents >= fresh.amountCents;
    const createdTxn = await tx.transaction.create({
      data: {
        accountId,
        propertyId: lease.unit.propertyId,
        unitId: lease.unitId,
        categoryId: (feeOnly ? lateFeeCategory : rentCategory)?.id ?? null,
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
    const covered = newPaidCents >= freshTotalDue;
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
      outstandingCents: Math.max(0, updated.amountCents + updated.lateFeeCents - updated.paidCents),
    },
  });
  // Landlord push notification — never throws, must not fail the payment.
  const paidInFull = updated.paidCents >= updated.amountCents + updated.lateFeeCents;
  await notifyAccount(accountId, {
    title: 'Rent received',
    body: paidInFull
      ? `${tenantName} paid ${formatUsd(input.amountCents)} for ${input.period}`
      : `${tenantName} paid ${formatUsd(input.amountCents)} of ${formatUsd(updated.amountCents + updated.lateFeeCents)} for ${input.period}`,
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
    // Coverage is against totalDue = charge + applied fee (WS7); unlinking below
    // that reopens the charge (reverts stored status), fee left intact.
    const covered = paidCents >= fresh.amountCents + fresh.lateFeeCents && paidCents > 0;
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
 * Resolve the effective late-fee policy for a charge (WS7): an explicit
 * lease override (Lease.lateFeeCents, where 0 means "explicitly none for this
 * lease" and beats the account default) falls back to the account default only
 * when it is null. Returns 0 when no fee is configured.
 */
export function effectiveLateFeeCents(
  lease: { lateFeeCents: number | null },
  account: { defaultLateFeeCents: number },
): number {
  return lease.lateFeeCents ?? account.defaultLateFeeCents;
}

/**
 * Apply a late fee to a charge (WS7). Policy is configured; applying is always
 * an explicit human action (tracker button or a user-invoked chat tool), never
 * auto-applied by the scheduler or insight generation. Guards: the charge must
 * be account-scoped; its tz-aware derived status must be `late` or
 * `partial`-past-grace; no fee already applied (one fee per charge in v1); and
 * the resolved fee (explicit `feeCents`, else the effective policy) must be
 * positive. No ledger Transaction is created — cash basis, nothing has been
 * received yet; the fee lands in P&L only when a deposit collects it.
 */
export async function applyLateFee(
  accountId: string,
  rentPaymentId: string,
  input: ApplyLateFeeInput,
  actor: AuditActor = 'user',
): Promise<RentPayment> {
  const payment = await prisma.rentPayment.findFirst({
    where: { id: rentPaymentId, lease: { unit: { property: { accountId } } } },
    include: { lease: true },
  });
  if (!payment) throw new NotFoundError('rent payment', rentPaymentId);

  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const derived = deriveRentStatus(
    payment,
    account.graceDays,
    account.graceDaysBasis as GraceDaysBasis,
    account.timezone,
  );
  // Eligible = past grace and not fully paid: stored/derived 'late', or a
  // 'partial' that carries daysLate (partial charges past grace). A charge
  // still inside its grace window, or paid, cannot be charged a late fee.
  const eligible =
    derived.status === 'late' || (derived.status === 'partial' && derived.daysLate !== undefined);
  if (!eligible) {
    throw new BadRequestError('a late fee can only be applied to rent that is past its grace period');
  }
  if (payment.lateFeeCents !== 0) {
    throw new BadRequestError('a late fee has already been applied to this charge');
  }
  const feeCents = input.feeCents ?? effectiveLateFeeCents(payment.lease, account);
  if (feeCents <= 0) {
    throw new BadRequestError('no late-fee policy configured');
  }

  const updated = await prisma.rentPayment.update({
    where: { id: rentPaymentId },
    data: { lateFeeCents: feeCents },
  });
  await writeAudit(accountId, {
    actor,
    action: 'rent_payment.late_fee_applied',
    entityType: 'rent_payment',
    entityId: rentPaymentId,
    detail: { period: payment.period, feeCents },
  });
  return toApiRentPayment(updated);
}

/**
 * Waive (remove) a charge's applied late fee (WS7): resets lateFeeCents to 0.
 * Guards: a fee must be present, and the charge must not already be fully
 * collected against its total (paidCents < amountCents + lateFeeCents) —
 * waiving after full collection would strand the fee money as an overpayment.
 * No ledger effect; any already-collected fee-money deposits stay as-is.
 * Waiving is a user action only — no chat tool exposes it.
 */
export async function waiveLateFee(
  accountId: string,
  rentPaymentId: string,
  actor: AuditActor = 'user',
): Promise<RentPayment> {
  const payment = await prisma.rentPayment.findFirst({
    where: { id: rentPaymentId, lease: { unit: { property: { accountId } } } },
  });
  if (!payment) throw new NotFoundError('rent payment', rentPaymentId);
  if (payment.lateFeeCents === 0) {
    throw new BadRequestError('there is no late fee to waive on this charge');
  }
  // Block once ANY fee money has been collected (paid beyond the base rent),
  // not just at full collection — waiving after a partial fee-only deposit
  // would leave paidCents > totalDue, a stranded overpayment the tracker's
  // min/max clamping then hides.
  if (payment.paidCents > payment.amountCents) {
    throw new BadRequestError(
      'part of this late fee has already been collected — waiving it now would leave an overpayment',
    );
  }
  const waivedCents = payment.lateFeeCents;
  const updated = await prisma.rentPayment.update({
    where: { id: rentPaymentId },
    data: { lateFeeCents: 0 },
  });
  await writeAudit(accountId, {
    actor,
    action: 'rent_payment.late_fee_waived',
    entityType: 'rent_payment',
    entityId: rentPaymentId,
    detail: { period: payment.period, feeCents: waivedCents },
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
  period?: string,
): Promise<{ items: UnlinkedRentDeposit[] }> {
  const tz = await accountTimezone(accountId);
  const resolvedPeriod = period ?? currentPeriodInTz(tz);
  await materializeExpectedPayments(accountId, resolvedPeriod, tz);
  const charges = await prisma.rentPayment.findMany({
    where: {
      period: resolvedPeriod,
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
  const open = charges.filter((c) => c.paidCents < c.amountCents + c.lateFeeCents);
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
      const remaining = c.amountCents + c.lateFeeCents - c.paidCents;
      if (txn.amountCents > remaining) return false;
      // Deliberately UTC (WS4): same ±14-day day-distance heuristic as
      // pickRentMatch — a tolerance window, not a period/late boundary.
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
      remainingCents: charge.amountCents + charge.lateFeeCents - charge.paidCents,
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
    // Coverage is against totalDue = charge + applied fee (WS7): a charge whose
    // base rent is paid but whose late fee is still owed still gets a reminder.
    if (payment.status === 'paid' || payment.paidCents >= payment.amountCents + payment.lateFeeCents) {
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
      // A partially paid charge reminds for what's still owed — base rent plus
      // any applied late fee (WS7), minus what's been received — not the full rent.
      amountCents: payment.amountCents + payment.lateFeeCents - payment.paidCents,
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
