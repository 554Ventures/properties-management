// (d) Insight rules produce the 3 seeded dedupeKeys; dismiss flips status and
// dedupe keeps dismissed keys from coming back.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { InsightSchema } from '@hearth/shared';
import { expectedInsightDedupeKeys } from '../../prisma/seed-constants';
import { buildApp } from '../app';
import { addDays, currentPeriod } from '../lib/dates';
import { prisma } from '../lib/prisma';
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
  it('seed produced exactly the 3 expected dedupeKeys, and re-running is a no-op', async () => {
    const accountId = await getDemoAccountId();
    const keys = expectedInsightDedupeKeys(currentPeriod());

    const active = await insightService.listActive(accountId);
    const activeKeys = active.map((i) => i.dedupeKey).sort();
    expect(activeKeys).toEqual([keys.expenseSpike, keys.lateRent, keys.renewalWindow].sort());

    const lateRent = active.find((i) => i.dedupeKey === keys.lateRent);
    expect(lateRent?.severity).toBe('warning');
    expect(lateRent?.type).toBe('late_rent');
    const renewal = active.find((i) => i.dedupeKey === keys.renewalWindow);
    expect(renewal?.title).toBe('2 leases up for renewal in the next 60 days');

    // Dedupe: generating again creates nothing new.
    const created = await insightService.generateInsights(accountId);
    expect(created).toEqual([]);
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
