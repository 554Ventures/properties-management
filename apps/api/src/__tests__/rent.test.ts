// (b) Rent tracker derivations; (h) reminders set remindedAt + AuditLog.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SendRemindersResponseSchema } from '@hearth/shared';
import {
  COLLECTED_MTD_CENTS,
  OKAFOR_DAYS_LATE,
  OKAFOR_NAME,
  OUTSTANDING_MTD_CENTS,
  PAID_UNITS,
  PARK_DAYS_LATE,
  PARK_NAME,
  TOTAL_UNITS,
} from '../../prisma/seed-constants';
import { buildApp } from '../app';
import { currentPeriod } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import * as rentService from '../services/rent.service';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

describe('rentService.getMonthStatus (seed derivations)', () => {
  it('derives late statuses and cents totals exactly', async () => {
    const accountId = await getDemoAccountId();
    const tracker = await rentService.getMonthStatus(accountId, currentPeriod());

    expect(tracker.paidUnits).toBe(PAID_UNITS);
    expect(tracker.totalUnits).toBe(TOTAL_UNITS);
    expect(tracker.collectedCents).toBe(COLLECTED_MTD_CENTS);
    expect(tracker.outstandingCents).toBe(OUTSTANDING_MTD_CENTS);

    const okafor = tracker.rows.find((r) => r.tenantName === OKAFOR_NAME);
    expect(okafor?.status).toBe('late');
    expect(okafor?.daysLate).toBe(OKAFOR_DAYS_LATE);

    const park = tracker.rows.find((r) => r.tenantName === PARK_NAME);
    expect(park?.status).toBe('late');
    expect(park?.daysLate).toBe(PARK_DAYS_LATE);

    // Paid rows carry method + paidAt and no daysLate.
    const paid = tracker.rows.filter((r) => r.status === 'paid');
    expect(paid).toHaveLength(PAID_UNITS);
    for (const row of paid) {
      expect(row.paidAt).not.toBeNull();
      expect(row.method).not.toBeNull();
      expect(row.daysLate).toBeUndefined();
    }
  });
});

describe('POST /rent/reminders', () => {
  it('sends to a late payment, sets remindedAt and writes an AuditLog row', async () => {
    const accountId = await getDemoAccountId();
    const tracker = await rentService.getMonthStatus(accountId, currentPeriod());
    const okafor = tracker.rows.find((r) => r.tenantName === OKAFOR_NAME);
    const paidRow = tracker.rows.find((r) => r.status === 'paid');
    expect(okafor).toBeDefined();
    expect(paidRow).toBeDefined();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/rent/reminders',
      payload: { rentPaymentIds: [okafor!.rentPaymentId, paidRow!.rentPaymentId] },
    });
    expect(res.statusCode).toBe(200);
    const body = SendRemindersResponseSchema.parse(res.json());
    expect(body.results).toEqual([
      {
        rentPaymentId: okafor!.rentPaymentId,
        status: 'sent',
        mailto: expect.stringMatching(/^mailto:/),
      },
      { rentPaymentId: paidRow!.rentPaymentId, status: 'skipped', reason: 'already_paid' },
    ]);

    const updated = await prisma.rentPayment.findUnique({
      where: { id: okafor!.rentPaymentId },
    });
    expect(updated?.remindedAt).not.toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'rent.reminder_sent', entityId: okafor!.rentPaymentId },
    });
    expect(audit).not.toBeNull();
  });
});

describe('rentService.recordPayment double-pay guard', () => {
  it('records once, creates exactly one ledger transaction and rejects a repeat', async () => {
    const accountId = await getDemoAccountId();
    const period = currentPeriod();
    const tracker = await rentService.getMonthStatus(accountId, period);
    const park = tracker.rows.find((r) => r.tenantName === PARK_NAME)!;

    const paid = await rentService.recordPayment(accountId, {
      leaseId: park.leaseId,
      period,
      amountCents: park.amountCents,
      method: 'manual',
    });
    expect(paid.status).toBe('paid');
    expect(paid.transactionId).not.toBeNull();

    await expect(
      rentService.recordPayment(accountId, {
        leaseId: park.leaseId,
        period,
        amountCents: park.amountCents,
        method: 'manual',
      }),
    ).rejects.toThrow(/already recorded as paid/);

    // Exactly one ledger transaction came out of the two attempts.
    const ledger = await prisma.transaction.findMany({
      where: { accountId, description: `Rent payment — ${PARK_NAME} — ${period}` },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.id).toBe(paid.transactionId);

    // Restore the seeded state (Park stays late for other test files).
    await prisma.rentPayment.update({
      where: { id: paid.id },
      data: {
        status: 'due',
        method: null,
        paidAt: null,
        externalRef: null,
        transactionId: null,
        amountCents: park.amountCents,
      },
    });
    await prisma.transaction.delete({ where: { id: paid.transactionId! } });
    await prisma.auditLog.deleteMany({
      where: {
        accountId,
        action: { in: ['transaction.created', 'rent_payment.recorded'] },
        entityId: { in: [paid.id, paid.transactionId!] },
      },
    });
  });
});

describe('rentService.recordPayment amount guard', () => {
  it('rejects a partial payment and leaves the charge and ledger untouched', async () => {
    const accountId = await getDemoAccountId();
    const period = currentPeriod();
    const tracker = await rentService.getMonthStatus(accountId, period);
    const park = tracker.rows.find((r) => r.tenantName === PARK_NAME)!;

    await expect(
      rentService.recordPayment(accountId, {
        leaseId: park.leaseId,
        period,
        amountCents: park.amountCents - 5000,
        method: 'manual',
      }),
    ).rejects.toThrow(/doesn't match/);

    // The row still carries the full expected charge, unpaid, with no ledger row.
    const fresh = await prisma.rentPayment.findUniqueOrThrow({
      where: { id: park.rentPaymentId },
    });
    expect(fresh.status).toBe('due');
    expect(fresh.amountCents).toBe(park.amountCents);
    expect(fresh.transactionId).toBeNull();
    const ledgerCount = await prisma.transaction.count({
      where: { accountId, description: `Rent payment — ${PARK_NAME} — ${period}` },
    });
    expect(ledgerCount).toBe(0);
  });
});
