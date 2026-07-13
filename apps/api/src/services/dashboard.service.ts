import {
  formatUsdWhole,
  type ActivityItem,
  type DashboardKpisResponse,
  type ExpenseBreakdownResponse,
  type IncomeExpenseSeriesResponse,
  type PropertyNoiResponse,
} from '@hearth/shared';
import {
  addMonthsToPeriod,
  currentPeriod,
  iso,
  monthEndExclusive,
  monthStart,
  periodOf,
  startOfUtcDay,
  trailingPeriods,
} from '../lib/dates';
import { ordinaryExpense, pnlSums } from '../lib/pnl';
import { prisma } from '../lib/prisma';
import { generateInsights } from './insight.service';
import * as rentService from './rent.service';

async function sumByType(
  accountId: string,
  range: { from: Date; to: Date },
): Promise<{ incomeCents: number; expenseCents: number; netCents: number }> {
  const grouped = await prisma.transaction.groupBy({
    by: ['type', 'classification'],
    where: {
      accountId,
      status: 'confirmed',
      date: { gte: range.from, lt: range.to },
      // Dashboard KPIs/series show the active portfolio: drop transactions of an
      // archived property, but keep account-level (unassigned) transactions.
      // Financial/tax reports intentionally retain archived-property history.
      OR: [{ propertyId: null }, { property: { archivedAt: null } }],
    },
    _sum: { amountCents: true },
  });
  // pnlSums drops transfers/owner contributions and nets refunds (plan §D1).
  return pnlSums(grouped);
}

function trendPct(current: number, prior: number): number {
  if (prior === 0) return current === 0 ? 0 : 100;
  return Math.round(((current - prior) / Math.abs(prior)) * 1000) / 10;
}

/**
 * Prior-month window ending on the same day-of-month as `now` (clamped to the
 * prior month's length), per ARCHITECTURE §4 trend rule.
 */
function priorWindow(now: Date): { from: Date; to: Date } {
  const period = currentPeriod(now);
  const prevPeriod = addMonthsToPeriod(period, -1);
  const from = monthStart(prevPeriod);
  const prevEnd = monthEndExclusive(prevPeriod);
  const sameDayEndExclusive = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), now.getUTCDate() + 1),
  );
  return { from, to: sameDayEndExclusive < prevEnd ? sameDayEndExclusive : prevEnd };
}

export async function getKpis(accountId: string): Promise<DashboardKpisResponse> {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const now = new Date();
  const period = currentPeriod(now);
  const mtdRange = { from: monthStart(period), to: monthEndExclusive(period) };
  const prior = priorWindow(now);

  const mtd = await sumByType(accountId, mtdRange);
  const prev = await sumByType(accountId, prior);

  // Rent collected (by units) — current tracker vs. the prior period as of the
  // same day-of-month (payments with paidAt inside the prior window).
  const tracker = await rentService.getMonthStatus(accountId, period);
  const rentCollectedPct =
    tracker.totalUnits === 0 ? 0 : Math.round((tracker.paidUnits / tracker.totalUnits) * 100);
  const prevPeriod = addMonthsToPeriod(period, -1);
  const prevPayments = await prisma.rentPayment.findMany({
    where: {
      period: prevPeriod,
      lease: { unit: { archivedAt: null, property: { accountId, archivedAt: null } } },
    },
    select: { status: true, paidAt: true },
  });
  const prevPaid = prevPayments.filter(
    (p) => p.status === 'paid' && p.paidAt && p.paidAt < prior.to,
  ).length;
  const prevPct =
    prevPayments.length === 0 ? 0 : Math.round((prevPaid / prevPayments.length) * 100);

  // Tax set-aside (estimate only — UI carries the PRD §13.4 disclaimer):
  // current = net MTD × rate; target = avg monthly net over the trailing 6
  // full months × 3 × rate. The average divides by months that actually have
  // ledger activity (≥ 1), not a flat 6 — a two-month-old account would
  // otherwise see its target understated 3×.
  const sixMonthsAgo = monthStart(addMonthsToPeriod(period, -6));
  const trailing = await sumByType(accountId, { from: sixMonthsAgo, to: mtdRange.from });
  const trailingDates = await prisma.transaction.findMany({
    where: {
      accountId,
      status: 'confirmed',
      date: { gte: sixMonthsAgo, lt: mtdRange.from },
      OR: [{ propertyId: null }, { property: { archivedAt: null } }],
    },
    select: { date: true },
  });
  const monthsWithActivity = new Set(trailingDates.map((t) => periodOf(t.date))).size;
  const avgMonthlyNet = trailing.netCents / Math.max(1, monthsWithActivity);
  const rate = account.taxRatePct / 100;

  return {
    netCashFlowMtdCents: mtd.netCents,
    netCashFlowTrendPct: trendPct(mtd.netCents, prev.netCents),
    rentCollectedPct,
    rentCollectedTrendPct: rentCollectedPct - prevPct,
    paidUnits: tracker.paidUnits,
    totalUnits: tracker.totalUnits,
    expensesMtdCents: mtd.expenseCents,
    expensesTrendPct: trendPct(mtd.expenseCents, prev.expenseCents),
    taxSetAside: {
      currentCents: Math.round(mtd.netCents * rate),
      targetCents: Math.round(avgMonthlyNet * 3 * rate),
    },
  };
}

