// Lease dates are calendar days on the landlord's wall calendar, so every
// lease write normalizes them to local midnight in the account's timezone.
// Without that, a client sending UTC midnight ("2026-08-01T00:00:00Z") stores
// an instant that startOfDayInTz resolves to the *previous* local day in New
// York — which is how a $3,300 → $3,450 switchover on Aug 1 blended July into
// a two-lease month and left the charge permanently short. Every row this file
// creates is removed again.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDays,
  currentPeriodInTz,
  dayOfMonthInTz,
  iso,
  localMidnightUtc,
  monthEndExclusiveInTz,
  monthStartInTz,
  periodOfInTz,
  startOfDayInTz,
} from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import { DEMO_TIMEZONE } from '../../prisma/seed-constants';
import * as leaseService from '../services/lease.service';
import * as propertyService from '../services/property.service';
import * as rentService from '../services/rent.service';
import * as tenantService from '../services/tenant.service';

const DAY_MS = 86_400_000;

// The demo account is America/New_York — EDT (UTC−4) in summer, EST (UTC−5)
// in winter — so the expected UTC instants below are written for that zone.
const TZ = DEMO_TIMEZONE;

let accountId: string;
let propertyId: string;
let unitIds: string[] = [];
const tenantIds: string[] = [];
const leaseIds: string[] = [];

const period = currentPeriodInTz(TZ);
const periodStart = monthStartInTz(period, TZ);
const daysInMonth = Math.round(
  (monthEndExclusiveInTz(period, TZ).getTime() - periodStart.getTime()) / DAY_MS,
);

async function makeLease(
  unitId: string,
  rentCents: number,
  startDate: string,
  endDate: string,
): Promise<string> {
  const tenant = await tenantService.create(accountId, {
    fullName: `Lease Date Tenant ${tenantIds.length + 1}`,
  });
  tenantIds.push(tenant.id);
  const lease = await leaseService.create(accountId, {
    unitId,
    tenantIds: [tenant.id],
    rentCents,
    dueDay: 1,
    startDate,
    endDate,
  });
  leaseIds.push(lease.id);
  return lease.id;
}

beforeAll(async () => {
  accountId = await getDemoAccountId();
  const property = await propertyService.create(accountId, {
    addressLine1: 'LEASEDATE 12 Test Way',
    city: 'X',
    state: 'CA',
    zip: '00000',
    units: [
      { label: 'D1' },
      { label: 'D2' },
      { label: 'D3' },
      { label: 'D4' },
      { label: 'D5' },
      { label: 'D6' },
    ],
  });
  propertyId = property.id;
  unitIds = (
    await prisma.unit.findMany({ where: { propertyId }, orderBy: { label: 'asc' } })
  ).map((u) => u.id);
});

afterAll(async () => {
  const charges = await prisma.rentPayment.findMany({
    where: { leaseId: { in: leaseIds } },
    select: { id: true },
  });
  await prisma.rentPayment.deleteMany({ where: { leaseId: { in: leaseIds } } });
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.unit.deleteMany({ where: { propertyId } });
  await prisma.insight.deleteMany({ where: { accountId, propertyId } });
  await prisma.property.delete({ where: { id: propertyId } });
  await prisma.auditLog.deleteMany({
    where: {
      accountId,
      entityId: {
        in: [propertyId, ...leaseIds, ...tenantIds, ...charges.map((c) => c.id)],
      },
    },
  });
});

describe('lease dates normalize to the account timezone', () => {
  it('stores a UTC-midnight date on the local day the client named, not the day before', async () => {
    const leaseId = await makeLease(
      unitIds[0]!,
      330_000,
      '2026-08-01T00:00:00Z',
      '2027-07-31T00:00:00Z',
    );
    const row = await prisma.lease.findUniqueOrThrow({ where: { id: leaseId } });

    // August is EDT, so local midnight of the 1st is 04:00 UTC.
    expect(row.startDate.toISOString()).toBe('2026-08-01T04:00:00.000Z');
    expect(row.endDate.toISOString()).toBe('2027-07-31T04:00:00.000Z');
    // Both are exactly local midnight — normalizing them again is a no-op.
    expect(startOfDayInTz(row.startDate, TZ).getTime()).toBe(row.startDate.getTime());
    expect(startOfDayInTz(row.endDate, TZ).getTime()).toBe(row.endDate.getTime());
    // …and they resolve to the days the client named, not Jul 31 / Jul 30.
    expect(periodOfInTz(row.startDate, TZ)).toBe('2026-08');
    expect(dayOfMonthInTz(row.startDate, TZ)).toBe(1);
    expect(dayOfMonthInTz(row.endDate, TZ)).toBe(31);

    // endDate keeps its inclusive-last-day meaning (expectedChargeCents adds a
    // day to it): the first and last months are whole months, not 30/31ths.
    expect(rentService.expectedChargeCents(row, '2026-08', TZ)).toBe(330_000);
    expect(rentService.expectedChargeCents(row, '2027-07', TZ)).toBe(330_000);
    // The month after the lease ends is not billed at all.
    expect(rentService.expectedChargeCents(row, '2027-08', TZ)).toBe(0);
  });

  it('reads a date-only string as the same calendar day as the equivalent timestamp', async () => {
    const dateOnly = await makeLease(unitIds[1]!, 100_000, '2026-09-01', '2027-08-31');
    const timestamp = await makeLease(
      unitIds[2]!,
      100_000,
      '2026-09-01T00:00:00Z',
      '2027-08-31T00:00:00Z',
    );
    const a = await prisma.lease.findUniqueOrThrow({ where: { id: dateOnly } });
    const b = await prisma.lease.findUniqueOrThrow({ where: { id: timestamp } });

    expect(a.startDate.toISOString()).toBe('2026-09-01T04:00:00.000Z');
    expect(a.startDate.getTime()).toBe(b.startDate.getTime());
    expect(a.endDate.getTime()).toBe(b.endDate.getTime());
  });

  it('uses the offset in force on each date — EST in winter, EDT in summer', async () => {
    const winter = await makeLease(
      unitIds[3]!,
      100_000,
      '2026-01-15T00:00:00Z',
      '2026-07-15T00:00:00Z',
    );
    const row = await prisma.lease.findUniqueOrThrow({ where: { id: winter } });
    // Jan 15 is EST (UTC−5); Jul 15 is EDT (UTC−4). A fixed offset would put
    // one of the two an hour off local midnight, and so on the wrong local day.
    expect(row.startDate.toISOString()).toBe('2026-01-15T05:00:00.000Z');
    expect(row.endDate.toISOString()).toBe('2026-07-15T04:00:00.000Z');
    expect(dayOfMonthInTz(row.startDate, TZ)).toBe(15);
    expect(dayOfMonthInTz(row.endDate, TZ)).toBe(15);
  });
});

