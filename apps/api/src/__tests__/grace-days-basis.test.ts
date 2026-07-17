// FEATURE — grace-period basis (customer wants a five-BUSINESS-day grace
// period; the long-standing default is calendar-days-only). deriveRentStatus's
// grace check is basis-aware (Account.graceDaysBasis / GraceDaysBasis
// @hearth/shared): 'calendar' (default) counts every day past dueDate;
// 'business' counts only Mon–Fri elapsed. `daysLate` — the figure every
// tracker/report row displays, and what the seed pins (Okafor 6d, Park 3d) —
// always stays a pure CALENDAR count regardless of basis; only whether that
// count trips "past grace" (and therefore late-fee eligibility) changes.
//
// Own throwaway accounts + fixtures, cleaned up in afterAll — never touches
// the seeded demo account (rent.test.ts pins its exact figures, calendar
// basis + graceDays 0, unaffected by anything here).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { AccountSettingsSchema } from '@hearth/shared';
import { buildApp } from '../app';
import { addDays, startOfDayInTz } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { resetAuthServiceCache } from '../services/auth.service';
import * as leaseService from '../services/lease.service';
import * as rentService from '../services/rent.service';
import * as tenantService from '../services/tenant.service';

const TZ = 'America/New_York';
const EMAIL_DOMAIN = '@gracebasistest.example';

describe('deriveRentStatus — basis-aware grace check (pure)', () => {
  const basePayment = { status: 'due', amountCents: 100000, paidCents: 0 };

  it('calendar basis behaves exactly as before: only the elapsed calendar-day count trips grace', () => {
    // Friday due, checked the following Monday: 10 calendar days elapsed.
    const dueFri = new Date('2026-07-03T16:00:00Z'); // NY Jul 3 12:00 EDT (Friday)
    const nextMon = new Date('2026-07-13T16:00:00Z'); // NY Jul 13 12:00 EDT (Monday)
    const derived = rentService.deriveRentStatus(
      { ...basePayment, dueDate: dueFri },
      5,
      'calendar',
      TZ,
      nextMon,
    );
    expect(derived.status).toBe('late');
    expect(derived.daysLate).toBe(10);
  });

  it('business basis: due Friday, graceDays 5 business — the following Friday is still within grace, the following Monday is late', () => {
    const dueFri = new Date('2026-07-03T16:00:00Z'); // Friday
    const nextFri = new Date('2026-07-10T16:00:00Z'); // Friday — 5 business days elapsed
    const nextMon = new Date('2026-07-13T16:00:00Z'); // Monday — 6 business days elapsed

    const atNextFri = rentService.deriveRentStatus(
      { ...basePayment, dueDate: dueFri },
      5,
      'business',
      TZ,
      nextFri,
    );
    expect(atNextFri.status).toBe('due'); // 5 business days elapsed is not > 5
    expect(atNextFri.daysLate).toBeUndefined();

    const atNextMon = rentService.deriveRentStatus(
      { ...basePayment, dueDate: dueFri },
      5,
      'business',
      TZ,
      nextMon,
    );
    expect(atNextMon.status).toBe('late'); // 6 business days elapsed is > 5
    // daysLate is always a CALENDAR count, regardless of basis (pinned display semantics).
    expect(atNextMon.daysLate).toBe(10);
  });

  it('business basis, weekend-spanning: due Thursday, graceDays 1 business — Friday and the whole weekend stay in grace, Monday is late', () => {
    const dueThu = new Date('2026-03-05T17:00:00Z'); // NY Mar 5 12:00 EST (Thursday)
    const fri = new Date('2026-03-06T17:00:00Z'); // Friday — 1 business day elapsed
    const sat = new Date('2026-03-07T17:00:00Z'); // Saturday — still 1 business day elapsed
    const sun = new Date('2026-03-08T16:00:00Z'); // Sunday (also the DST spring-forward day) — still 1
    const mon = new Date('2026-03-09T16:00:00Z'); // Monday — 2 business days elapsed

    for (const today of [fri, sat, sun]) {
      const derived = rentService.deriveRentStatus(
        { ...basePayment, dueDate: dueThu },
        1,
        'business',
        TZ,
        today,
      );
      expect(derived.status).toBe('due');
      expect(derived.daysLate).toBeUndefined();
    }

    const atMon = rentService.deriveRentStatus({ ...basePayment, dueDate: dueThu }, 1, 'business', TZ, mon);
    expect(atMon.status).toBe('late');
    // Calendar days Thu→Mon = 4, unaffected by the DST jump inside the window.
    expect(atMon.daysLate).toBe(4);
  });
});