/** Trailing `months` periods (oldest first), ending with the current month. */
export async function getIncomeExpenseSeries(
  accountId: string,
  months: number,
): Promise<IncomeExpenseSeriesResponse> {
  const periods = trailingPeriods(currentPeriod(), months);
  const out: IncomeExpenseSeriesResponse = [];
  for (const p of periods) {
    const sums = await sumByType(accountId, { from: monthStart(p), to: monthEndExclusive(p) });
    out.push({ month: p, incomeCents: sums.incomeCents, expenseCents: sums.expenseCents });
  }
  return out;
}

// Top expense categories shown as their own donut slice; the rest fold into a
// single "Other" bucket so the palette never exceeds its categorical slots.
const EXPENSE_BREAKDOWN_TOP = 7;

/** This month's confirmed expenses grouped by category (decomposes the MTD
 * expense KPI). Mirrors the KPI's active-portfolio filter. */
export async function getExpenseBreakdown(accountId: string): Promise<ExpenseBreakdownResponse> {
  const period = currentPeriod();
  const range = { from: monthStart(period), to: monthEndExclusive(period) };
  const portfolioFilter = { OR: [{ propertyId: null }, { property: { archivedAt: null } }] };
  const grouped = await prisma.transaction.groupBy({
    by: ['categoryId'],
    where: {
      accountId,
      status: 'confirmed',
      ...ordinaryExpense, // transfers classified out of the expense donut
      date: { gte: range.from, lt: range.to },
      // Match getKpis: active portfolio + account-level (unassigned) lines.
      ...portfolioFilter,
    },
    _sum: { amountCents: true },
  });
  // Refunds net against the category they refund (plan §D1).
  const refunds = await prisma.transaction.groupBy({
    by: ['categoryId'],
    where: {
      accountId,
      status: 'confirmed',
      classification: 'refund',
      date: { gte: range.from, lt: range.to },
      ...portfolioFilter,
    },
    _sum: { amountCents: true },
  });
  const refundByCategory = new Map(refunds.map((r) => [r.categoryId, r._sum.amountCents ?? 0]));

  const categoryIds = [...grouped, ...refunds]
    .map((g) => g.categoryId)
    .filter((id): id is string => id !== null);
  const categories = await prisma.category.findMany({
    where: { id: { in: categoryIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(categories.map((c) => [c.id, c.name]));

  const sorted = grouped
    .map((g) => ({
      categoryId: g.categoryId,
      categoryName: g.categoryId ? (nameById.get(g.categoryId) ?? 'Uncategorized') : 'Uncategorized',
      amountCents: (g._sum.amountCents ?? 0) - (refundByCategory.get(g.categoryId) ?? 0),
    }))
    .filter((s) => s.amountCents > 0)
    .sort((a, b) => b.amountCents - a.amountCents);

  const totalCents = sorted.reduce((sum, s) => sum + s.amountCents, 0);

  // Fold everything past the top N into one "Other" slice (only when it would
  // actually shorten the list — a lone extra category stays as itself).
  let slices = sorted;
  if (sorted.length > EXPENSE_BREAKDOWN_TOP + 1) {
    const head = sorted.slice(0, EXPENSE_BREAKDOWN_TOP);
    const otherCents = sorted
      .slice(EXPENSE_BREAKDOWN_TOP)
      .reduce((sum, s) => sum + s.amountCents, 0);
    slices = [...head, { categoryId: null, categoryName: 'Other', amountCents: otherCents }];
  }

  return { month: period, totalCents, slices };
}

/** This month's operating income per active property (directly-attributed
 * income − expense). Portfolio-level lines can't be attributed to one property
 * and are excluded. Sorted descending by NOI. */
export async function getNoiByProperty(accountId: string): Promise<PropertyNoiResponse> {
  const period = currentPeriod();
  const range = { from: monthStart(period), to: monthEndExclusive(period) };

  const properties = await prisma.property.findMany({
    where: { accountId, archivedAt: null },
    select: { id: true, nickname: true, addressLine1: true },
  });

  const grouped = await prisma.transaction.groupBy({
    by: ['propertyId', 'type', 'classification'],
    where: {
      accountId,
      status: 'confirmed',
      date: { gte: range.from, lt: range.to },
      propertyId: { not: null },
      property: { archivedAt: null },
    },
    _sum: { amountCents: true },
  });

  const rows = properties
    .map((p) => {
      const { incomeCents, expenseCents } = pnlSums(
        grouped.filter((g) => g.propertyId === p.id),
      );
      return {
        propertyId: p.id,
        label: p.nickname ?? p.addressLine1,
        incomeCents,
        expenseCents,
        noiCents: incomeCents - expenseCents,
      };
    })
    .sort((a, b) => b.noiCents - a.noiCents);

  return { month: period, properties: rows };
}

export async function getActivity(accountId: string, limit: number): Promise<ActivityItem[]> {
  const items: ActivityItem[] = [];

  const rentPaid = await prisma.rentPayment.findMany({
    where: {
      status: 'paid',
      lease: { unit: { archivedAt: null, property: { accountId, archivedAt: null } } },
    },
    include: { lease: { include: { leaseTenants: { include: { tenant: true }, orderBy: { isPrimary: 'desc' } } } } },
    orderBy: { paidAt: 'desc' },
    take: limit,
  });
  const rentTxnIds = new Set(
    (
      await prisma.rentPayment.findMany({
        where: { transactionId: { not: null }, lease: { unit: { property: { accountId } } } },
        select: { transactionId: true },
      })
    ).map((p) => p.transactionId as string),
  );
  for (const p of rentPaid) {
    if (!p.paidAt) continue;
    items.push({
      id: `rent_payment:${p.id}`,
      kind: 'rent_payment',
      text: `Rent received — ${p.lease.leaseTenants[0]?.tenant.fullName ?? 'tenant'} — ${formatUsdWhole(p.amountCents)}`,
      at: iso(p.paidAt),
      link: '/rent',
    });
  }

  const reminders = await prisma.rentPayment.findMany({
    where: {
      remindedAt: { not: null },
      lease: { unit: { archivedAt: null, property: { accountId, archivedAt: null } } },
    },
    include: { lease: { include: { leaseTenants: { include: { tenant: true }, orderBy: { isPrimary: 'desc' } } } } },
    orderBy: { remindedAt: 'desc' },
    take: limit,
  });
  for (const p of reminders) {
    items.push({
      id: `reminder:${p.id}`,
      kind: 'reminder',
      text: `Rent reminder sent to ${p.lease.leaseTenants[0]?.tenant.fullName ?? 'tenant'} for ${p.period}`,
      at: iso(p.remindedAt as Date),
      link: '/rent',
    });
  }

  const txns = await prisma.transaction.findMany({
    where: {
      accountId,
      id: { notIn: [...rentTxnIds] },
      // Dismissed rows are denied imports — not portfolio activity.
      status: { not: 'dismissed' },
      // Match the KPIs: the activity feed reflects the active portfolio.
      OR: [{ propertyId: null }, { property: { archivedAt: null } }],
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  for (const t of txns) {
    items.push({
      id: `transaction:${t.id}`,
      kind: 'transaction',
      text: `${t.type === 'income' ? 'Income' : 'Expense'}${t.status === 'pending_review' ? ' (needs review)' : ''} — ${t.description} — ${formatUsdWhole(t.amountCents)}`,
      at: iso(t.createdAt),
      link: t.status === 'pending_review' ? '/money/review' : '/money',
    });
  }

  const reports = await prisma.report.findMany({
    where: { accountId },
    orderBy: { generatedAt: 'desc' },
    take: limit,
  });
  for (const r of reports) {
    items.push({
      id: `report:${r.id}`,
      kind: 'report',
      text: `Report generated — ${r.title}`,
      at: iso(r.generatedAt),
      link: `/reports/${r.id}`,
    });
  }

  // Same staleness fix as insight.service.ts's getDashboardInsight/list: the
  // only other producer of new Insight rows is the once-a-day scheduler, so
  // refresh before reading — otherwise "New insight — ..." activity entries
  // never appear same-day.
  await generateInsights(accountId);
  const insights = await prisma.insight.findMany({
    where: { accountId, status: 'active' },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  for (const i of insights) {
    items.push({
      id: `insight:${i.id}`,
      kind: 'insight',
      text: `New insight — ${i.title}`,
      at: iso(i.createdAt),
      // Insights no longer have a dedicated page — send the user to the
      // contextual surface the insight is about.
      link: i.actionTarget ?? '/',
    });
  }

  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** One-paragraph summary + key numbers (the future MCP resource body). */
export async function getPortfolioSummary(
  accountId: string,
): Promise<{ summary: string; kpis: DashboardKpisResponse }> {
  const kpis = await getKpis(accountId);
  // Match kpis.totalUnits, which excludes archived properties/units.
  const propertyCount = await prisma.property.count({ where: { accountId, archivedAt: null } });
  const today = startOfUtcDay(new Date()).toISOString().slice(0, 10);
  const summary =
    `As of ${today}: ${propertyCount} properties, ${kpis.totalUnits} units. ` +
    `Net cash flow this month is ${formatUsdWhole(kpis.netCashFlowMtdCents)} with ` +
    `${kpis.paidUnits} of ${kpis.totalUnits} units paid (${kpis.rentCollectedPct}%). ` +
    `Expenses month-to-date are ${formatUsdWhole(kpis.expensesMtdCents)}. ` +
    `Tax set-aside stands at ${formatUsdWhole(kpis.taxSetAside.currentCents)} against a quarterly target of ${formatUsdWhole(kpis.taxSetAside.targetCents)}.`;
  return { summary, kpis };
}
