// (d) Insight rules produce the 3 seeded dedupeKeys; dismiss flips status and
// dedupe keeps dismissed keys from coming back.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { InsightSchema, RENEW_SOON_DAYS } from '@hearth/shared';
import { expectedInsightDedupeKeys } from '../../prisma/seed-constants';
import { buildApp } from '../app';
import { addDays, currentPeriod } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { slugify } from '../lib/strings';
import { getDemoAccountId } from '../plugins/auth';
import * as dashboardService from '../services/dashboard.service';
import * as insightService from '../services/insight.service';
import * as leaseService from '../services/lease.service';
import * as propertyService from '../services/property.service';
import * as tenantService from '../services/tenant.service';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await prisma.account.deleteMany({ where: { email: { endsWith: '@integrationtest.example' } } });
  await app.close();
});

/** Fresh account + property + unit + tenant + lease with dueDay:1, no
 *  RentPayment rows yet — the shared fixture for the self-refresh regression
 *  tests below. Mirrors what a real signup + first property looks like. */
async function createLateRentFixture(emailSuffix: string, tenantName: string) {
  const account = await prisma.account.create({
    data: { name: `Stale Insight ${emailSuffix}`, email: `stale-insight-${emailSuffix}@integrationtest.example` },
  });
  const property = await propertyService.create(account.id, {
    addressLine1: `1 Stale Insight Way ${emailSuffix}`,
    city: 'Springfield',
    state: 'IL',
    zip: '62701',
    units: [{ label: 'Unit A' }],
  });
  const detail = await propertyService.getDetail(account.id, property.id);
  const unitId = detail.units[0]!.id;
  const tenant = await tenantService.create(account.id, { fullName: tenantName });
  const start = new Date(Date.now() - 1000 * 60 * 60 * 24 * 200);
  const end = new Date(Date.now() + 1000 * 60 * 60 * 24 * 200);
  const lease = await leaseService.create(account.id, {
    unitId,
    tenantIds: [tenant.id],
    rentCents: 100000,
    dueDay: 1,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
  });
  return { accountId: account.id, propertyId: property.id, tenant, lease };
}

/** Materializes a >5-day-late RentPayment directly — no generateInsights call. */
async function makeRentLate(leaseId: string): Promise<void> {
  await prisma.rentPayment.create({
    data: {
      leaseId,
      period: currentPeriod(),
      dueDate: addDays(new Date(), -10),
      amountCents: 100000,
      status: 'due',
    },
  });
}

