// Rent-materialization coverage for the lease transitions the switchover
// reconciliation cannot reach: months materialized *after* a renewal is created
// (ARCHITECTURE §4). materializeExpectedPayments must bill a lease by date range
// regardless of active/ended status, blend two sequential leases covering one
// month into a single prorated charge that matches the reconcile path
// byte-for-byte, and never bill a terminated lease past its shortened endDate.
// Plus the create-time overlap guard. Runs on a dedicated, cascade-cleaned
// account so its account-wide future-month materialization never touches the
// pinned demo seed (later files assert its exact numbers).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDays,
  addMonthsToPeriod,
  currentPeriodInTz,
  iso,
  monthEndExclusiveInTz,
  monthStartInTz,
} from '../lib/dates';
import { prisma } from '../lib/prisma';
import * as leaseService from '../services/lease.service';
import * as rentService from '../services/rent.service';
import * as tenantService from '../services/tenant.service';

const EMAIL = (s: string) => `mat-gap-${s}@matgaptest.example`;
const TZ = 'America/New_York';
const DAY_MS = 86_400_000;

let accountId: string;
let propertyId: string;
let tenantCounter = 0;
let unitCounter = 0;

const period = currentPeriodInTz(TZ);
const periodStart = monthStartInTz(period, TZ);
const daysInMonth = Math.round(
  (monthEndExclusiveInTz(period, TZ).getTime() - periodStart.getTime()) / DAY_MS,
);

async function makeUnit(): Promise<string> {
  const unit = await prisma.unit.create({ data: { propertyId, label: `MG${++unitCounter}` } });
  return unit.id;
}

async function makeLease(
  unitId: string,
  rentCents: number,
  startDate: Date,
  endDate: Date,
): Promise<string> {
  const tenant = await tenantService.create(accountId, {
    fullName: `MatGap Tenant ${++tenantCounter}`,
  });
  const lease = await leaseService.create(accountId, {
    unitId,
    tenantIds: [tenant.id],
    rentCents,
    dueDay: 1,
    startDate: iso(startDate),
    endDate: iso(endDate),
  });
  return lease.id;
}

beforeAll(async () => {
  const account = await prisma.account.create({
    data: { name: 'Mat Gap Co', email: EMAIL('main'), timezone: TZ, graceDays: 0 },
  });
  accountId = account.id;
  const property = await prisma.property.create({
    data: { accountId, addressLine1: '1 Materialize Way', city: 'X', state: 'CA', zip: '00000' },
  });
  propertyId = property.id;
});

afterAll(async () => {
  // Cascade cleans property → unit → lease → rentPayment, tenants, audit logs.
  await prisma.account.deleteMany({ where: { email: { endsWith: '@matgaptest.example' } } });
});

describe('future-dated renewal — intervening month materialized after the renewal', () => {
  it('bills the outgoing lease in full for a month its (ended) range still covers', async () => {
    const unitId = await makeUnit();
    const oldRent = 100_000;
    // New term starts two months out; the old lease still owns everything before it.
    const newStart = monthStartInTz(addMonthsToPeriod(period, 2), TZ);
    const leaseId = await makeLease(unitId, oldRent, addDays(periodStart, -365), addDays(newStart, 60));

    // Renew far in the future — this flips the source lease to status 'ended'
    // with endDate = newStart, months before it was ever viewed/materialized.
    await leaseService.createRenewal(accountId, leaseId, {
      rentCents: 130_000,
      dueDay: 1,
      startDate: iso(newStart),
      endDate: iso(addDays(newStart, 365)),
    });

    // The intervening month, first viewed only now — after the renewal.
    const gapPeriod = addMonthsToPeriod(period, 1);
    await rentService.materializeExpectedPayments(accountId, gapPeriod);

    const rows = await prisma.rentPayment.findMany({ where: { period: gapPeriod, lease: { unitId } } });
    expect(rows).toHaveLength(1); // the bug silently produced zero rows here
    const row = rows[0]!;
    expect(row.leaseId).toBe(leaseId); // still the outgoing lease's charge
    expect(row.amountCents).toBe(oldRent); // full month — old lease covers all of it
    expect(row.dueDate.getTime()).toBe(monthStartInTz(gapPeriod, TZ).getTime());
    expect(row.status).toBe('due');
  });

  it('bills only the successor for the month the new term actually starts', async () => {
    const unitId = await makeUnit();
    const oldRent = 100_000;
    const newRent = 130_000;
    const newStart = monthStartInTz(addMonthsToPeriod(period, 2), TZ);
    await makeLease(unitId, oldRent, addDays(periodStart, -365), addDays(newStart, 60));
    // (Renew via the existing source lease created above.)
    const source = await prisma.lease.findFirstOrThrow({ where: { unitId } });
    await leaseService.createRenewal(accountId, source.id, {
      rentCents: newRent,
      dueDay: 1,
      startDate: iso(newStart),
      endDate: iso(addDays(newStart, 365)),
    });

    const startPeriod = addMonthsToPeriod(period, 2);
    await rentService.materializeExpectedPayments(accountId, startPeriod);

    const rows = await prisma.rentPayment.findMany({ where: { period: startPeriod, lease: { unitId } } });
    // The outgoing lease's endDate == newStart abuts (does not overlap) the new
    // term, so it covers 0 days of the start month → exactly one full new charge.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.leaseId).not.toBe(source.id);
    expect(rows[0]!.amountCents).toBe(newRent);
  });
});

