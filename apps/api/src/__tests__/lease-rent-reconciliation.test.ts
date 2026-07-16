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
    units: [{ label: 'R1' }, { label: 'R2' }, { label: 'R3' }, { label: 'R4' }],
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
