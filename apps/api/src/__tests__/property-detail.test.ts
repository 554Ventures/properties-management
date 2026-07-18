// Property detail per-unit enrichment: this month's rent snapshot (derived
// read-only, synthesized in memory when no charge row exists), leaseCount,
// and pendingLease.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PropertyDetailResponseSchema } from '@hearth/shared';
import {
  BIRCH_ADDRESS,
  DEMO_TIMEZONE,
  OKAFOR_DAYS_LATE,
  OKAFOR_NAME,
  OKAFOR_RENT_CENTS,
  PARK_DAYS_LATE,
  PARK_NAME,
  PARK_RENT_CENTS,
} from '../../prisma/seed-constants';
import { buildApp } from '../app';
import {
  addDays,
  calendarDaysBetweenInTz,
  currentPeriodInTz,
  iso,
  monthStartInTz,
  startOfDayInTz,
} from '../lib/dates';

// The demo account is in DEMO_TIMEZONE; the synthesized charge's dueDate/late
// derive on that local calendar now (WS4), so the expectation must too.
const TZ = DEMO_TIMEZONE;
import { prisma } from '../lib/prisma';
import * as leaseService from '../services/lease.service';
import * as propertyService from '../services/property.service';
import * as rentService from '../services/rent.service';
import * as unitService from '../services/unit.service';

const FIXTURE_EMAIL = 'property-detail-fixture@example.test';
const FIXTURE_RENT_CENTS = 123400;

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  // Cascade wipes the fixture property/leases/payments/insights with it.
  await prisma.account.deleteMany({ where: { email: FIXTURE_EMAIL } });
  await app.close();
});

async function getDetailViaRoute(propertyId: string) {
  const res = await app.inject({ method: 'GET', url: `/api/v1/properties/${propertyId}` });
  expect(res.statusCode).toBe(200);
  return PropertyDetailResponseSchema.parse(res.json());
}

describe('GET /properties/:id — per-unit rent snapshot from seed charge rows', () => {
  it("derives Park's unit late with exact daysLate; the co-unit stays paid", async () => {
    const birch = await prisma.property.findFirstOrThrow({
      where: { addressLine1: BIRCH_ADDRESS },
    });
    const detail = await getDetailViaRoute(birch.id);
    const period = currentPeriodInTz(TZ);

    const parkUnit = detail.units.find((u) =>
      u.currentLease?.tenants.some((t) => t.fullName === PARK_NAME),
    );
    expect(parkUnit).toBeDefined();
    expect(parkUnit?.rent).toMatchObject({
      period,
      status: 'late',
      daysLate: PARK_DAYS_LATE,
      amountCents: PARK_RENT_CENTS,
      paidCents: 0,
    });

    const paidUnit = detail.units.find((u) => u.id !== parkUnit?.id);
    expect(paidUnit?.rent?.status).toBe('paid');
    expect(paidUnit?.rent?.daysLate).toBeNull();

    // Every leased seed unit has at least its current lease in history, and
    // nothing in the seed leaves a lease awaiting signature.
    for (const u of detail.units) {
      expect(u.leaseCount).toBeGreaterThanOrEqual(1);
      expect(u.pendingLease).toBeNull();
    }
  });

  it("derives Okafor's unit late with exact daysLate", async () => {
    const lease = await prisma.lease.findFirstOrThrow({
      where: { status: 'active', leaseTenants: { some: { tenant: { fullName: OKAFOR_NAME } } } },
      include: { unit: true },
    });
    const detail = await getDetailViaRoute(lease.unit.propertyId);
    const unit = detail.units.find((u) => u.id === lease.unitId);
    expect(unit?.rent?.status).toBe('late');
    expect(unit?.rent?.daysLate).toBe(OKAFOR_DAYS_LATE);
    expect(unit?.rent?.amountCents).toBe(OKAFOR_RENT_CENTS);
    expect(unit?.leaseCount).toBeGreaterThanOrEqual(1);
  });
});

