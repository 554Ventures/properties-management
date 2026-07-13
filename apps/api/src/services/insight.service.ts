import {
  formatUsdWhole,
  InsightActionSchema,
  type Insight,
  type InsightAction,
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
import { ordinaryExpense, pnlBucket } from '../lib/pnl';
import { prisma } from '../lib/prisma';
import { slugify } from '../lib/strings';
import { writeAudit, type AuditActor } from './audit.service';
import * as contractorService from './contractor.service';
import * as rentService from './rent.service';
import { generateMonthlyReviewReport } from './report.service';

/** actionJson is written by generateInsights below, but rows predating the
 *  column (or a future shape change) must degrade to the legacy
 *  actionLabel/actionTarget link — never a 500. */
function parseInsightAction(actionJson: string | null): InsightAction | null {
  if (!actionJson) return null;
  try {
    const parsed = InsightActionSchema.safeParse(JSON.parse(actionJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

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
    action: parseInsightAction(i.actionJson),
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

/** The user executed the insight's suggested action (e.g. sent the rent
 *  reminder an insight proposed). Actor is fixed server-side: this endpoint
 *  only ever records a user click on an AI suggestion, so the attribution is
 *  always ai_suggested_user_confirmed — never client-supplied (same server-
 *  side upgrade pattern as transaction confirmation). Dedupe still holds:
 *  generateInsights checks the key regardless of status. */
export async function markActioned(accountId: string, id: string): Promise<Insight> {
  const existing = await prisma.insight.findFirst({ where: { id, accountId } });
  if (!existing) throw new NotFoundError('insight', id);
  const row = await prisma.insight.update({ where: { id }, data: { status: 'actioned' } });
  await writeAudit(accountId, {
    actor: 'ai_suggested_user_confirmed',
    action: 'insight.actioned',
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
  /** Structured executable action (persisted as actionJson). api_call paths
   *  must be on the web app's action allowlist; navigate targets are in-app
   *  routes. */
  action: InsightAction | null;
  propertyId: string | null;
  tenantId: string | null;
  leaseId: string | null;
  dedupeKey: string;
}

const LATE_RENT_MIN_DAYS = 5; // rule fires when daysLate > 5
const RENEWAL_WINDOW_DAYS = 60;
const SPIKE_RATIO = 1.25;
const UNDERPERFORM_RATIO = 0.8;
const CONTRACTOR_COST_RATIO = 1.5; // latest job > 150% of the contractor's prior average
const CONTRACTOR_MIN_PRIOR_JOBS = 3; // no baseline, no spike — mirrors expense_spike's guard

/**
 * Mock insight generation rules (ARCHITECTURE §4, binding). Deduped on
 * dedupeKey — a dismissed key is never recreated, so dismissal sticks until a
 * materially new key (e.g. next month) appears.
 */
export async function generateInsights(accountId: string): Promise<Insight[]> {
  const period = currentPeriod();
  const candidates: InsightCandidate[] = [];

  // Rule 1 — late_rent: any payment more than 5 days late. 'partial' past
  // grace carries daysLate too — a half-paid tenant 6+ days past due still
  // warrants the nudge, with the shortfall (not the full charge) in the body.
  const tracker = await rentService.getMonthStatus(accountId, period);
  for (const row of tracker.rows) {
    if ((row.status === 'late' || row.status === 'partial') && (row.daysLate ?? 0) > LATE_RENT_MIN_DAYS) {
      candidates.push({
        scope: 'tenant',
        type: 'late_rent',
        severity: 'warning',
        title: `${row.tenantName} is ${row.daysLate} days late on rent`,
        body: `${formatUsdWhole(row.amountCents - row.paidCents)} for ${row.propertyLabel} ${row.unitLabel} was due on the ${new Date(row.dueDate).getUTCDate()}. Consider sending a reminder.`,
        actionLabel: 'Review',
        actionTarget: `/rent?period=${period}`,
        // One-click reminder for exactly this payment; sendReminders skips
        // already-paid rows, so a stale card can't double-charge attention.
        action: {
          label: 'Send reminder',
          action: {
            kind: 'api_call',
            method: 'POST',
            path: '/rent/reminders',
            body: { rentPaymentIds: [row.rentPaymentId] },
          },
        },
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
      ...ordinaryExpense, // transfers/refunds never look like a spend spike
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
      ...ordinaryExpense,
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
    // No trailing history means no baseline to spike against — without this
    // guard any first-ever spend "spikes" (monthly review applies the same
    // avg > 0 rule; the two calculations must agree).
    if (trailingAvg > 0 && currentTotal > trailingAvg * SPIKE_RATIO) {
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
        actionTarget: `/money?type=expense&categoryId=${categoryId}${top.property ? `&propertyId=${top.property.id}` : ''}`,
        action: {
          label: 'View transactions',
          action: {
            kind: 'navigate',
            to: `/money?type=expense&categoryId=${categoryId}${top.property ? `&propertyId=${top.property.id}` : ''}`,
          },
        },
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
      // "Draft renewal" overpromised — there is no renewal-drafting flow. The
      // honest action is the tenants list pre-filtered to expiring leases.
      actionLabel: 'Review renewals',
      actionTarget: '/tenants?status=renew_soon',
      action: {
        label: 'Review renewals',
        action: { kind: 'navigate', to: '/tenants?status=renew_soon' },
      },
      propertyId: null,
      tenantId: null,
      leaseId: renewals.length === 1 ? (renewals[0]?.id ?? null) : null,
      dedupeKey: `renewal_window:${period}`,
    });
  }

  // Rule 4 — underperforming_property: per-unit net over the trailing 3 full
  // months < 80% of the portfolio per-unit average. Active portfolio only
  // (matches every dashboard rollup): an archived property must neither drag
  // the average down nor get flagged itself.
  const properties = await prisma.property.findMany({
    where: { accountId, archivedAt: null },
    include: { units: { where: { archivedAt: null } } },
  });
  const trailingTxns = await prisma.transaction.groupBy({
    by: ['propertyId', 'type', 'classification'],
    where: {
      accountId,
      status: 'confirmed',
      date: { gte: trailingStart, lt: mStart },
      propertyId: { not: null },
      property: { archivedAt: null },
    },
    _sum: { amountCents: true },
  });
  const netByProperty = new Map<string, number>();
  for (const g of trailingTxns) {
    const pid = g.propertyId as string;
    const b = pnlBucket({ ...g, amountCents: g._sum.amountCents ?? 0 });
    if (!b) continue;
    const signed = b.amountCents * (b.bucket === 'income' ? 1 : -1);
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
          action: {
            label: 'View property',
            action: { kind: 'navigate', to: `/properties/${p.id}` },
          },
          propertyId: p.id,
          tenantId: null,
          leaseId: null,
          dedupeKey: `underperforming_property:${slugify(label)}:${period}`,
        });
      }
    }
  }

  // Rule 5 — contractor_cost_spike: a contractor's most recent matched job
  // landed this month and cost > 150% of their average across ≥3 prior jobs.
  // Same vendor-name derivation as the contractor directory (contractor
  // .service), so the figures always agree with that page's stats.
  const contractorsWithJobs = await contractorService.activeContractorsWithJobs(accountId);
  for (const { contractor, jobs } of contractorsWithJobs) {
    const [latest, ...prior] = jobs; // jobs are newest-first
    if (!latest || prior.length < CONTRACTOR_MIN_PRIOR_JOBS) continue;
    if (latest.date < mStart || latest.date >= mEnd) continue; // only current-month news
    const priorAvg = prior.reduce((sum, j) => sum + j.amountCents, 0) / prior.length;
    if (priorAvg <= 0 || latest.amountCents <= priorAvg * CONTRACTOR_COST_RATIO) continue;
    candidates.push({
      scope: 'portfolio',
      type: 'contractor_cost_spike',
      severity: 'info',
      title: `${contractor.name}'s latest job cost well above their usual`,
      body: `${formatUsdWhole(latest.amountCents)} for "${latest.description}" vs their ${formatUsdWhole(Math.round(priorAvg))} average across ${prior.length} earlier jobs. Worth a look before the next booking.`,
      actionLabel: 'View contractor',
      actionTarget: `/maintenance/contractors/${contractor.id}`,
      action: {
        label: 'View contractor',
        action: { kind: 'navigate', to: `/maintenance/contractors/${contractor.id}` },
      },
      propertyId: null,
      tenantId: null,
      leaseId: null,
      dedupeKey: `contractor_cost_spike:${slugify(contractor.name)}:${period}`,
    });
  }

  // Rule 6 — transactions_pending_review: imported bank rows sitting in the
  // review queue don't count toward dashboards/reports/taxes until confirmed.
  // Unlike the monthly-keyed rules the queue is a living count, so this rule
  // manages its lifecycle explicitly: the dedupeKey carries the newest pending
  // row's id (a dismissal holds only until the next import lands — materially
  // new queue, new key), a stale active card resolves itself once the queue is
  // cleared or superseded, and an active card's count refreshes in place as
  // the user works through the queue.
  const newestPending = await prisma.transaction.findFirst({
    where: { accountId, status: 'pending_review' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const reviewKey = newestPending ? `transactions_pending_review:${newestPending.id}` : null;
  await prisma.insight.updateMany({
    where: {
      accountId,
      type: 'transactions_pending_review',
      status: 'active',
      ...(reviewKey ? { dedupeKey: { not: reviewKey } } : {}),
    },
    data: { status: 'actioned' },
  });
  if (reviewKey) {
    const pendingCount = await prisma.transaction.count({
      where: { accountId, status: 'pending_review' },
    });
    const title = `${pendingCount} imported transaction${pendingCount === 1 ? ' is' : 's are'} waiting for review`;
    const body =
      'Imported bank transactions are not counted in your dashboards, reports, or taxes until you confirm them in the review queue.';
    await prisma.insight.updateMany({
      where: { accountId, dedupeKey: reviewKey, status: 'active', NOT: { title } },
      data: { title, body },
    });
    candidates.push({
      scope: 'portfolio',
      type: 'transactions_pending_review',
      severity: 'info',
      title,
      body,
      actionLabel: 'Review transactions',
      actionTarget: '/money/review',
      action: {
        label: 'Review transactions',
        action: { kind: 'navigate', to: '/money/review' },
      },
      propertyId: null,
      tenantId: null,
      leaseId: null,
      dedupeKey: reviewKey,
    });
  }

  const created: Insight[] = [];
  for (const c of candidates) {
    const existing = await prisma.insight.findUnique({
      where: { accountId_dedupeKey: { accountId, dedupeKey: c.dedupeKey } },
    });
    if (existing) {
      // Dedupe: dismissal sticks — but an ACTIVE row created before the
      // structured-action deploy has no actionJson, leaving its card without
      // the executable button until the monthly key rolls over. The rule just
      // recomputed the same candidate, so enrich the row in place (action +
      // refreshed label/target); dismissed/actioned rows stay untouched.
      if (existing.status === 'active' && !existing.actionJson && c.action) {
        await prisma.insight.update({
          where: { id: existing.id },
          data: {
            actionJson: JSON.stringify(c.action),
            actionLabel: c.actionLabel,
            actionTarget: c.actionTarget,
          },
        });
      }
      continue;
    }
    try {
      const { action, ...columns } = c;
      const row = await prisma.insight.create({
        data: {
          accountId,
          ...columns,
          actionJson: action ? JSON.stringify(action) : null,
          status: 'active',
        },
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
