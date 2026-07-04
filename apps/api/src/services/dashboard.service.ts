import {
  formatUsdWhole,
  type ActivityItem,
  type DashboardKpisResponse,
  type IncomeExpenseSeriesResponse,
} from '@hearth/shared';
import {
  addMonthsToPeriod,
  currentPeriod,
  iso,
  monthEndExclusive,
  monthStart,
  startOfUtcDay,
  trailingPeriods,
} from '../lib/dates';
import { prisma } from '../lib/prisma';
import * as rentService from './rent.service';

async function sumByType(
  accountId: string,
  range: { from: Date; to: Date },
): Promise<{ incomeCents: number; expenseCents: number; netCents: number }> {
  const grouped = await prisma.transaction.groupBy({
    by: ['type'],
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
  const incomeCents = grouped.find((g) => g.type === 'income')?._sum.amountCents ?? 0;
  const expenseCents = grouped.find((g) => g.type === 'expense')?._sum.amountCents ?? 0;
  return { incomeCents, expenseCents, netCents: incomeCents - expenseCents };
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
  // current = net MTD × rate; target = avg net of trailing 6 full months × 3 × rate.
  const sixMonthsAgo = monthStart(addMonthsToPeriod(period, -6));
  const trailing = await sumByType(accountId, { from: sixMonthsAgo, to: mtdRange.from });
  const avgMonthlyNet = trailing.netCents / 6;
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
      link: '/insights',
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