describe('propertyService.getDetail — synthesized charge + pendingLease (fixture account)', () => {
  let accountId: string;
  let propertyId: string;
  let unitId: string;
  let tenantId: string;
  let leaseId: string;

  beforeAll(async () => {
    const account = await prisma.account.create({
      data: { name: 'Property Detail Fixture', email: FIXTURE_EMAIL, graceDays: 0 },
    });
    accountId = account.id;
    const property = await prisma.property.create({
      data: {
        accountId,
        addressLine1: '1 Fixture Way',
        city: 'Springfield',
        state: 'IL',
        zip: '62700',
        units: { create: { label: 'Main' } },
      },
      include: { units: true },
    });
    propertyId = property.id;
    unitId = property.units[0]!.id;
    const tenant = await prisma.tenant.create({
      data: { accountId, fullName: 'F. Ixture' },
    });
    tenantId = tenant.id;
    // Covers the whole current month (started well before, ends well after),
    // so the expected charge is the full rent. No RentPayment row is created.
    const lease = await prisma.lease.create({
      data: {
        unitId,
        rentCents: FIXTURE_RENT_CENTS,
        dueDay: 1,
        startDate: addDays(monthStartInTz(currentPeriodInTz(TZ), TZ), -90),
        endDate: addDays(startOfDayInTz(new Date(), TZ), 300),
        status: 'active',
        leaseTenants: { create: { tenantId: tenant.id, isPrimary: true } },
      },
    });
    leaseId = lease.id;
  });

  it('synthesizes a non-null rent for a unit with no charge row this period', async () => {
    const period = currentPeriodInTz(TZ);
    expect(await prisma.rentPayment.count({ where: { leaseId } })).toBe(0);

    const detail = await propertyService.getDetail(accountId, propertyId);
    const unit = detail.units[0]!;

    // dueDay 1 → due on the 1st; graceDays 0 → late once past it (per dates,
    // not a pinned figure — the fixture must derive correctly any day of the
    // month). Bucketed on the account tz (WS4).
    const dueDate = monthStartInTz(period, TZ);
    const daysPast = calendarDaysBetweenInTz(dueDate, new Date(), TZ);
    expect(unit.rent).toEqual({
      period,
      status: daysPast > 0 ? 'late' : 'due',
      daysLate: daysPast > 0 ? daysPast : null,
      paidCents: 0,
      amountCents: FIXTURE_RENT_CENTS,
      dueDate: iso(dueDate),
    });
    expect(unit.leaseCount).toBe(1);
    expect(unit.status).toBe('occupied');

    // getDetail's pre-existing insight refresh materializes the expected
    // charge (after the snapshot above was derived from the row-less read).
    // The persisted row must agree exactly with the in-memory synthesis.
    const row = await prisma.rentPayment.findUnique({
      where: { leaseId_period: { leaseId, period } },
    });
    expect(row?.amountCents).toBe(FIXTURE_RENT_CENTS);
    expect(row ? iso(row.dueDate) : null).toBe(iso(dueDate));
    expect(row?.paidCents).toBe(0);
  });

  it('the rent derivation itself persists nothing (rentPayment count unchanged)', async () => {
    // An archived unit is outside every materialization path (rent tracker,
    // insight refresh), so a charge-less active lease on one isolates the
    // getDetail derivation: the snapshot must synthesize AND write no row.
    const property = await prisma.property.create({
      data: {
        accountId,
        addressLine1: '2 Fixture Way',
        city: 'Springfield',
        state: 'IL',
        zip: '62700',
        units: { create: { label: 'A', archivedAt: new Date() } },
      },
      include: { units: true },
    });
    await prisma.lease.create({
      data: {
        unitId: property.units[0]!.id,
        rentCents: 99900,
        dueDay: 1,
        startDate: addDays(monthStartInTz(currentPeriodInTz(TZ), TZ), -60),
        endDate: addDays(startOfDayInTz(new Date(), TZ), 300),
        status: 'active',
        leaseTenants: { create: { tenantId, isPrimary: true } },
      },
    });

    const before = await prisma.rentPayment.count();
    const detail = await propertyService.getDetail(accountId, property.id);
    expect(await prisma.rentPayment.count()).toBe(before);

    const unit = detail.units[0]!;
    expect(unit.rent).not.toBeNull();
    expect(unit.rent?.amountCents).toBe(99900);
    expect(unit.rent?.paidCents).toBe(0);
    expect(['due', 'late']).toContain(unit.rent?.status);
  });

  it('surfaces a pending_signature lease as pendingLease alongside the active one', async () => {
    // No current flow creates pending_signature automatically (lease.create
    // and createRenewal both write 'active'); it arrives via PATCH /leases/:id
    // today — created directly here.
    const today = startOfDayInTz(new Date(), TZ);
    const pending = await prisma.lease.create({
      data: {
        unitId,
        rentCents: 130000,
        dueDay: 1,
        startDate: addDays(today, 301),
        endDate: addDays(today, 666),
        status: 'pending_signature',
        leaseTenants: { create: { tenantId, isPrimary: true } },
      },
    });

    const detail = await propertyService.getDetail(accountId, propertyId);
    const unit = detail.units[0]!;
    expect(unit.pendingLease?.id).toBe(pending.id);
    expect(unit.pendingLease?.status).toBe('pending_signature');
    expect(unit.pendingLease?.tenants[0]?.fullName).toBe('F. Ixture');
    // The active lease stays the current one; history now counts both.
    expect(unit.currentLease?.id).toBe(leaseId);
    expect(unit.leaseCount).toBe(2);

    // unitService.getDetail's embedded `unit` must agree field-for-field with
    // the property surface's corresponding units[] entry — including the
    // non-null pendingLease this fixture specifically exercises (the seed has
    // no pending_signature lease, so routes.test.ts only ever asserts null).
    const unitDetail = await unitService.getDetail(accountId, unitId);
    expect(unitDetail.unit.pendingLease?.id).toBe(pending.id);
    expect(unitDetail.unit.status).toBe(unit.status);
    expect(unitDetail.unit.currentLease?.id).toBe(unit.currentLease?.id);
    expect(unitDetail.unit.leaseCount).toBe(unit.leaseCount);
    expect(unitDetail.unit.rent).toEqual(unit.rent);
  });
});