describe('insight generation rules', () => {
  it('seed produced exactly the 4 expected dedupeKeys, and re-running is a no-op', async () => {
    const accountId = await getDemoAccountId();
    const keys = expectedInsightDedupeKeys(currentPeriod());

    const active = await insightService.listActive(accountId);
    const activeKeys = active.map((i) => i.dedupeKey).sort();
    // The review-queue key carries the newest pending transaction's generated
    // id, so only its prefix is pinnable.
    const reviewKey = activeKeys.find((k) => k.startsWith('transactions_pending_review:'));
    expect(reviewKey).toBeDefined();
    expect(activeKeys).toEqual(
      [keys.expenseSpike, keys.lateRent, keys.renewalWindow, reviewKey!].sort(),
    );

    const lateRent = active.find((i) => i.dedupeKey === keys.lateRent);
    expect(lateRent?.severity).toBe('warning');
    expect(lateRent?.type).toBe('late_rent');
    const renewal = active.find((i) => i.dedupeKey === keys.renewalWindow);
    expect(renewal?.title).toBe(`2 leases up for renewal in the next ${RENEW_SOON_DAYS} days`);
    const review = active.find((i) => i.dedupeKey === reviewKey);
    expect(review?.severity).toBe('info');
    expect(review?.title).toBe('3 imported transactions are waiting for review');

    // Dedupe: generating again creates nothing new.
    const created = await insightService.generateInsights(accountId);
    expect(created).toEqual([]);
  });

  it('insights carry executable actions and context-aware deep links', async () => {
    const accountId = await getDemoAccountId();
    const keys = expectedInsightDedupeKeys(currentPeriod());
    const active = await insightService.listActive(accountId);

    // late_rent: one-click reminder targeting exactly the late payment.
    const lateRent = active.find((i) => i.dedupeKey === keys.lateRent);
    expect(lateRent?.actionTarget).toBe(`/rent?period=${currentPeriod()}`);
    expect(lateRent?.action?.label).toBe('Send reminder');
    const lateAction = lateRent?.action?.action;
    if (lateAction?.kind !== 'api_call') throw new Error('expected api_call action');
    expect(lateAction.method).toBe('POST');
    expect(lateAction.path).toBe('/rent/reminders');
    const payment = await prisma.rentPayment.findFirst({
      where: { leaseId: lateRent!.leaseId!, period: currentPeriod() },
    });
    expect(lateAction.body).toEqual({ rentPaymentIds: [payment!.id] });

    // expense_spike: deep link lands on Money pre-filtered to the category.
    const spike = active.find((i) => i.dedupeKey === keys.expenseSpike);
    expect(spike?.actionTarget).toMatch(/^\/money\?type=expense&categoryId=.+/);
    expect(spike?.action?.action).toEqual({ kind: 'navigate', to: spike!.actionTarget });

    // renewal_window: the standalone tenants list is gone — the deep link
    // lands on the soonest-ending lease's primary tenant (home of the
    // "Draft renewal" flow), and the body names every renewing tenant.
    const renewal = active.find((i) => i.dedupeKey === keys.renewalWindow);
    expect(renewal?.actionLabel).toBe('Review renewals');
    const soonestRenewal = await prisma.lease.findFirst({
      where: {
        status: 'active',
        unit: { property: { accountId } },
        endDate: { gte: new Date(), lte: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000) },
      },
      orderBy: { endDate: 'asc' },
      include: { leaseTenants: { where: { isPrimary: true }, include: { tenant: true } } },
    });
    const soonestTenant = soonestRenewal!.leaseTenants[0]!.tenant;
    expect(renewal?.actionTarget).toBe(`/tenants/${soonestTenant.id}`);
    expect(renewal?.action?.action).toEqual({
      kind: 'navigate',
      to: `/tenants/${soonestTenant.id}`,
    });
    expect(renewal?.tenantId).toBe(soonestTenant.id);
    expect(renewal?.body).toContain(soonestTenant.fullName);

    // transactions_pending_review: deep link straight into the review queue.
    const review = active.find((i) => i.type === 'transactions_pending_review');
    expect(review?.actionLabel).toBe('Review transactions');
    expect(review?.actionTarget).toBe('/money/review');
    expect(review?.action?.action).toEqual({ kind: 'navigate', to: '/money/review' });
  });

  it('POST /insights/:id/dismiss flips status, and the key stays dismissed', async () => {
    const accountId = await getDemoAccountId();
    const keys = expectedInsightDedupeKeys(currentPeriod());
    const active = await insightService.listActive(accountId);
    const renewal = active.find((i) => i.dedupeKey === keys.renewalWindow);
    expect(renewal).toBeDefined();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/insights/${renewal!.id}/dismiss`,
    });
    expect(res.statusCode).toBe(200);
    const dismissed = InsightSchema.parse(res.json());
    expect(dismissed.status).toBe('dismissed');

    // Dismissal sticks: the rule does not recreate the same dedupeKey.
    const created = await insightService.generateInsights(accountId);
    expect(created.map((c) => c.dedupeKey)).not.toContain(keys.renewalWindow);
    const stillActive = await insightService.listActive(accountId);
    expect(stillActive.map((i) => i.dedupeKey)).not.toContain(keys.renewalWindow);
  });

  it('dashboard insight is the highest-severity active card', async () => {
    const accountId = await getDemoAccountId();
    const top = await insightService.getDashboardInsight(accountId);
    expect(top?.severity).toBe('warning');
  });

  it("POST /insights/:id/actioned marks the insight actioned with 'ai_suggested_user_confirmed' attribution", async () => {
    const accountId = await getDemoAccountId();
    const keys = expectedInsightDedupeKeys(currentPeriod());
    const active = await insightService.listActive(accountId);
    const spike = active.find((i) => i.dedupeKey === keys.expenseSpike);
    expect(spike).toBeDefined();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/insights/${spike!.id}/actioned`,
    });
    expect(res.statusCode).toBe(200);
    const actioned = InsightSchema.parse(res.json());
    expect(actioned.status).toBe('actioned');

    // The audit row records that the user confirmed an AI suggestion — the
    // actor is fixed server-side, never client-supplied.
    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'insight.actioned', entityId: spike!.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.actor).toBe('ai_suggested_user_confirmed');

    // Actioned insights leave the active lists and are not recreated (dedupe
    // holds regardless of status).
    const created = await insightService.generateInsights(accountId);
    expect(created.map((c) => c.dedupeKey)).not.toContain(keys.expenseSpike);
    const stillActive = await insightService.listActive(accountId);
    expect(stillActive.map((i) => i.dedupeKey)).not.toContain(keys.expenseSpike);
  });

  it('getDashboardInsight self-refreshes — a new late-rent condition appears without an explicit generateInsights call', async () => {
    // Regression test for the "stale AI dashboard card" bug: previously
    // insights only regenerated once a day (jobs.service.ts's scheduler), so
    // new conditions the user caused themselves (e.g. a payment going late)
    // never showed up on the dashboard until the next day. getDashboardInsight
    // must now surface this on its own, with no generateInsights call in this
    // test at all.
    const { accountId, lease } = await createLateRentFixture('dashboard', 'Late Payer Dashboard');

    // Before: no Insight rows exist yet for this brand-new account. (A direct
    // count, not getDashboardInsight — calling that here would itself trigger
    // the same auto-materialization/generation this test is about to exercise
    // deliberately, via the lease's own dueDay.)
    expect(await prisma.insight.count({ where: { accountId } })).toBe(0);

    await makeRentLate(lease.id);

    const refreshed = await insightService.getDashboardInsight(accountId);
    expect(refreshed?.type).toBe('late_rent');
    expect(refreshed?.title).toContain('Late Payer Dashboard');
  });

  it('list()/listActive() self-refreshes — same bug, different read path (GET /insights, chat/MCP list_insights, TenantsList banner)', async () => {
    const { accountId, lease } = await createLateRentFixture('list', 'Late Payer List');
    expect(await prisma.insight.count({ where: { accountId } })).toBe(0);

    await makeRentLate(lease.id);

    // No generateInsights call — list() must refresh on its own now.
    const active = await insightService.listActive(accountId);
    expect(active.map((i) => i.type)).toContain('late_rent');
    expect(active.find((i) => i.type === 'late_rent')?.title).toContain('Late Payer List');
  });

  it("property.service.getDetail's embedded insights self-refresh (PropertyDetail page)", async () => {
    const { accountId, propertyId, lease } = await createLateRentFixture('property', 'Late Payer Property');
    expect(await prisma.insight.count({ where: { accountId } })).toBe(0);

    await makeRentLate(lease.id);

    // No generateInsights call — getDetail must refresh on its own now.
    const detail = await propertyService.getDetail(accountId, propertyId);
    expect(detail.insights.map((i) => i.type)).toContain('late_rent');
  });

  it("dashboard.service.getActivity's embedded insight entries self-refresh (Dashboard 'Recent activity' feed)", async () => {
    const { accountId, lease } = await createLateRentFixture('activity', 'Late Payer Activity');
    expect(await prisma.insight.count({ where: { accountId } })).toBe(0);

    await makeRentLate(lease.id);

    // No generateInsights call — getActivity must refresh on its own now.
    const activity = await dashboardService.getActivity(accountId, 10);
    const insightItems = activity.filter((a) => a.kind === 'insight');
    expect(insightItems.some((a) => a.text.includes('Late Payer Activity'))).toBe(true);
  });

  it('enriches a pre-action active row in place (production rows created before the structured-action deploy)', async () => {
    const { accountId, lease, tenant } = await createLateRentFixture('enrich', 'Late Payer Enrich');
    await makeRentLate(lease.id);

    // Simulate a row the old generator created: same dedupeKey the rule
    // derives today, but no structured action and the old generic target.
    await prisma.insight.create({
      data: {
        accountId,
        scope: 'tenant',
        type: 'late_rent',
        severity: 'warning',
        title: 'Late Payer Enrich is 10 days late on rent',
        body: 'Legacy body.',
        actionLabel: 'Review',
        actionTarget: '/rent',
        tenantId: tenant.id,
        leaseId: lease.id,
        dedupeKey: `late_rent:${slugify('Late Payer Enrich')}:${currentPeriod()}`,
        status: 'active',
      },
    });

    const active = await insightService.listActive(accountId);
    const lateRent = active.find((i) => i.type === 'late_rent');
    expect(lateRent?.action?.label).toBe('Send reminder');
    expect(lateRent?.actionTarget).toBe(`/rent?period=${currentPeriod()}`);
    // Still one row — enriched, not duplicated.
    expect(await prisma.insight.count({ where: { accountId, type: 'late_rent' } })).toBe(1);

    // A dismissed legacy row stays untouched (dismissal semantics win).
    await insightService.dismiss(accountId, lateRent!.id);
    const after = await insightService.list(accountId, { status: 'dismissed' });
    expect(after[0]?.status).toBe('dismissed');
  });

  it('concurrent self-refreshes for the same account race-safely (no unhandled unique-constraint error, exactly one row)', async () => {
    // Regression test for the concurrency corollary of the fix above: a
    // single Dashboard page load fires useDashboardInsight + useActivity (and
    // others) in parallel, so two requests can now call generateInsights for
    // the same account at nearly the same instant. Both would see "no
    // existing row" for the same dedupeKey and race to create it — this must
    // not surface as a 500 (Prisma P2002), and must not create a duplicate.
    const { accountId, lease } = await createLateRentFixture('race', 'Late Payer Race');
    await makeRentLate(lease.id);

    const results = await Promise.allSettled([
      insightService.getDashboardInsight(accountId),
      insightService.listActive(accountId),
      dashboardService.getActivity(accountId, 10),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const rows = await prisma.insight.findMany({
      where: { accountId, type: 'late_rent' },
    });
    expect(rows).toHaveLength(1);
  });
});

