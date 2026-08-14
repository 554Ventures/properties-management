// Rent charge reconciliation around lease transitions (ARCHITECTURE §4):
// one charge per unit-month, prorated partial-coverage months, due dates
// never before the lease starts, and renewal/termination adjusting the open
// charges they shorten. Every row this file creates is removed again.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMonthsToPeriod, currentPeriodInTz, dayOfMonthInTz, iso, monthEndExclusiveInTz, monthStartInTz, startOfDayInTz } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import { DEMO_TIMEZONE } from '../../prisma/seed-constants';
import * as leaseService from '../services/lease.service';
import * as propertyService from '../services/property.service';
import * as rentService from '../services/rent.service';
import * as tenantService from '../services/tenant.service';

const DAY_MS = 86_400_000;

// The demo account lives in DEMO_TIMEZONE, and rent proration/materialization
// now bucket on that local calendar (WS4). Build fixture dates + expectations
// on the same tz so the test's proration math matches the service's.
const TZ = DEMO_TIMEZONE;

let accountId: string;
let propertyId: string;
let unitIds: string[] = [];
const tenantIds: string[] = [];
const leaseIds: string[] = [];

const period = currentPeriodInTz(TZ);
const periodStart = monthStartInTz(period, TZ);
const daysInMonth = Math.round((monthEndExclusiveInTz(period, TZ).getTime() - periodStart.getTime()) / DAY_MS);

async function makeLease(
  unitId: string,
  rentCents: number,
  startDate: Date,
  endDate: Date,
): Promise<string> {
  const tenant = await tenantService.create(accountId, {
    fullName: `Reconcile Tenant ${tenantIds.length + 1}`,
  });
  tenantIds.push(tenant.id);
  const lease = await leaseService.create(accountId, {
    unitId,
    tenantIds: [tenant.id],
    rentCents,
    dueDay: 1,
    startDate: iso(startDate),
    endDate: iso(endDate),
  });
  leaseIds.push(lease.id);
  return lease.id;
}

beforeAll(async () => {
  accountId = await getDemoAccountId();
  const property = await propertyService.create(accountId, {
    addressLine1: 'RECONCILE 9 Test Way',
    city: 'X',
    state: 'CA',
    zip: '00000',
    units: [
      { label: 'R1' },
      { label: 'R2' },
      { label: 'R3' },
      { label: 'R4' },
      { label: 'R5' },
      { label: 'R6' },
      { label: 'R7' },
      { label: 'R8' },
      { label: 'R9' },
    ],
  });
  propertyId = property.id;
  unitIds = (
    await prisma.unit.findMany({ where: { propertyId }, orderBy: { label: 'asc' } })
  ).map((u) => u.id);
});

afterAll(async () => {
  await prisma.rentPayment.deleteMany({ where: { leaseId: { in: leaseIds } } });
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.unit.deleteMany({ where: { propertyId } });
  await prisma.insight.deleteMany({ where: { accountId, propertyId } });
  await prisma.property.delete({ where: { id: propertyId } });
  await prisma.auditLog.deleteMany({
    where: { accountId, entityId: { in: [propertyId, ...leaseIds, ...tenantIds] } },
  });
  await prisma.auditLog.deleteMany({ where: { accountId, entityType: 'rent_payment', action: { in: ['rent_payment.adjusted', 'rent_payment.voided'] } } });
});