describe('applyLateFee eligibility follows the business-day basis automatically', () => {
  let accountId: string;
  let propertyId: string;
  let unitCounter = 0;

  beforeAll(async () => {
    const account = await prisma.account.create({
      data: {
        name: 'Grace Basis Co',
        email: `main${EMAIL_DOMAIN}`,
        timezone: TZ,
        graceDays: 3,
        graceDaysBasis: 'business',
        defaultLateFeeCents: 5000,
      },
    });
    accountId = account.id;
    const property = await prisma.property.create({
      data: { accountId, addressLine1: '1 Grace Basis Way', city: 'X', state: 'CA', zip: '00000' },
    });
    propertyId = property.id;
  });

  afterAll(async () => {
    await prisma.account.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  });

  /** A charge due `calendarDaysBack` calendar days ago from real "now" — used
   *  instead of literal dates because applyLateFee derives status against the
   *  real clock. Any k-day window has at most min(k,5) and at least
   *  max(0,k-2) weekdays, so calendarDaysBack === graceDays guarantees ≤
   *  graceDays business days elapsed (still in grace) and calendarDaysBack ===
   *  graceDays + 3 guarantees > graceDays business days elapsed (past grace),
   *  regardless of which real weekday the suite happens to run on. */
  async function makeCharge(calendarDaysBack: number): Promise<string> {
    const unit = await prisma.unit.create({ data: { propertyId, label: `GB${++unitCounter}` } });
    const tenant = await tenantService.create(accountId, { fullName: `GB Tenant ${unitCounter}` });
    const now = new Date();
    const lease = await leaseService.create(accountId, {
      unitId: unit.id,
      tenantIds: [tenant.id],
      rentCents: 100000,
      dueDay: 1,
      startDate: addDays(now, -400).toISOString(),
      endDate: addDays(now, 400).toISOString(),
    });
    const charge = await prisma.rentPayment.create({
      data: {
        leaseId: lease.id,
        period: '2026-01', // irrelevant — this test never re-materializes the period
        dueDate: addDays(startOfDayInTz(now, TZ), -calendarDaysBack),
        amountCents: 100000,
        status: 'due',
      },
    });
    return charge.id;
  }

  it('blocks applying a late fee while still within the business-day grace window', async () => {
    const rentPaymentId = await makeCharge(3); // === graceDays: guaranteed ≤ 3 business days elapsed
    await expect(rentService.applyLateFee(accountId, rentPaymentId, {})).rejects.toThrow(
      /past its grace period/,
    );
    expect(
      (await prisma.rentPayment.findUniqueOrThrow({ where: { id: rentPaymentId } })).lateFeeCents,
    ).toBe(0);
  });

  it('allows applying a late fee once the business-day grace window has passed', async () => {
    const rentPaymentId = await makeCharge(6); // graceDays + 3: guaranteed > 3 business days elapsed
    const updated = await rentService.applyLateFee(accountId, rentPaymentId, {});
    expect(updated.lateFeeCents).toBe(5000); // account default policy
  });
});

describe('settings PATCH round-trips graceDays + graceDaysBasis', () => {
  const TEST_SECRET = 'test-jwt-secret-with-at-least-32-characters!';
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
    resetAuthServiceCache();
    app = await buildApp();
  });

  afterAll(async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    resetAuthServiceCache();
    await prisma.account.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
    await app.close();
  });

  async function signToken(sub: string, email: string): Promise<string> {
    return new SignJWT({ email, aud: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(TEST_SECRET));
  }

  it('accepts graceDays + graceDaysBasis together and reads them back unchanged', async () => {
    const token = await signToken('grace-basis-settings-owner', `settings-owner${EMAIL_DOMAIN}`);
    // First-sight provisioning: any authenticated request auto-creates the
    // account + owner User row.
    const provisioned = await app.inject({
      method: 'GET',
      url: '/api/v1/properties',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(provisioned.statusCode).toBe(200);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/account',
      headers: { authorization: `Bearer ${token}` },
      payload: { graceDays: 5, graceDaysBasis: 'business' },
    });
    expect(patchRes.statusCode).toBe(200);
    const patched = AccountSettingsSchema.parse(patchRes.json());
    expect(patched.graceDays).toBe(5);
    expect(patched.graceDaysBasis).toBe('business');

    const getRes = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/account',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(200);
    const read = AccountSettingsSchema.parse(getRes.json());
    expect(read.graceDays).toBe(5);
    expect(read.graceDaysBasis).toBe('business');
  });
});