describe('same-month switchover — materialize path converges with the reconcile path', () => {
  it('produces a single blended charge identical to a pre-materialized month', async () => {
    const oldRent = 100_000;
    const newRent = 130_000;
    const switchDate = addDays(periodStart, 14); // old owns days 1–14, new the rest
    const blended = Math.round((oldRent * 14 + newRent * (daysInMonth - 14)) / daysInMonth);

    // Unit A — materialize path: renew BEFORE the month is ever materialized, so
    // reconcile has nothing to adjust and the whole blend falls to materialize.
    const unitA = await makeUnit();
    const oldA = await makeLease(unitA, oldRent, addDays(periodStart, -365), addDays(periodStart, 180));
    await leaseService.createRenewal(accountId, oldA, {
      rentCents: newRent,
      dueDay: 1,
      startDate: iso(switchDate),
      endDate: iso(addDays(switchDate, 365)),
    });

    // Unit B — reconcile path: materialize the full month first, THEN renew, so
    // reconcileShortenedLeaseCharges blends the pre-existing charge.
    const unitB = await makeUnit();
    const oldB = await makeLease(unitB, oldRent, addDays(periodStart, -365), addDays(periodStart, 180));
    await rentService.materializeExpectedPayments(accountId, period); // materializes A (blend) + B (full)
    await leaseService.createRenewal(accountId, oldB, {
      rentCents: newRent,
      dueDay: 1,
      startDate: iso(switchDate),
      endDate: iso(addDays(switchDate, 365)),
    });
    await rentService.materializeExpectedPayments(accountId, period); // no-op, both units already charged

    const rowsA = await prisma.rentPayment.findMany({ where: { period, lease: { unitId: unitA } } });
    const rowsB = await prisma.rentPayment.findMany({ where: { period, lease: { unitId: unitB } } });
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    const rowA = rowsA[0]!;
    const rowB = rowsB[0]!;

    // The convergence assertion: both paths land on the same blended charge,
    // both owned by the OUTGOING (source) lease, both due on the 1st.
    expect(rowA.amountCents).toBe(blended);
    expect(rowB.amountCents).toBe(blended);
    expect(rowA.amountCents).toBe(rowB.amountCents);
    expect(rowA.leaseId).toBe(oldA);
    expect(rowB.leaseId).toBe(oldB);
    expect(rowA.dueDate.getTime()).toBe(rowB.dueDate.getTime());
    expect(rowA.dueDate.getTime()).toBe(periodStart.getTime());
  });
});

describe('terminated lease — no charge after its shortened endDate', () => {
  it('does not materialize a month past the termination date', async () => {
    const unitId = await makeUnit();
    const leaseId = await makeLease(unitId, 93_000, addDays(periodStart, -365), addDays(periodStart, 400));
    await rentService.materializeExpectedPayments(accountId, period);
    await leaseService.terminate(accountId, leaseId); // endDate → today (this month)

    // A month wholly after the termination — the date-range filter (endDate >=
    // periodStart) excludes the now-ended lease, so nothing is billed.
    const afterPeriod = addMonthsToPeriod(period, 1);
    await rentService.materializeExpectedPayments(accountId, afterPeriod);

    const rows = await prisma.rentPayment.findMany({ where: { period: afterPeriod, lease: { unitId } } });
    expect(rows).toHaveLength(0);
  });
});

describe('create-time overlap guard', () => {
  it('rejects a lease whose date range overlaps an existing lease on the unit', async () => {
    const unitId = await makeUnit();
    await makeLease(unitId, 100_000, periodStart, addDays(periodStart, 99));
    const tenant = await tenantService.create(accountId, { fullName: `MatGap Tenant ${++tenantCounter}` });
    await expect(
      leaseService.create(accountId, {
        unitId,
        tenantIds: [tenant.id],
        rentCents: 105_000,
        dueDay: 1,
        startDate: iso(addDays(periodStart, 50)),
        endDate: iso(addDays(periodStart, 150)),
      }),
    ).rejects.toThrow(/covering part of that date range/);
  });

  it('allows an abutting lease (previous endDate == next startDate)', async () => {
    const unitId = await makeUnit();
    const boundary = addDays(periodStart, 100);
    await makeLease(unitId, 100_000, periodStart, boundary);
    const secondId = await makeLease(unitId, 110_000, boundary, addDays(periodStart, 300));
    expect(secondId).toBeTruthy();
    const leases = await prisma.lease.findMany({ where: { unitId } });
    expect(leases).toHaveLength(2);
  });

  it('does not block a renewal switchover (creates + shortens in one transaction)', async () => {
    const unitId = await makeUnit();
    const leaseId = await makeLease(unitId, 100_000, addDays(periodStart, -365), addDays(periodStart, 180));
    await rentService.materializeExpectedPayments(accountId, period);
    const renewed = await leaseService.createRenewal(accountId, leaseId, {
      rentCents: 110_000,
      dueDay: 1,
      startDate: iso(addDays(periodStart, 14)),
      endDate: iso(addDays(periodStart, 379)),
    });
    expect(renewed.status).toBe('active');
    const rows = await prisma.rentPayment.findMany({ where: { period, lease: { unitId } } });
    expect(rows).toHaveLength(1); // single blended charge, no double-billing
  });
});