describe('mid-month renewal switchover', () => {
  it('keeps a single blended charge for the unit instead of two full months', async () => {
    const unitId = unitIds[0]!;
    const oldRent = 100_000;
    const newRent = 110_000;
    const leaseId = await makeLease(unitId, oldRent, addDays(periodStart, -365), addDays(periodStart, 180));
    await rentService.materializeExpectedPayments(accountId, period);

    // Renew from the 15th: old lease covers days 1–14, the new one the rest.
    const switchDate = addDays(periodStart, 14);
    await leaseService.createRenewal(accountId, leaseId, {
      rentCents: newRent,
      dueDay: 1,
      startDate: iso(switchDate),
      endDate: iso(addDays(switchDate, 365)),
    });
    await rentService.materializeExpectedPayments(accountId, period);

    const rows = await prisma.rentPayment.findMany({
      where: { period, lease: { unitId } },
    });
    expect(rows).toHaveLength(1);
    const blended = Math.round((oldRent * 14 + newRent * (daysInMonth - 14)) / daysInMonth);
    expect(rows[0]!.amountCents).toBe(blended);
    expect(rows[0]!.status).toBe('due');

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'rent_payment.adjusted', entityId: rows[0]!.id },
    });
    expect(JSON.parse(audit!.detailJson!)).toMatchObject({
      priorAmountCents: oldRent,
      amountCents: blended,
      reason: 'lease_renewal_switchover',
    });
  });

  it('never touches an already-paid month and never double-charges it', async () => {
    const unitId = unitIds[1]!;
    const oldRent = 90_000;
    const leaseId = await makeLease(unitId, oldRent, addDays(periodStart, -365), addDays(periodStart, 180));
    await rentService.materializeExpectedPayments(accountId, period);
    await rentService.recordPayment(accountId, {
      leaseId,
      period,
      amountCents: oldRent,
      method: 'manual',
    });

    await leaseService.createRenewal(accountId, leaseId, {
      rentCents: 95_000,
      dueDay: 1,
      startDate: iso(addDays(periodStart, 14)),
      endDate: iso(addDays(periodStart, 379)),
    });
    await rentService.materializeExpectedPayments(accountId, period);

    const rows = await prisma.rentPayment.findMany({ where: { period, lease: { unitId } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('paid');
    expect(rows[0]!.amountCents).toBe(oldRent);

    // Ledger cleanup for the recorded payment (kept out of afterAll: the
    // transaction row is account-scoped, not lease-scoped).
    await prisma.transaction.deleteMany({ where: { id: rows[0]!.transactionId! } });
  });
});

describe('mid-month termination', () => {
  it('re-prorates the final month to occupied days and voids future charges', async () => {
    const unitId = unitIds[2]!;
    const rent = 93_000;
    const leaseId = await makeLease(unitId, rent, addDays(periodStart, -365), addDays(periodStart, 180));
    await rentService.materializeExpectedPayments(accountId, period);
    // A future month someone already materialized (e.g. by viewing it).
    const nextPeriod = addMonthsToPeriod(period, 1);
    const futureRow = await prisma.rentPayment.create({
      data: {
        leaseId,
        period: nextPeriod,
        dueDate: monthEndExclusiveInTz(period, TZ),
        amountCents: rent,
        status: 'due',
      },
    });

    await leaseService.terminate(accountId, leaseId);

    // terminate ends the lease on today's local day, so the final month covers
    // days 1..(local day-of-month), inclusive — matched on the account tz.
    const occupiedDays = dayOfMonthInTz(startOfDayInTz(new Date(), TZ), TZ);
    const row = await prisma.rentPayment.findUniqueOrThrow({
      where: { leaseId_period: { leaseId, period } },
    });
    expect(row.amountCents).toBe(Math.round((rent * occupiedDays) / daysInMonth));

    expect(await prisma.rentPayment.findUnique({ where: { id: futureRow.id } })).toBeNull();
    const voided = await prisma.auditLog.findFirst({
      where: { accountId, action: 'rent_payment.voided', entityId: futureRow.id },
    });
    expect(JSON.parse(voided!.detailJson!)).toMatchObject({
      priorAmountCents: rent,
      reason: 'lease_terminated',
    });
  });
});

describe('second renewal inside the same month', () => {
  it('re-blends the charge still owned by the original lease (O→S→T)', async () => {
    const unitId = unitIds[4]!;
    const rentO = 100_000;
    const rentS = 110_000;
    const rentT = 120_000;
    const oId = await makeLease(unitId, rentO, addDays(periodStart, -365), addDays(periodStart, 180));
    await rentService.materializeExpectedPayments(accountId, period);

    // First renewal from the 10th: the month's row (owned by O) blends O+S.
    const switch1 = addDays(periodStart, 9);
    const sLease = await leaseService.createRenewal(accountId, oId, {
      rentCents: rentS,
      dueDay: 1,
      startDate: iso(switch1),
      endDate: iso(addDays(switch1, 365)),
    });
    leaseIds.push(sLease.id);

    // Second renewal from the 20th. The row belongs to O, not S — a reconcile
    // scoped to the renewed lease finds nothing and keeps the O+S blend
    // (over-billing S through month end, never billing T).
    const switch2 = addDays(periodStart, 19);
    const tLease = await leaseService.createRenewal(accountId, sLease.id, {
      rentCents: rentT,
      dueDay: 1,
      startDate: iso(switch2),
      endDate: iso(addDays(switch2, 365)),
    });
    leaseIds.push(tLease.id);
    await rentService.materializeExpectedPayments(accountId, period);

    const rows = await prisma.rentPayment.findMany({ where: { period, lease: { unitId } } });
    expect(rows).toHaveLength(1);
    // O days 1–9, S days 10–19, T days 20–end; rounded once on the blended sum.
    const blended = Math.round(
      (rentO * 9) / daysInMonth +
        (rentS * 10) / daysInMonth +
        (rentT * (daysInMonth - 19)) / daysInMonth,
    );
    expect(rows[0]!.leaseId).toBe(oId); // ownership never moves off the earliest lease
    expect(rows[0]!.amountCents).toBe(blended);

    const audits = await prisma.auditLog.findMany({
      where: { accountId, action: 'rent_payment.adjusted', entityId: rows[0]!.id },
    });
    expect(
      audits.some((a) => {
        const detail = JSON.parse(a.detailJson!);
        return detail.amountCents === blended && detail.reason === 'lease_renewal_switchover';
      }),
    ).toBe(true);
  });
});

describe('re-lease after a mid-month vacancy', () => {
  it('re-blends a materialized month when a new lease starts inside it', async () => {
    const unitId = unitIds[5]!;
    const rentOld = 90_000;
    const rentNew = 96_000;
    // The outgoing lease ends on the 10th of this month; its charge
    // materializes prorated to days 1–10.
    const oldId = await makeLease(unitId, rentOld, addDays(periodStart, -365), addDays(periodStart, 9));
    await rentService.materializeExpectedPayments(accountId, period);
    const before = await prisma.rentPayment.findUniqueOrThrow({
      where: { leaseId_period: { leaseId: oldId, period } },
    });
    expect(before.amountCents).toBe(Math.round((rentOld * 10) / daysInMonth));

    // Re-lease from the 20th. The unit-level materialization guard suppresses a
    // second row for the month, so creating the lease must re-blend the
    // existing charge — otherwise the new lease's share is never billed.
    const newStart = addDays(periodStart, 19);
    const newId = await makeLease(unitId, rentNew, newStart, addDays(newStart, 365));
    await rentService.materializeExpectedPayments(accountId, period);

    const rows = await prisma.rentPayment.findMany({ where: { period, lease: { unitId } } });
    expect(rows).toHaveLength(1);
    const blended = Math.round(
      (rentOld * 10) / daysInMonth + (rentNew * (daysInMonth - 19)) / daysInMonth,
    );
    expect(rows[0]!.leaseId).toBe(oldId); // still the earliest lease's row
    expect(rows[0]!.leaseId).not.toBe(newId);
    expect(rows[0]!.amountCents).toBe(blended);

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'rent_payment.adjusted', entityId: rows[0]!.id },
    });
    expect(JSON.parse(audit!.detailJson!)).toMatchObject({
      priorAmountCents: before.amountCents,
      amountCents: blended,
      reason: 'lease_created',
    });
  });
});

