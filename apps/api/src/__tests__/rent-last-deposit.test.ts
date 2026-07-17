// FEATURE — partial-payment paid date. RentPayment.paidAt is only set once a
// charge is FULLY covered (the dashboard rent-collected KPI depends on that
// meaning — unchanged here). `lastDepositAt` exposes the newest deposit's date
// regardless of coverage, so the UI has a display date for a partial payment.
// Checked across all three serializers that carry it: rent.service
// getMonthStatus (tracker rows), tenant.service.getDetail (paymentHistory),
// and unit.service.getDetail (rentPayments) — plus lease.service.getDetail,
// which reuses the same RentPaymentRowSchema.
//
// Own throwaway account + fixtures, cleaned up in afterAll — never touches the
// seeded demo account.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, iso } from '../lib/dates';
import { prisma } from '../lib/prisma';
import * as leaseService from '../services/lease.service';
import * as rentService from '../services/rent.service';
import * as tenantService from '../services/tenant.service';
import * as unitService from '../services/unit.service';

const EMAIL_DOMAIN = '@lastdeposittest.example';
const TZ = 'America/New_York';
const period = '2026-02';

let accountId: string;
let propertyId: string;

beforeAll(async () => {
  const account = await prisma.account.create({
    data: { name: 'Last Deposit Co', email: `main${EMAIL_DOMAIN}`, timezone: TZ },
  });
  accountId = account.id;
  const property = await prisma.property.create({
    data: { accountId, addressLine1: '1 Last Deposit Way', city: 'X', state: 'CA', zip: '00000' },
  });
  propertyId = property.id;
});

afterAll(async () => {
  await prisma.account.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
});

let unitCounter = 0;

async function makeLease(rentCents = 100000): Promise<{ leaseId: string; tenantId: string }> {
  const unit = await prisma.unit.create({ data: { propertyId, label: `LD${++unitCounter}` } });
  const tenant = await tenantService.create(accountId, { fullName: `LD Tenant ${unitCounter}` });
  const now = new Date();
  const lease = await leaseService.create(accountId, {
    unitId: unit.id,
    tenantIds: [tenant.id],
    rentCents,
    dueDay: 1,
    startDate: iso(addDays(now, -400)),
    endDate: iso(addDays(now, 400)),
  });
  return { leaseId: lease.id, tenantId: tenant.id };
}

describe('lastDepositAt across the rent-payment serializers', () => {
  it('a never-paid charge has both paidAt and lastDepositAt null', async () => {
    const { leaseId } = await makeLease();
    const tracker = await rentService.getMonthStatus(accountId, period);
    const row = tracker.rows.find((r) => r.leaseId === leaseId)!;
    expect(row.paidAt).toBeNull();
    expect(row.lastDepositAt).toBeNull();
  });

  it('a partial charge exposes lastDepositAt (= its deposit’s paidAt) while paidAt stays null', async () => {
    const { leaseId, tenantId } = await makeLease(100000);
    const depositPaidAt = iso(addDays(new Date(), -5));
    await rentService.recordPayment(accountId, {
      leaseId,
      period,
      amountCents: 40000, // < 100000 — leaves the charge open
      method: 'manual',
      paidAt: depositPaidAt,
      tenantId,
    });

    const tracker = await rentService.getMonthStatus(accountId, period);
    const row = tracker.rows.find((r) => r.leaseId === leaseId)!;
    expect(row.status).not.toBe('paid');
    expect(row.paidCents).toBe(40000);
    expect(row.paidAt).toBeNull(); // not fully covered — the collected-KPI meaning is unchanged
    expect(row.lastDepositAt).toBe(depositPaidAt);

    // Same fixture through tenant.service.getDetail (paymentHistory).
    const tenantDetail = await tenantService.getDetail(accountId, tenantId);
    const historyRow = tenantDetail.paymentHistory.find((p) => p.period === period)!;
    expect(historyRow.paidAt).toBeNull();
    expect(historyRow.lastDepositAt).toBe(depositPaidAt);

    // And through unit.service.getDetail (rentPayments).
    const lease = await prisma.lease.findUniqueOrThrow({ where: { id: leaseId } });
    const unitDetail = await unitService.getDetail(accountId, lease.unitId);
    const unitRow = unitDetail.rentPayments.find((p) => p.period === period)!;
    expect(unitRow.paidAt).toBeNull();
    expect(unitRow.lastDepositAt).toBe(depositPaidAt);

    // And through lease.service.getDetail (rentPayments) — same shared schema.
    const leaseDetail = await leaseService.getDetail(accountId, leaseId);
    const leaseRow = leaseDetail.rentPayments.find((p) => p.period === period)!;
    expect(leaseRow.paidAt).toBeNull();
    expect(leaseRow.lastDepositAt).toBe(depositPaidAt);
  });

  it('a fully paid charge exposes both, lastDepositAt reflecting the newest deposit', async () => {
    const { leaseId, tenantId } = await makeLease(100000);
    const firstPaidAt = iso(addDays(new Date(), -10));
    const secondPaidAt = iso(addDays(new Date(), -1));

    await rentService.recordPayment(accountId, {
      leaseId,
      period,
      amountCents: 40000,
      method: 'manual',
      paidAt: firstPaidAt,
      tenantId,
    });
    const completed = await rentService.recordPayment(accountId, {
      leaseId,
      period,
      amountCents: 60000, // completes the 100000 charge
      method: 'manual',
      paidAt: secondPaidAt,
      tenantId,
    });
    expect(completed.status).toBe('paid');
    expect(completed.paidAt).toBe(secondPaidAt);

    const tracker = await rentService.getMonthStatus(accountId, period);
    const row = tracker.rows.find((r) => r.leaseId === leaseId)!;
    expect(row.status).toBe('paid');
    expect(row.paidAt).toBe(secondPaidAt);
    expect(row.lastDepositAt).toBe(secondPaidAt); // the newest of the two deposits

    const tenantDetail = await tenantService.getDetail(accountId, tenantId);
    const historyRow = tenantDetail.paymentHistory.find((p) => p.period === period)!;
    expect(historyRow.paidAt).toBe(secondPaidAt);
    expect(historyRow.lastDepositAt).toBe(secondPaidAt);
  });
});