describe('unitService.getDetail agrees with propertyService.getDetail — additional per-unit rent states (isolated fixture account)', () => {
  // A dedicated account (rather than reusing FIXTURE_EMAIL above) so
  // graceDays can be pinned large enough that "how many days past due" never
  // tips into 'late' — the synthesized-charge fixture below needs a status
  // that doesn't depend on which day of the month the suite happens to run.
  const EXTRA_FIXTURE_EMAIL = 'property-detail-fixture-extra@example.test';
  let accountId: string;
  let tenantId: string;

  beforeAll(async () => {
    const account = await prisma.account.create({
      data: { name: 'Property Detail Extra Fixture', email: EXTRA_FIXTURE_EMAIL, graceDays: 400 },
    });
    accountId = account.id;
    const tenant = await prisma.tenant.create({ data: { accountId, fullName: 'E. Xtra' } });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    // Cascade wipes the fixture's properties/leases/payments/insights with it.
    await prisma.account.deleteMany({ where: { email: EXTRA_FIXTURE_EMAIL } });
  });

  it('synthesized-charge branch: unitService and propertyService agree, and the snapshot derives due (no charge row exists yet)', async () => {
    const property = await prisma.property.create({
      data: {
        accountId,
        addressLine1: '3 Fixture Way',
        city: 'Springfield',
        state: 'IL',
        zip: '62700',
        units: { create: { label: 'Main' } },
      },
      include: { units: true },
    });
    const unitId = property.units[0]!.id;
    await prisma.lease.create({
      data: {
        unitId,
        rentCents: 150000,
        dueDay: 1,
        startDate: addDays(monthStartInTz(currentPeriodInTz(TZ), TZ), -30),
        endDate: addDays(startOfDayInTz(new Date(), TZ), 300),
        status: 'active',
        leaseTenants: { create: { tenantId, isPrimary: true } },
      },
    });
    expect(await prisma.rentPayment.count({ where: { lease: { unitId } } })).toBe(0);

    // Read unitService first, while no RentPayment row exists anywhere — this
    // exercises the true in-memory synthesis branch, not a row materialized
    // as a side effect of a prior propertyService call (its insight refresh
    // can materialize expected charges — see the fixture above).
    const unitDetail = await unitService.getDetail(accountId, unitId);
    expect(unitDetail.unit.rent?.status).toBe('due');
    expect(unitDetail.unit.rent?.paidCents).toBe(0);

    const propertyDetail = await propertyService.getDetail(accountId, property.id);
    const propertyUnit = propertyDetail.units[0]!;

    expect(unitDetail.unit.rent).toEqual(propertyUnit.rent);
    expect(unitDetail.unit.status).toBe(propertyUnit.status);
    expect(unitDetail.unit.currentLease?.id).toBe(propertyUnit.currentLease?.id);
    expect(unitDetail.unit.leaseCount).toBe(propertyUnit.leaseCount);
    expect(unitDetail.unit.pendingLease).toBeNull();
    expect(propertyUnit.pendingLease).toBeNull();
  });

  it('renewal-switchover branch: the current-month charge stays on the outgoing (ended) lease, not re-synthesized for the new one', async () => {
    const property = await prisma.property.create({
      data: {
        accountId,
        addressLine1: '4 Fixture Way',
        city: 'Springfield',
        state: 'IL',
        zip: '62700',
        units: { create: { label: 'Main' } },
      },
      include: { units: true },
    });
    const unitId = property.units[0]!.id;
    const period = currentPeriodInTz(TZ);
    const periodStart = monthStartInTz(period, TZ);
    const oldRent = 100000;
    const newRent = 110000;

    const oldLease = await prisma.lease.create({
      data: {
        unitId,
        rentCents: oldRent,
        dueDay: 1,
        startDate: addDays(periodStart, -365),
        endDate: addDays(periodStart, 180),
        status: 'active',
        leaseTenants: { create: { tenantId, isPrimary: true } },
      },
    });
    await rentService.materializeExpectedPayments(accountId, period);

    // Renew mid-month: the old lease covers days 1–14, the new one the rest —
    // the switchover reconciliation (lease.service) blends the switchover
    // month's charge onto the row already materialized above (still owned by
    // the now-ended old lease) instead of creating a second one for the new
    // lease.
    const switchDate = addDays(periodStart, 14);
    const newLease = await leaseService.createRenewal(accountId, oldLease.id, {
      rentCents: newRent,
      dueDay: 1,
      startDate: iso(switchDate),
      endDate: iso(addDays(switchDate, 365)),
    });

    const rows = await prisma.rentPayment.findMany({ where: { period, lease: { unitId } } });
    expect(rows).toHaveLength(1); // one charge for the unit-month, not one per lease
    const chargeRow = rows[0]!;
    expect(chargeRow.leaseId).toBe(oldLease.id); // stayed on the outgoing lease

    const propertyDetail = await propertyService.getDetail(accountId, property.id);
    const propertyUnit = propertyDetail.units[0]!;
    const unitDetail = await unitService.getDetail(accountId, unitId);

    expect(unitDetail.unit.rent).toEqual(propertyUnit.rent);
    expect(unitDetail.unit.status).toBe('occupied');
    expect(unitDetail.unit.status).toBe(propertyUnit.status);
    expect(unitDetail.unit.currentLease?.id).toBe(newLease.id); // the active successor
    expect(unitDetail.unit.currentLease?.id).toBe(propertyUnit.currentLease?.id);
    expect(unitDetail.unit.leaseCount).toBe(2);
    expect(unitDetail.unit.leaseCount).toBe(propertyUnit.leaseCount);
    expect(unitDetail.unit.pendingLease).toBeNull();

    // The snapshot reflects the real persisted charge row on the outgoing
    // lease — not a synthesized duplicate for the new active lease.
    expect(unitDetail.unit.rent?.amountCents).toBe(chargeRow.amountCents);
    expect(unitDetail.unit.rent?.paidCents).toBe(chargeRow.paidCents);
    expect(unitDetail.unit.rent?.dueDate).toBe(iso(chargeRow.dueDate));
  });
});
