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
    const account = await prisma.account.create({
      data: { name: 'Stale Insight Regression', email: 'stale-insight@integrationtest.example' },
    });
    const property = await propertyService.create(account.id, {
      addressLine1: '1 Stale Insight Way',
      city: 'Springfield',
      state: 'IL',
      zip: '62701',
      units: [{ label: 'Unit A' }],
    });
    const detail = await propertyService.getDetail(account.id, property.id);
    const unitId = detail.units[0]!.id;
    const tenant = await tenantService.create(account.id, { fullName: 'Late Payer' });
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

    // Before: no Insight rows exist yet for this brand-new account. (A direct
    // count, not getDashboardInsight — calling that here would itself trigger
    // the same auto-materialization/generation this test is about to exercise
    // deliberately, via the lease's own dueDay.)
    expect(await prisma.insight.count({ where: { accountId: account.id } })).toBe(0);

    // Materialize an overdue RentPayment directly (mirrors what
    // rentService.materializeExpectedPayments would create), 10 days late —
    // past the >5-day late_rent threshold. No call to generateInsights here.
    await prisma.rentPayment.create({
      data: {
        leaseId: lease.id,
        period: currentPeriod(),
        dueDate: addDays(new Date(), -10),
        amountCents: 100000,
        status: 'due',
      },
    });

    const refreshed = await insightService.getDashboardInsight(account.id);
    expect(refreshed?.type).toBe('late_rent');
    expect(refreshed?.title).toContain('Late Payer');

    await prisma.account.deleteMany({ where: { id: account.id } });
  });
});
