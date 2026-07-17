// WS4 — timezone-aware period math.
//   (a) Unit tests for the lib/dates tz helpers across DST boundaries and a
//       positive-offset zone whose local month starts before the UTC month.
//   (b) An integration test: the same UTC instant buckets into different
//       months for a Tokyo account vs. the default New York account, proving
//       the period math reads Account.timezone end-to-end.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  businessDaysBetweenInTz,
  calendarDaysBetweenInTz,
  currentPeriodInTz,
  dayOfMonthInTz,
  monthEndExclusiveInTz,
  monthStartInTz,
  periodOfInTz,
  startOfDayInTz,
  tzOffsetMs,
  wallClockParts,
  yearRangeInTz,
} from '../lib/dates';
import { prisma } from '../lib/prisma';
import * as reportService from '../services/report.service';

const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo';
const AUCKLAND = 'Pacific/Auckland';
const HOUR = 3_600_000;

describe('lib/dates tz helpers — New York (DST)', () => {
  it('monthStartInTz lands on local midnight, offset by the zone (EST vs EDT)', () => {
    // January is EST (UTC−5): local midnight of the 1st = 05:00 UTC.
    expect(monthStartInTz('2026-01', NY).toISOString()).toBe('2026-01-01T05:00:00.000Z');
    // July is EDT (UTC−4): local midnight of the 1st = 04:00 UTC.
    expect(monthStartInTz('2026-07', NY).toISOString()).toBe('2026-07-01T04:00:00.000Z');
  });

  it('tzOffsetMs reflects the winter/summer offset', () => {
    expect(tzOffsetMs(NY, new Date('2026-01-15T12:00:00Z'))).toBe(-5 * HOUR);
    expect(tzOffsetMs(NY, new Date('2026-07-15T12:00:00Z'))).toBe(-4 * HOUR);
  });

  it('spring-forward month (March 2026): start stays EST, end rolls to EDT', () => {
    // DST begins Sun Mar 8 2026 (02:00→03:00). Mar 1 midnight is still EST.
    expect(monthStartInTz('2026-03', NY).toISOString()).toBe('2026-03-01T05:00:00.000Z');
    // April 1 midnight is EDT (UTC−4).
    expect(monthEndExclusiveInTz('2026-03', NY).toISOString()).toBe('2026-04-01T04:00:00.000Z');
    // Local midnight of the spring-forward day itself is before the 2am jump → EST.
    expect(startOfDayInTz(new Date('2026-03-08T12:00:00Z'), NY).toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
  });

  it('fall-back day (Nov 1 2026): local midnight is still EDT', () => {
    // DST ends Sun Nov 1 2026 (02:00→01:00); Nov 1 midnight precedes the jump.
    expect(monthStartInTz('2026-11', NY).toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(startOfDayInTz(new Date('2026-11-01T12:00:00Z'), NY).toISOString()).toBe(
      '2026-11-01T04:00:00.000Z',
    );
  });

  it('calendarDaysBetweenInTz counts whole local days across both DST jumps', () => {
    // Spring-forward week has a 23-hour day; still exactly 2 calendar days.
    expect(
      calendarDaysBetweenInTz(
        new Date('2026-03-07T17:00:00Z'), // NY Mar 7 12:00
        new Date('2026-03-09T16:00:00Z'), // NY Mar 9 12:00
        NY,
      ),
    ).toBe(2);
    // Fall-back week has a 25-hour day; still exactly 2 calendar days.
    expect(
      calendarDaysBetweenInTz(
        new Date('2026-10-31T16:00:00Z'), // NY Oct 31 12:00
        new Date('2026-11-02T17:00:00Z'), // NY Nov 2 12:00
        NY,
      ),
    ).toBe(2);
  });

  it('businessDaysBetweenInTz counts only Mon–Fri in (from, to], DST-safe', () => {
    // Thu Mar 5 → Fri Mar 6: just Friday (1). → Sat Mar 7: still 1 (Sat excluded).
    // → Sun Mar 8 (the spring-forward day itself): still 1 — no DST skew.
    // → Mon Mar 9: 2 (Friday + Monday).
    const thu = new Date('2026-03-05T17:00:00Z'); // NY Mar 5 12:00 EST
    const fri = new Date('2026-03-06T17:00:00Z'); // NY Mar 6 12:00 EST
    const sat = new Date('2026-03-07T17:00:00Z'); // NY Mar 7 12:00 EST
    const sun = new Date('2026-03-08T16:00:00Z'); // NY Mar 8 12:00 EDT (post-jump)
    const mon = new Date('2026-03-09T16:00:00Z'); // NY Mar 9 12:00 EDT
    expect(businessDaysBetweenInTz(thu, fri, NY)).toBe(1);
    expect(businessDaysBetweenInTz(thu, sat, NY)).toBe(1);
    expect(businessDaysBetweenInTz(thu, sun, NY)).toBe(1);
    expect(businessDaysBetweenInTz(thu, mon, NY)).toBe(2);
  });

  it('businessDaysBetweenInTz: due Friday, 5 business days elapsed by the following Friday, 6 by the following Monday', () => {
    const dueFri = new Date('2026-07-03T16:00:00Z'); // NY Jul 3 12:00 EDT (Friday)
    const nextFri = new Date('2026-07-10T16:00:00Z'); // NY Jul 10 12:00 EDT (Friday)
    const nextMon = new Date('2026-07-13T16:00:00Z'); // NY Jul 13 12:00 EDT (Monday)
    expect(businessDaysBetweenInTz(dueFri, nextFri, NY)).toBe(5);
    expect(businessDaysBetweenInTz(dueFri, nextMon, NY)).toBe(6);
  });

  it('businessDaysBetweenInTz negates symmetrically when to < from, and is 0 for the same local day', () => {
    const fri = new Date('2026-07-03T16:00:00Z');
    const nextFri = new Date('2026-07-10T16:00:00Z');
    expect(businessDaysBetweenInTz(nextFri, fri, NY)).toBe(-5);
    expect(businessDaysBetweenInTz(fri, fri, NY)).toBe(0);
  });

  it('yearRangeInTz brackets the local calendar year (EST boundaries)', () => {
    const { from, to } = yearRangeInTz(2026, NY);
    expect(from.toISOString()).toBe('2026-01-01T05:00:00.000Z');
    expect(to.toISOString()).toBe('2027-01-01T05:00:00.000Z');
  });
});

describe('lib/dates tz helpers — positive-offset zones', () => {
  it("Auckland's local month starts before the UTC month", () => {
    // July is NZST (UTC+12): July 1 00:00 local = June 30 12:00 UTC.
    expect(monthStartInTz('2026-07', AUCKLAND).toISOString()).toBe('2026-06-30T12:00:00.000Z');
  });

  it('Tokyo month starts before the UTC month too (UTC+9)', () => {
    expect(monthStartInTz('2026-07', TOKYO).toISOString()).toBe('2026-06-30T15:00:00.000Z');
  });

  it('the same instant buckets by wall clock per zone', () => {
    const instant = new Date('2026-06-30T20:00:00Z');
    expect(periodOfInTz(instant, TOKYO)).toBe('2026-07'); // 05:00 JST, Jul 1
    expect(periodOfInTz(instant, AUCKLAND)).toBe('2026-07'); // 08:00 NZST, Jul 1
    expect(periodOfInTz(instant, NY)).toBe('2026-06'); // 16:00 EDT, Jun 30
  });

  it('dayOfMonthInTz and wallClockParts read the local day', () => {
    const instant = new Date('2026-07-01T02:00:00Z');
    expect(dayOfMonthInTz(instant, TOKYO)).toBe(1); // 11:00 JST, Jul 1
    expect(dayOfMonthInTz(instant, NY)).toBe(30); // 22:00 EDT, Jun 30
    expect(wallClockParts(TOKYO, instant)).toMatchObject({ year: 2026, month: 7, day: 1, hour: 11 });
  });

  it('currentPeriodInTz reads a supplied "now"', () => {
    expect(currentPeriodInTz(NY, new Date('2026-06-30T20:00:00Z'))).toBe('2026-06');
    expect(currentPeriodInTz(TOKYO, new Date('2026-06-30T20:00:00Z'))).toBe('2026-07');
  });
});

// ── integration: Account.timezone drives P&L month bucketing ─────────────────

describe('timezone-aware P&L bucketing (integration)', () => {
  // 2026-06-30T20:00:00Z is Jul 1 in Tokyo (UTC+9) but still Jun 30 in New York
  // (EDT, UTC−4) — the exact late-evening case the tz fix exists for.
  const INSTANT = '2026-06-30T20:00:00.000Z';
  const AMOUNT_CENTS = 424_242;
  let tokyoAccountId: string;
  let nyAccountId: string;
  const propertyIds: string[] = [];

  async function makeAccountWithTxn(email: string, timezone: string): Promise<string> {
    const account = await prisma.account.create({
      data: { name: `TZ ${timezone}`, email, timezone },
    });
    const property = await prisma.property.create({
      data: { accountId: account.id, addressLine1: '1 TZ Way', city: 'X', state: 'CA', zip: '00000' },
    });
    propertyIds.push(property.id);
    await prisma.transaction.create({
      data: {
        accountId: account.id,
        propertyId: property.id,
        date: new Date(INSTANT),
        amountCents: AMOUNT_CENTS,
        type: 'income',
        description: 'TZ boundary income',
        source: 'manual',
        status: 'confirmed',
      },
    });
    return account.id;
  }

  beforeAll(async () => {
    tokyoAccountId = await makeAccountWithTxn('tz-tokyo@tztest.example', TOKYO);
    nyAccountId = await makeAccountWithTxn('tz-ny@tztest.example', NY);
  });

  afterAll(async () => {
    const ids = [tokyoAccountId, nyAccountId];
    await prisma.report.deleteMany({ where: { accountId: { in: ids } } });
    await prisma.transaction.deleteMany({ where: { accountId: { in: ids } } });
    await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
    await prisma.auditLog.deleteMany({ where: { accountId: { in: ids } } });
    await prisma.account.deleteMany({ where: { id: { in: ids } } });
  });

  async function monthsOf(accountId: string): Promise<Map<string, number>> {
    const report = await reportService.generate(accountId, {
      type: 'net_cashflow',
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
    });
    const data = (await reportService.getById(accountId, report.id)).data as {
      months: Array<{ month: string; incomeCents: number }>;
    };
    return new Map(data.months.map((m) => [m.month, m.incomeCents]));
  }

  it('Tokyo account buckets the late-June-UTC instant into July', async () => {
    const months = await monthsOf(tokyoAccountId);
    expect(months.get('2026-07')).toBe(AMOUNT_CENTS);
    expect(months.has('2026-06')).toBe(false);
  });

  it('New York account buckets the same instant into June', async () => {
    const months = await monthsOf(nyAccountId);
    expect(months.get('2026-06')).toBe(AMOUNT_CENTS);
    expect(months.has('2026-07')).toBe(false);
  });
});
