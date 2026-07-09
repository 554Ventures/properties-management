import {
  formatUsdWhole,
  type Insight,
  type InsightScope,
  type InsightSeverity,
  type InsightStatus,
  type Report,
} from '@hearth/shared';
import { Prisma, type Insight as DbInsight } from '@prisma/client';
import {
  addDays,
  addMonthsToPeriod,
  currentPeriod,
  iso,
  monthEndExclusive,
  monthStart,
  periodLabel,
} from '../lib/dates';
import { NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { slugify } from '../lib/strings';
import { writeAudit, type AuditActor } from './audit.service';
import * as rentService from './rent.service';
import { generateMonthlyReviewReport } from './report.service';

export function toApiInsight(i: DbInsight): Insight {
  return {
    id: i.id,
    accountId: i.accountId,
    scope: i.scope as InsightScope,
    type: i.type,
    severity: i.severity as InsightSeverity,
    title: i.title,
    body: i.body,
    actionLabel: i.actionLabel,
    actionTarget: i.actionTarget,
    propertyId: i.propertyId,
    tenantId: i.tenantId,
    leaseId: i.leaseId,
    dedupeKey: i.dedupeKey,
    status: i.status as InsightStatus,
    createdAt: iso(i.createdAt),
  };
}

/** The general insight list (GET /insights, the chat/MCP list_insights tool
 *  via listActive, and the TenantsList portfolio-renewal banner) — refreshes
 *  against current data first, for the same reason getDashboardInsight does:
 *  the only other producer of new rows is the once-a-day scheduler. */
export async function list(
  accountId: string,
  filter: { status?: InsightStatus; scope?: InsightScope } = {},
): Promise<Insight[]> {
  await generateInsights(accountId);
  const rows = await prisma.insight.findMany({
    where: {
      accountId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.scope ? { scope: filter.scope } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toApiInsight);
}

export async function listActive(accountId: string, scope?: InsightScope): Promise<Insight[]> {
  return list(accountId, { status: 'active', ...(scope ? { scope } : {}) });
}

export async function dismiss(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<Insight> {
  const existing = await prisma.insight.findFirst({ where: { id, accountId } });
  if (!existing) throw new NotFoundError('insight', id);
  const row = await prisma.insight.update({ where: { id }, data: { status: 'dismissed' } });
  await writeAudit(accountId, {
    actor,
    action: 'insight.dismissed',
    entityType: 'insight',
    entityId: id,
    detail: { dedupeKey: existing.dedupeKey },
  });
  return toApiInsight(row);
}

const SEVERITY_RANK: Record<string, number> = { warning: 3, info: 2, positive: 1 };

/** The dashboard's single card: highest severity active, newest first.
 *  Refreshes insights against the account's current data first — previously
 *  this only happened once a day (the scheduler's runDailyJobs), so the card
 *  could sit stale all day regardless of new transactions/rent payments/
 *  lease changes. generateInsights is idempotent (dedupeKey-guarded) and
 *  read-only from the caller's perspective, so calling it on every dashboard
 *  load is safe and keeps the card live. */
export async function getDashboardInsight(accountId: string): Promise<Insight | null> {
  await generateInsights(accountId);
  const rows = await prisma.insight.findMany({
    where: { accountId, status: 'active' },
    orderBy: { createdAt: 'desc' },
  });
  if (rows.length === 0) return null;
  rows.sort(
    (a, b) =>
      (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
      b.createdAt.getTime() - a.createdAt.getTime(),
  );
  const top = rows[0];
  return top ? toApiInsight(top) : null;
}

interface InsightCandidate {
  scope: InsightScope;
  type: string;
  severity: InsightSeverity;
  title: string;
  body: string;
  actionLabel: string | null;
  actionTarget: string | null;
  propertyId: string | null;
  tenantId: string | null;
  leaseId: string | null;
  dedupeKey: string;
}

const LATE_RENT_MIN_DAYS = 5; // rule fires when daysLate > 5
const RENEWAL_WINDOW_DAYS = 60;
const SPIKE_RATIO = 1.25;
const UNDERPERFORM_RATIO = 0.8;

/**
 * Mock insight generation rules (ARCHITECTURE §4, binding). Deduped on
 * dedupeKey — a dismissed key is never recreated, so dismissal sticks until a
 * materially new key (e.g. next month) appears.
 */
export async function generateInsights(accountId: string): Promise<Insight[]> {
  const period = currentPeriod();
  const candidates: InsightCandidate[] = [];

  // Rule 1 — late_rent: any payment more than 5 days late.
  const tracker = await rentService.getMonthStatus(accountId, period);
  for (const row of tracker.rows) {
    if (row.status === 'late' && (row.daysLate ?? 0) > LATE_RENT_MIN_DAYS) {
      candidates.push({
        scope: 'tenant',
        type: 'late_rent',
        severity: 'warning',
        title: `${row.tenantName} is ${row.daysLate} days late on rent`,
        body: `${formatUsdWhole(row.amountCents)} for ${row.propertyLabel} ${row.unitLabel} was due on the ${new Date(row.dueDate).getUTCDate()}. Consider sending a reminder.`,
        actionLabel: 'Review',
        actionTarget: '/rent',
        propertyId: row.propertyId,
        tenantId: row.tenantId,
        leaseId: row.leaseId,
        dedupeKey: `late_rent:${slugify(row.tenantName)}:${period}`,
      });
    }
  }

  // Rule 2 — expense_spike: a category's current-month total > 125% of its
  // trailing-3-month average; attributed to the property with the largest
  // current-month spend in that category.
  const mStart = monthStart(period);
  const mEnd = monthEndExclusive(period);
  const trailingStart = monthStart(addMonthsToPeriod(period, -3));
  const currentExpenses = await prisma.transaction.findMany({
    where: {
      accountId,
      status: 'confirmed',
      type: 'expense',
      date: { gte: mStart, lt: mEnd },
      categoryId: { not: null },
    },
    include: { category: true, property: true },
  });
  const trailingTotals = await prisma.transaction.groupBy({
    by: ['categoryId'],
    where: {
      accountId,
      status: 'confirmed',
      type: 'expense',
      date: { gte: trailingStart, lt: mStart },
    },
    _sum: { amountCents: true },
  });
  const trailingByCategory = new Map(
    trailingTotals.map((t) => [t.categoryId ?? '', t._sum.amountCents ?? 0]),
  );
  const byCategory = new Map<string, typeof currentExpenses>();
  for (const t of currentExpenses) {
    const list = byCategory.get(t.categoryId as string) ?? [];
    list.push(t);
    byCategory.set(t.categoryId as string, list);
  }
  for (const [categoryId, txns] of byCategory) {
    const currentTotal = txns.reduce((sum, t) => sum + t.amountCents, 0);
    const trailingAvg = (trailingByCategory.get(categoryId) ?? 0) / 3;
    if (currentTotal > trailingAvg * SPIKE_RATIO) {
      const top = [...txns].sort((a, b) => b.amountCents - a.amountCents)[0];
      if (!top) continue;
      const categoryName = top.category?.name ?? 'Uncategorized';
      const propertyLabel = top.property
        ? (top.property.nickname ?? top.property.addressLine1)
        : 'the portfolio';
      candidates.push({
        scope: top.property ? 'property' : 'portfolio',
        type: 'expense_spike',
        severity: 'warning',
        title: `${categoryName} spending spiked at ${propertyLabel}`,
        body: `${categoryName} came in at ${formatUsdWhole(currentTotal)} this month vs a ${formatUsdWhole(Math.round(trailingAvg))} three-month average.`,
        actionLabel: 'View transactions',
        actionTarget: '/money',
        propertyId: top.property?.id ?? null,
        tenantId: null,
        leaseId: null,
        dedupeKey: `expense_spike:${slugify(categoryName)}:${slugify(top.property ? (top.property.nickname ?? top.property.addressLine1) : 'portfolio')}:${period}`,
      });
    }
  }

  // Rule 3 — renewal_window: active leases ending within 60 days.
  const today = new Date();
  const renewals = await prisma.lease.findMany({
    where: {
      status: 'active',
      unit: { property: { accountId } },
      endDate: { gte: today, lte: addDays(today, RENEWAL_WINDOW_DAYS) },
    },
  });
  if (renewals.length > 0) {
    candidates.push({
      scope: 'portfolio',
      type: 'renewal_window',
      severity: 'info',
      title: `${renewals.length} lease${renewals.length === 1 ? '' : 's'} up for renewal in the next 60 days`,
      body: 'Review terms and draft renewals before the leases lapse into month-to-month.',
      actionLabel: 'Draft renewal',
      actionTarget: '/tenants',
      propertyId: null,
      tenantId: null,
      leaseId: renewals.length === 1 ? (renewals[0]?.id ?? null) : null,
      dedupeKey: `renewal_window:${period}`,
    });
  }

  // Rule 4 — underperforming_property: per-unit net over the trailing 3 full
  // months < 80% of the portfolio per-unit average.
  const properties = await prisma.property.findMany({
    where: { accountId },
    include: { units: true },
  });
  const trailingTxns = await prisma.transaction.groupBy({
    by: ['propertyId', 'type'],
    where: {
      accountId,
      status: 'confirmed',
      date: { gte: trailingStart, lt: mStart },
      propertyId: { not: null },
    },
    _sum: { amountCents: true },
  });
  const netByProperty = new Map<string, number>();
  for (const g of trailingTxns) {
    const pid = g.propertyId as string;
    const signed = (g._sum.amountCents ?? 0) * (g.type === 'income' ? 1 : -1);
    netByProperty.set(pid, (netByProperty.get(pid) ?? 0) + signed);
  }
  const totalUnits = properties.reduce((sum, p) => sum + p.units.length, 0);
  const totalNet = properties.reduce((sum, p) => sum + (netByProperty.get(p.id) ?? 0), 0);
  if (totalUnits > 0) {
    const perUnitAvg = totalNet / totalUnits;
    for (const p of properties) {
      if (p.units.length === 0) continue;
      const perUnitNet = (netByProperty.get(p.id) ?? 0) / p.units.length;
      if (perUnitNet < perUnitAvg * UNDERPERFORM_RATIO) {
        const label = p.nickname ?? p.addressLine1;
        candidates.push({
          scope: 'property',
          type: 'underperforming_property',
          severity: 'info',
          title: `${label} is trailing the rest of the portfolio`,
          body: `Net cash flow per unit over the last 3 months (${formatUsdWhole(Math.round(perUnitNet))}) is below 80% of the portfolio average (${formatUsdWhole(Math.round(perUnitAvg))}).`,
          actionLabel: 'View property',
          actionTarget: `/properties/${p.id}`,
          propertyId: p.id,
          tenantId: null,
          leaseId: null,
          dedupeKey: `underperforming_property:${slugify(label)}:${period}`,
        });
      }
    }
  }

  const created: Insight[] = [];
  for (const c of candidates) {
    const existing = await prisma.insight.findUnique({
      where: { accountId_dedupeKey: { accountId, dedupeKey: c.dedupeKey } },
    });
    if (existing) continue; // dedupe: dismissal sticks
    try {
      const row = await prisma.insight.create({
        data: { accountId, ...c, status: 'active' },
      });
      created.push(toApiInsight(row));
    } catch (err) {
      // Now that generateInsights runs on every read (not just the once-a-day
      // scheduler), a page that fires several dashboard requests in parallel
      // (e.g. useDashboardInsight + useActivity) can call this concurrently
      // for the same account — trips @@unique([accountId, dedupeKey]) the
      // same way concurrent rent materialization does (rent.service.ts).
      // Someone else's request created it first; dedupe still holds.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
  }
  return created;
}

/** Snapshot a monthly_review Report for `period` ("YYYY-MM"). */
export async function generateMonthlyReview(accountId: string, period: string): Promise<Report> {
  const report = await generateMonthlyReviewReport(accountId, period);
  return report;
}

export function monthlyReviewTitle(period: string): string {
  return `Monthly review — ${periodLabel(period)}`;
}