describe('contractor_cost_spike rule', () => {
  /** Fresh account + contractor + vendor-matched confirmed expenses. */
  async function createContractorFixture(
    emailSuffix: string,
    jobs: Array<{ monthsAgo: number; amountCents: number }>,
  ) {
    const account = await prisma.account.create({
      data: {
        name: `Contractor Spike ${emailSuffix}`,
        email: `contractor-spike-${emailSuffix}@integrationtest.example`,
      },
    });
    const contractor = await prisma.contractor.create({
      data: { accountId: account.id, name: 'Testy Plumbing', trade: 'Plumbing' },
    });
    for (const [i, job] of jobs.entries()) {
      const date = new Date();
      date.setUTCMonth(date.getUTCMonth() - job.monthsAgo);
      await prisma.transaction.create({
        data: {
          accountId: account.id,
          date,
          amountCents: job.amountCents,
          type: 'expense',
          description: `Fixture job ${i}`,
          vendor: 'Testy Plumbing',
          source: 'manual',
          status: 'confirmed',
        },
      });
    }
    return { accountId: account.id, contractorId: contractor.id };
  }

  it('fires when the latest job lands this month at >150% of the prior average, with a contractor deep link', async () => {
    const { accountId, contractorId } = await createContractorFixture('fires', [
      { monthsAgo: 3, amountCents: 20000 },
      { monthsAgo: 2, amountCents: 20000 },
      { monthsAgo: 1, amountCents: 20000 },
      { monthsAgo: 0, amountCents: 45000 }, // 225% of the $200 prior average
    ]);

    const active = await insightService.listActive(accountId);
    const spike = active.find((i) => i.type === 'contractor_cost_spike');
    expect(spike).toBeDefined();
    expect(spike!.severity).toBe('info');
    expect(spike!.title).toContain('Testy Plumbing');
    expect(spike!.actionTarget).toBe(`/maintenance/contractors/${contractorId}`);
    expect(spike!.action?.action).toEqual({
      kind: 'navigate',
      to: `/maintenance/contractors/${contractorId}`,
    });
    expect(spike!.dedupeKey).toBe(`contractor_cost_spike:testy-plumbing:${currentPeriod()}`);
  });

  it('stays quiet without a ≥3-job baseline or without a current-month job', async () => {
    // Only 2 prior jobs — an expensive latest job has no baseline to spike against.
    const thin = await createContractorFixture('thin', [
      { monthsAgo: 2, amountCents: 20000 },
      { monthsAgo: 1, amountCents: 20000 },
      { monthsAgo: 0, amountCents: 45000 },
    ]);
    expect(
      (await insightService.listActive(thin.accountId)).filter(
        (i) => i.type === 'contractor_cost_spike',
      ),
    ).toEqual([]);

    // Expensive latest job, but months old — old history is not news.
    const stale = await createContractorFixture('stale', [
      { monthsAgo: 5, amountCents: 20000 },
      { monthsAgo: 4, amountCents: 20000 },
      { monthsAgo: 3, amountCents: 20000 },
      { monthsAgo: 2, amountCents: 45000 },
    ]);
    expect(
      (await insightService.listActive(stale.accountId)).filter(
        (i) => i.type === 'contractor_cost_spike',
      ),
    ).toEqual([]);
  });

  it('does not fire on the seeded demo portfolio (flat per-contractor amounts)', async () => {
    const accountId = await getDemoAccountId();
    const active = await insightService.listActive(accountId);
    expect(active.filter((i) => i.type === 'contractor_cost_spike')).toEqual([]);
  });
});

