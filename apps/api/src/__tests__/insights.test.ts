// (d) Insight rules produce the 3 seeded dedupeKeys; dismiss flips status and
// dedupe keeps dismissed keys from coming back.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { InsightSchema } from '@hearth/shared';
import { expectedInsightDedupeKeys } from '../../prisma/seed-constants';
import { buildApp } from '../app';
import { currentPeriod } from '../lib/dates';
import { getDemoAccountId } from '../plugins/auth';
import * as insightService from '../services/insight.service';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
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
});
