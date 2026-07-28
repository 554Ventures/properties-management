// GET /rent/open-charges — the manual rent-charge picker's option list
// (rent-match v2): every open (due/processing) charge with a positive
// remaining balance, deliberately with NO date-window or attribution
// filtering. Read-only; uses the seeded demo account's Okafor and Park
// charges, which stay open all suite long (see seed-constants.ts) — no
// fixtures to clean up.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { OpenRentChargesResponseSchema } from '@hearth/shared';
import { OKAFOR_NAME, PARK_NAME } from '../../prisma/seed-constants';
import { buildApp } from '../app';
import { currentPeriod } from '../lib/dates';
import { getDemoAccountId } from '../plugins/auth';
import * as rentService from '../services/rent.service';

let app: FastifyInstance;
let accountId: string;
const period = currentPeriod();

beforeAll(async () => {
  app = await buildApp();
  accountId = await getDemoAccountId();
});

afterAll(async () => {
  await app.close();
});

describe('GET /rent/open-charges', () => {
  it('lists the seeded open charges with their remaining balance and excludes paid charges', async () => {
    const tracker = await rentService.getMonthStatus(accountId, period);
    const okafor = tracker.rows.find((r) => r.tenantName === OKAFOR_NAME)!;
    const park = tracker.rows.find((r) => r.tenantName === PARK_NAME)!;
    const paidRow = tracker.rows.find((r) => r.status === 'paid');
    // Sanity-check the fixtures this test depends on before asserting against them.
    expect(okafor.status).not.toBe('paid');
    expect(park.status).not.toBe('paid');
    expect(paidRow).toBeDefined();

    const res = await app.inject({ method: 'GET', url: '/api/v1/rent/open-charges' });
    expect(res.statusCode).toBe(200);
    const body = OpenRentChargesResponseSchema.parse(res.json());

    expect(body.items.find((i) => i.rentPaymentId === okafor.rentPaymentId)).toMatchObject({
      leaseId: okafor.leaseId,
      tenantName: OKAFOR_NAME,
      unitLabel: okafor.unitLabel,
      propertyLabel: okafor.propertyLabel,
      period,
      remainingCents: okafor.amountCents + okafor.lateFeeCents - okafor.paidCents,
    });
    expect(body.items.find((i) => i.rentPaymentId === park.rentPaymentId)).toMatchObject({
      leaseId: park.leaseId,
      tenantName: PARK_NAME,
      unitLabel: park.unitLabel,
      propertyLabel: park.propertyLabel,
      period,
      remainingCents: park.amountCents + park.lateFeeCents - park.paidCents,
    });
    // A fully paid charge has zero remaining balance — never listed.
    expect(body.items.find((i) => i.rentPaymentId === paidRow!.rentPaymentId)).toBeUndefined();
    expect(body.items.every((i) => i.remainingCents > 0)).toBe(true);
  });

  it('orders items period desc, then propertyLabel/unitLabel asc', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/rent/open-charges' });
    const body = OpenRentChargesResponseSchema.parse(res.json());
    const sorted = [...body.items].sort(
      (a, b) =>
        (a.period < b.period ? 1 : a.period > b.period ? -1 : 0) ||
        a.propertyLabel.localeCompare(b.propertyLabel) ||
        a.unitLabel.localeCompare(b.unitLabel),
    );
    expect(body.items).toEqual(sorted);
  });
});