describe('the Aug 1 switchover that mis-prorated July (production repro)', () => {
  it('charges July at exactly the outgoing rent instead of blending the successor in', async () => {
    const unitId = unitIds[4]!;
    const oldRent = 330_000; // $3,300
    const newRent = 345_000; // $3,450

    // Both leases are entered the way the production client sent them: UTC
    // midnight for the calendar day the landlord picked.
    const outgoing = await makeLease(unitId, oldRent, '2025-08-01T00:00:00Z', '2026-07-31T00:00:00Z');
    // July's charge, already materialized under the outgoing lease at the
    // stale blended figure the incident left behind.
    const charge = await prisma.rentPayment.create({
      data: {
        leaseId: outgoing,
        period: '2026-07',
        dueDate: monthStartInTz('2026-07', TZ),
        amountCents: 330_484,
        status: 'due',
      },
    });

    await makeLease(unitId, newRent, '2026-08-01T00:00:00Z', '2027-07-31T00:00:00Z');

    const after = await prisma.rentPayment.findUniqueOrThrow({ where: { id: charge.id } });
    expect(after.amountCents).toBe(330_000);
    expect(after.amountCents - after.paidCents).toBe(330_000); // no stranded remainder

    // July is a one-lease month: the successor starts Aug 1 local and covers
    // none of it.
    const stored = await prisma.lease.findMany({
      where: { unitId },
      select: { id: true, rentCents: true, startDate: true, endDate: true },
    });
    const covering = rentService.coveringLeases(stored, '2026-07', TZ);
    expect(covering).toHaveLength(1);
    expect(covering[0]!.lease.id).toBe(outgoing);
    expect(rentService.blendedChargeCents(covering, '2026-07', TZ)).toBe(330_000);

    // The formulas were never wrong — the *inputs* were. Fed the raw UTC
    // midnights these leases used to be stored as, the identical derivation
    // reproduces the incident: outgoing shifted to Jul 30, successor to Jul 31,
    // so July reads as 30 days + 1 day.
    const shifted = [
      {
        id: 'outgoing',
        rentCents: oldRent,
        startDate: new Date('2025-08-01T00:00:00Z'),
        endDate: new Date('2026-07-31T00:00:00Z'),
      },
      {
        id: 'successor',
        rentCents: newRent,
        startDate: new Date('2026-08-01T00:00:00Z'),
        endDate: new Date('2027-07-31T00:00:00Z'),
      },
    ];
    const shiftedCovering = rentService.coveringLeases(shifted, '2026-07', TZ);
    expect(shiftedCovering).toHaveLength(2);
    expect(rentService.blendedChargeCents(shiftedCovering, '2026-07', TZ)).toBe(330_484);

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'rent_payment.adjusted', entityId: charge.id },
    });
    expect(JSON.parse(audit!.detailJson!)).toMatchObject({
      priorAmountCents: 330_484,
      amountCents: 330_000,
      reason: 'lease_created',
    });
  });
});

describe('editing a lease date', () => {
  it('normalizes the new date and re-prorates the charge it already billed', async () => {
    const unitId = unitIds[5]!;
    const rent = 120_000;
    const leaseId = await makeLease(
      unitId,
      rent,
      iso(addDays(periodStart, -365)),
      iso(addDays(periodStart, 180)),
    );
    await rentService.materializeExpectedPayments(accountId, period);
    const before = await prisma.rentPayment.findUniqueOrThrow({
      where: { leaseId_period: { leaseId, period } },
    });
    expect(before.amountCents).toBe(rent); // whole month

    // Correct the start to the 10th of this month, sent as UTC midnight the way
    // the web client serializes a date picker.
    await leaseService.update(accountId, leaseId, { startDate: `${period}-10T00:00:00Z` });

    const row = await prisma.lease.findUniqueOrThrow({ where: { id: leaseId } });
    const [pYear, pMonth] = period.split('-').map(Number);
    expect(row.startDate.getTime()).toBe(localMidnightUtc(pYear!, pMonth!, 10, TZ).getTime());
    expect(dayOfMonthInTz(row.startDate, TZ)).toBe(10);

    // …and the open charge follows in the same transaction (parent branch's
    // reconcile-on-update): days 10..end, not the 9th an unshifted date would
    // have billed from.
    const after = await prisma.rentPayment.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.amountCents).toBe(Math.round((rent * (daysInMonth - 9)) / daysInMonth));

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'rent_payment.adjusted', entityId: before.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(JSON.parse(audit!.detailJson!)).toMatchObject({
      priorAmountCents: rent,
      amountCents: after.amountCents,
      reason: 'lease_updated',
    });
  });
});