describe('lease update reconciliation', () => {
  it('editing endDate to remove an overlap with a successor recomputes the charge to the single-lease amount', async () => {
    const unitId = unitIds[6]!;
    const oldRent = 90_000;
    const newRent = 100_000;
    // B is the unit's real, ongoing lease — on its own it covers the whole period.
    const bId = await makeLease(unitId, newRent, addDays(periodStart, -100), addDays(periodStart, 265));
    await rentService.materializeExpectedPayments(accountId, period);
    const before = await prisma.rentPayment.findUniqueOrThrow({
      where: { leaseId_period: { leaseId: bId, period } },
    });
    expect(before.amountCents).toBe(newRent);

    // A is a predecessor that should have ended well before B started. Its
    // endDate is pushed 10 days into B's tenure directly (not through
    // leaseService), matching the production bug: a bad endDate edit that
    // creates an overlap, made before this fix existed to reconcile it.
    const aId = await makeLease(unitId, oldRent, addDays(periodStart, -400), addDays(periodStart, -101));
    await prisma.lease.update({
      where: { id: aId },
      data: { endDate: addDays(periodStart, 10) },
    });
    const aOverlap = await prisma.lease.findUniqueOrThrow({ where: { id: aId } });
    const bLease = await prisma.lease.findUniqueOrThrow({ where: { id: bId } });
    const overlapCovering = rentService.coveringLeases([aOverlap, bLease], period, TZ);
    const staleBlended = rentService.blendedChargeCents(overlapCovering, period, TZ);
    expect(staleBlended).not.toBe(newRent); // sanity: the overlap really shifts the figure
    await prisma.rentPayment.update({ where: { id: before.id }, data: { amountCents: staleBlended } });

    // The fix: correct A's endDate back to before the period, eliminating the
    // overlap with B — exactly the production repro (update_lease correcting
    // an overlapping endDate).
    await leaseService.update(accountId, aId, { endDate: iso(addDays(periodStart, -101)) });

    const after = await prisma.rentPayment.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.amountCents).toBe(newRent);
    expect(after.status).toBe('due');

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'rent_payment.adjusted', entityId: before.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(JSON.parse(audit!.detailJson!)).toMatchObject({
      priorAmountCents: staleBlended,
      amountCents: newRent,
      reason: 'lease_updated',
    });
  });

  it('editing rentCents updates the open charge for periods the lease covers', async () => {
    const unitId = unitIds[7]!;
    const oldRent = 80_000;
    const newRent = 85_000;
    const leaseId = await makeLease(unitId, oldRent, addDays(periodStart, -365), addDays(periodStart, 180));
    await rentService.materializeExpectedPayments(accountId, period);
    const before = await prisma.rentPayment.findUniqueOrThrow({
      where: { leaseId_period: { leaseId, period } },
    });
    expect(before.amountCents).toBe(oldRent);

    await leaseService.update(accountId, leaseId, { rentCents: newRent });

    const after = await prisma.rentPayment.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.amountCents).toBe(newRent);

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'rent_payment.adjusted', entityId: before.id },
    });
    expect(JSON.parse(audit!.detailJson!)).toMatchObject({
      priorAmountCents: oldRent,
      amountCents: newRent,
      reason: 'lease_updated',
    });
  });

  it('never touches an already-paid charge', async () => {
    const unitId = unitIds[8]!;
    const rent = 70_000;
    const leaseId = await makeLease(unitId, rent, addDays(periodStart, -365), addDays(periodStart, 180));
    await rentService.materializeExpectedPayments(accountId, period);
    await rentService.recordPayment(accountId, {
      leaseId,
      period,
      amountCents: rent,
      method: 'manual',
    });
    const paid = await prisma.rentPayment.findUniqueOrThrow({
      where: { leaseId_period: { leaseId, period } },
    });
    expect(paid.status).toBe('paid');

    await leaseService.update(accountId, leaseId, { rentCents: rent + 5_000 });

    const after = await prisma.rentPayment.findUniqueOrThrow({ where: { id: paid.id } });
    expect(after.amountCents).toBe(rent); // untouched — paid rows are history, not a projection
    expect(after.status).toBe('paid');

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'rent_payment.adjusted', entityId: paid.id },
    });
    expect(audit).toBeNull();

    // Ledger cleanup for the recorded payment (kept out of afterAll: the
    // transaction row is account-scoped, not lease-scoped).
    await prisma.transaction.deleteMany({ where: { id: after.transactionId! } });
  });
});

describe('mid-month lease start', () => {
  it('prorates the first month and clamps the due date to the lease start', async () => {
    const unitId = unitIds[3]!;
    const rent = 120_000;
    const startDate = addDays(periodStart, 19); // the 20th
    const leaseId = await makeLease(unitId, rent, startDate, addDays(startDate, 365));
    await rentService.materializeExpectedPayments(accountId, period);

    const row = await prisma.rentPayment.findUniqueOrThrow({
      where: { leaseId_period: { leaseId, period } },
    });
    expect(row.amountCents).toBe(Math.round((rent * (daysInMonth - 19)) / daysInMonth));
    expect(row.dueDate.getTime()).toBe(startDate.getTime()); // not backdated to the 1st
  });
});