describe('expense_spike baseline guard', () => {
  it('a category with no trailing history never "spikes" on its first spend', async () => {
    const accountId = await getDemoAccountId();
    const category = await prisma.category.create({
      data: { accountId, name: 'TEST Fresh Category', type: 'expense' },
    });
    const txn = await prisma.transaction.create({
      data: {
        accountId,
        date: new Date(),
        amountCents: 500_000, // would trivially beat a zero baseline
        type: 'expense',
        description: 'TEST first-ever spend in a new category',
        source: 'manual',
        status: 'confirmed',
        categoryId: category.id,
      },
    });

    await insightService.generateInsights(accountId);
    const spike = await prisma.insight.findFirst({
      where: { accountId, type: 'expense_spike', dedupeKey: { contains: 'test-fresh-category' } },
    });
    expect(spike).toBeNull();

    await prisma.transaction.delete({ where: { id: txn.id } });
    await prisma.category.delete({ where: { id: category.id } });
  });
});

describe('transactions_pending_review rule lifecycle', () => {
  /** Pending bank row with a pinned createdAt so "newest" is deterministic. */
  function createPendingTxn(accountId: string, description: string, createdAt: Date) {
    return prisma.transaction.create({
      data: {
        accountId,
        date: new Date(),
        amountCents: 4200,
        type: 'expense',
        description,
        source: 'bank',
        status: 'pending_review',
        createdAt,
      },
    });
  }

  it('keys the card to the newest pending row, refreshes the count in place, and auto-resolves when the queue clears', async () => {
    const account = await prisma.account.create({
      data: { name: 'Review Queue Rule', email: 'review-queue-rule@integrationtest.example' },
    });
    const older = await createPendingTxn(account.id, 'PENDING A', new Date(Date.now() - 60_000));
    const newest = await createPendingTxn(account.id, 'PENDING B', new Date());

    const created = await insightService.generateInsights(account.id);
    expect(created.map((c) => c.dedupeKey)).toEqual([
      `transactions_pending_review:${newest.id}`,
    ]);
    expect(created[0]?.title).toBe('2 imported transactions are waiting for review');
    expect(created[0]?.severity).toBe('info');

    // Confirming the older row keeps the key (newest is unchanged) but the
    // live card's count must refresh in place — no new row.
    await prisma.transaction.update({ where: { id: older.id }, data: { status: 'confirmed' } });
    expect(await insightService.generateInsights(account.id)).toEqual([]);
    const card = await prisma.insight.findFirst({
      where: { accountId: account.id, type: 'transactions_pending_review', status: 'active' },
    });
    expect(card?.title).toBe('1 imported transaction is waiting for review');
    expect(card?.dedupeKey).toBe(`transactions_pending_review:${newest.id}`);

    // Clearing the queue resolves the card instead of leaving it stale.
    await prisma.transaction.update({ where: { id: newest.id }, data: { status: 'confirmed' } });
    expect(await insightService.generateInsights(account.id)).toEqual([]);
    const resolved = await prisma.insight.findFirst({
      where: { accountId: account.id, type: 'transactions_pending_review' },
    });
    expect(resolved?.status).toBe('actioned');
  });

  it('a dismissal sticks until the next import lands, which supersedes with a new key', async () => {
    const account = await prisma.account.create({
      data: { name: 'Review Queue Dismiss', email: 'review-queue-dismiss@integrationtest.example' },
    });
    const first = await createPendingTxn(account.id, 'PENDING C', new Date(Date.now() - 60_000));

    const [created] = await insightService.generateInsights(account.id);
    await insightService.dismiss(account.id, created!.id);

    // Same queue, no new imports: the dismissed key is never recreated.
    expect(await insightService.generateInsights(account.id)).toEqual([]);

    // A new import (newer pending row) is materially new — a fresh card
    // appears under the new key while the dismissed row stays dismissed.
    const newer = await createPendingTxn(account.id, 'PENDING D', new Date());
    const recreated = await insightService.generateInsights(account.id);
    expect(recreated.map((c) => c.dedupeKey)).toEqual([
      `transactions_pending_review:${newer.id}`,
    ]);
    expect(recreated[0]?.title).toBe('2 imported transactions are waiting for review');
    const old = await prisma.insight.findFirst({
      where: { accountId: account.id, dedupeKey: `transactions_pending_review:${first.id}` },
    });
    expect(old?.status).toBe('dismissed');
  });

  it('an active card superseded by a newer import resolves in favor of the new key', async () => {
    const account = await prisma.account.create({
      data: { name: 'Review Queue Supersede', email: 'review-queue-supersede@integrationtest.example' },
    });
    const first = await createPendingTxn(account.id, 'PENDING E', new Date(Date.now() - 60_000));
    await insightService.generateInsights(account.id);

    const newer = await createPendingTxn(account.id, 'PENDING F', new Date());
    const recreated = await insightService.generateInsights(account.id);
    expect(recreated.map((c) => c.dedupeKey)).toEqual([
      `transactions_pending_review:${newer.id}`,
    ]);

    // Exactly one active card; the superseded one auto-resolved.
    const rows = await prisma.insight.findMany({
      where: { accountId: account.id, type: 'transactions_pending_review' },
    });
    const statusByKey = new Map(rows.map((r) => [r.dedupeKey, r.status]));
    expect(statusByKey).toEqual(
      new Map([
        [`transactions_pending_review:${first.id}`, 'actioned'],
        [`transactions_pending_review:${newer.id}`, 'active'],
      ]),
    );
  });
});
