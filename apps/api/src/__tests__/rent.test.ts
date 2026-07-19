// (b) Rent tracker derivations; (h) reminders set remindedAt + AuditLog.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { resetMockEmail, sentEmails } from '../integrations/mock/mock-email';
import { currentPeriod } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import type { EmailAdapter } from '../integrations/types';
import * as rentService from '../services/rent.service';

// F1 'email' honesty coverage: the factory is module-mocked (spread of the real
// module) because createEmailAdapter memoizes the real CF adapter — env
// stubbing alone would construct a real Cloudflare client. The flag defaults to
// false so every other test keeps the real (unconfigured → mock) behavior.
const emailControl = vi.hoisted(() => ({
  configured: false,
  adapter: null as {
    send: (msg: { to: string; subject: string; body: string }) => Promise<{ messageId: string }>;
  } | null,
}));

vi.mock('../integrations/factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../integrations/factory')>();
  return {
    ...actual,
    isRealEmailConfigured: () => emailControl.configured,
    createEmailAdapter: (): EmailAdapter =>
      emailControl.configured && emailControl.adapter
        ? emailControl.adapter
        : actual.createEmailAdapter(),
  };
});

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
    // WS7: the seed stays fee-free, so every tracker row carries lateFeeCents 0.
    expect(tracker.rows.every((r) => r.lateFeeCents === 0)).toBe(true);

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
  beforeEach(() => {
    resetMockEmail();
  });

  it('sends to a late payment, sets remindedAt and writes an AuditLog row', async () => {
    const accountId = await getDemoAccountId();
    const tracker = await rentService.getMonthStatus(accountId, currentPeriod());
    const okafor = tracker.rows.find((r) => r.tenantName === OKAFOR_NAME);
    const paidRow = tracker.rows.find((r) => r.status === 'paid');
    expect(okafor).toBeDefined();
    expect(paidRow).toBeDefined();
    const okaforTenant = await prisma.tenant.findFirstOrThrow({
      where: { id: okafor!.tenantId },
    });

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
        subject: expect.stringMatching(/^Rent reminder/),
        // Test env has no CF email vars → the mock adapter records the send
        // but we never CLAIM a real email: deliveredVia stays 'mailto'.
        deliveredVia: 'mailto',
        to: okaforTenant.email,
      },
      { rentPaymentId: paidRow!.rentPaymentId, status: 'skipped', reason: 'already_paid' },
    ]);

    // Human-actor route path drives the (mock) adapter — the deterministic
    // dev-mode send hit the tenant's real address, never a placeholder.
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.to).toBe(okaforTenant.email);
    expect(sentEmails[0]!.subject).toMatch(/^Rent reminder/);

    const updated = await prisma.rentPayment.findUnique({
      where: { id: okafor!.rentPaymentId },
    });
    expect(updated?.remindedAt).not.toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'rent.reminder_sent', entityId: okafor!.rentPaymentId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit!.detailJson!)).toMatchObject({
      deliveredVia: 'mailto',
      to: okaforTenant.email,
    });
  });

  it("actor 'system' composes only — the email adapter is never called", async () => {
    const accountId = await getDemoAccountId();
    const tracker = await rentService.getMonthStatus(accountId, currentPeriod());
    const late = tracker.rows.find((r) => r.status === 'late');
    expect(late).toBeDefined();

    const { results } = await rentService.sendReminders(
      accountId,
      { rentPaymentIds: [late!.rentPaymentId] },
      'system',
    );
    expect(results[0]).toMatchObject({
      status: 'sent',
      deliveredVia: 'mailto',
      mailto: expect.stringMatching(/^mailto:/),
    });
    expect(sentEmails).toHaveLength(0);
  });

  it('an adapter send failure degrades the row to mailto without failing the batch', async () => {
    const accountId = await getDemoAccountId();
    // The mock adapter throws for addresses containing "fail".
    const property = await prisma.property.create({
      data: { accountId, addressLine1: '3 Fail Ln', city: 'Testville', state: 'NY', zip: '10001' },
    });
    const unit = await prisma.unit.create({ data: { propertyId: property.id, label: 'F-1' } });
    const tenant = await prisma.tenant.create({
      data: { accountId, fullName: 'Failing Fiona', email: 'fiona.fail@example.com' },
    });
    const lease = await prisma.lease.create({
      data: {
        unitId: unit.id,
        rentCents: 100000,
        dueDay: 1,
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-12-31'),
        status: 'active',
        leaseTenants: { create: { tenantId: tenant.id, isPrimary: true } },
      },
    });
    const dueDate = new Date();
    dueDate.setUTCDate(dueDate.getUTCDate() - 10);
    const payment = await prisma.rentPayment.create({
      data: { leaseId: lease.id, period: currentPeriod(), dueDate, amountCents: 100000, status: 'due' },
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/rent/reminders',
        payload: { rentPaymentIds: [payment.id] },
      });
      expect(res.statusCode).toBe(200);
      const body = SendRemindersResponseSchema.parse(res.json());
      expect(body.results[0]).toMatchObject({
        status: 'sent',
        deliveredVia: 'mailto',
        to: 'fiona.fail@example.com',
        mailto: expect.stringMatching(/^mailto:/),
      });
      expect(sentEmails).toHaveLength(0);
    } finally {
      await prisma.auditLog.deleteMany({ where: { accountId, entityId: payment.id } });
      await prisma.property.delete({ where: { id: property.id } });
      await prisma.tenant.delete({ where: { id: tenant.id } });
    }
  });
});

describe('POST /rent/reminders with the real email adapter configured (module-mocked factory)', () => {
  afterEach(() => {
    emailControl.configured = false;
    emailControl.adapter = null;
  });

  it("a successful configured send reports deliveredVia 'email' in the row and the audit", async () => {
    const accountId = await getDemoAccountId();
    const tracker = await rentService.getMonthStatus(accountId, currentPeriod());
    const okafor = tracker.rows.find((r) => r.tenantName === OKAFOR_NAME)!;
    const okaforTenant = await prisma.tenant.findFirstOrThrow({ where: { id: okafor.tenantId } });
    const sends: Array<{ to: string; subject: string; body: string }> = [];
    emailControl.configured = true;
    emailControl.adapter = {
      send: async (msg) => {
        sends.push(msg);
        return { messageId: 'real_send_1' };
      },
    };

    const { results } = await rentService.sendReminders(
      accountId,
      { rentPaymentIds: [okafor.rentPaymentId] },
      'user',
    );
    expect(results[0]).toMatchObject({
      rentPaymentId: okafor.rentPaymentId,
      status: 'sent',
      deliveredVia: 'email',
      to: okaforTenant.email,
    });
    // The adapter received the tenant's real address, never a placeholder.
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toBe(okaforTenant.email);

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'rent.reminder_sent', entityId: okafor.rentPaymentId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit!.detailJson!)).toMatchObject({
      deliveredVia: 'email',
      to: okaforTenant.email,
    });
  });

  it("a configured-adapter send failure degrades the row to 'mailto' without failing the batch", async () => {
    const accountId = await getDemoAccountId();
    const tracker = await rentService.getMonthStatus(accountId, currentPeriod());
    const okafor = tracker.rows.find((r) => r.tenantName === OKAFOR_NAME)!;
    emailControl.configured = true;
    emailControl.adapter = {
      send: async () => {
        throw new Error('provider outage');
      },
    };

    const { results } = await rentService.sendReminders(
      accountId,
      { rentPaymentIds: [okafor.rentPaymentId] },
      'user',
    );
    expect(results[0]).toMatchObject({
      status: 'sent',
      deliveredVia: 'mailto',
      mailto: expect.stringMatching(/^mailto:/),
    });
  });
});

describe('rentService.reminderDelivery (pure resolver)', () => {
  it("actor 'system' is always compose-only — no autonomous sends", () => {
    expect(rentService.reminderDelivery('system', 'tenant@example.com', true)).toBe('compose_only');
    expect(rentService.reminderDelivery('system', 'tenant@example.com', false)).toBe(
      'compose_only',
    );
    expect(rentService.reminderDelivery('system', null, true)).toBe('compose_only');
  });

  it('a human actor with a tenant email and a configured adapter is a real email send', () => {
    expect(rentService.reminderDelivery('user', 'tenant@example.com', true)).toBe('email');
    expect(
      rentService.reminderDelivery('ai_suggested_user_confirmed', 'tenant@example.com', true),
    ).toBe('email');
  });

  it('falls back to mailto without a tenant email or without configuration', () => {
    expect(rentService.reminderDelivery('user', null, true)).toBe('mailto');
    expect(rentService.reminderDelivery('user', 'tenant@example.com', false)).toBe('mailto');
    expect(rentService.reminderDelivery('ai_suggested_user_confirmed', null, false)).toBe(
      'mailto',
    );
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
    // Deleting the ledger row below cascades its deposit.
    await prisma.rentPayment.update({
      where: { id: paid.id },
      data: {
        status: 'due',
        method: null,
        paidAt: null,
        externalRef: null,
        transactionId: null,
        amountCents: park.amountCents,
        paidCents: 0,
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

describe('rentService.recordPayment partial payments (deposit ledger)', () => {
  afterAll(async () => {
    // Restore the seeded state (Park stays late for other test files).
    const accountId = await getDemoAccountId();
    const period = currentPeriod();
    const tracker = await rentService.getMonthStatus(accountId, period);
    const park = tracker.rows.find((r) => r.tenantName === PARK_NAME)!;
    const ledger = await prisma.transaction.findMany({
      where: { accountId, description: `Rent payment — ${PARK_NAME} — ${period}` },
      select: { id: true },
    });
    // Deleting the ledger rows cascades their deposits.
    await prisma.transaction.deleteMany({ where: { id: { in: ledger.map((t) => t.id) } } });
    await prisma.rentPayment.update({
      where: { id: park.rentPaymentId },
      data: {
        status: 'due',
        method: null,
        paidAt: null,
        externalRef: null,
        transactionId: null,
        amountCents: park.amountCents,
        paidCents: 0,
      },
    });
    await prisma.auditLog.deleteMany({
      where: {
        accountId,
        entityId: { in: [park.rentPaymentId, ...ledger.map((t) => t.id)] },
      },
    });
  });

  it('accumulates partial deposits into paid-in-full and rejects overpayment', async () => {
    const accountId = await getDemoAccountId();
    const period = currentPeriod();
    const tracker = await rentService.getMonthStatus(accountId, period);
    const park = tracker.rows.find((r) => r.tenantName === PARK_NAME)!;
    const firstCents = 50000;

    // First partial: stored 'due', derived 'partial', charge untouched.
    const afterFirst = await rentService.recordPayment(accountId, {
      leaseId: park.leaseId,
      period,
      amountCents: firstCents,
      method: 'manual',
    });
    expect(afterFirst.status).toBe('due');
    expect(afterFirst.paidCents).toBe(firstCents);
    expect(afterFirst.amountCents).toBe(park.amountCents);
    expect(afterFirst.transactionId).toBeNull(); // legacy link is single-full-payment only

    const trackerAfterFirst = await rentService.getMonthStatus(accountId, period);
    const partialRow = trackerAfterFirst.rows.find((r) => r.rentPaymentId === park.rentPaymentId)!;
    expect(partialRow.status).toBe('partial');
    expect(partialRow.daysLate).toBeGreaterThan(0); // Park was late — a partial doesn't erase that
    expect(partialRow.deposits).toHaveLength(1);
    expect(trackerAfterFirst.partialUnits).toBe(1);
    expect(trackerAfterFirst.collectedCents).toBe(COLLECTED_MTD_CENTS + firstCents);
    expect(trackerAfterFirst.outstandingCents).toBe(OUTSTANDING_MTD_CENTS - firstCents);
    expect(trackerAfterFirst.paidUnits).toBe(PAID_UNITS); // not fully paid yet

    // Overpaying the remainder is rejected.
    await expect(
      rentService.recordPayment(accountId, {
        leaseId: park.leaseId,
        period,
        amountCents: park.amountCents - firstCents + 1,
        method: 'manual',
      }),
    ).rejects.toThrow(/exceeds the .* remaining/);

    // Second deposit completing the total flips the stored status to paid.
    const afterSecond = await rentService.recordPayment(accountId, {
      leaseId: park.leaseId,
      period,
      amountCents: park.amountCents - firstCents,
      method: 'manual',
    });
    expect(afterSecond.status).toBe('paid');
    expect(afterSecond.paidCents).toBe(park.amountCents);

    const trackerAfterSecond = await rentService.getMonthStatus(accountId, period);
    expect(trackerAfterSecond.paidUnits).toBe(PAID_UNITS + 1);
    expect(trackerAfterSecond.partialUnits).toBe(0);
    expect(trackerAfterSecond.collectedCents).toBe(COLLECTED_MTD_CENTS + park.amountCents);
    expect(trackerAfterSecond.outstandingCents).toBe(OUTSTANDING_MTD_CENTS - park.amountCents);

    // Two deposits back the charge; a third payment is rejected as already paid.
    const deposits = await prisma.rentPaymentDeposit.findMany({
      where: { rentPaymentId: park.rentPaymentId },
    });
    expect(deposits).toHaveLength(2);
    await expect(
      rentService.recordPayment(accountId, {
        leaseId: park.leaseId,
        period,
        amountCents: 1,
        method: 'manual',
      }),
    ).rejects.toThrow(/already recorded as paid/);

    // Unlinking one deposit reverts to partial and reopens the difference.
    const unlinked = await rentService.unlinkDeposit(
      accountId,
      park.rentPaymentId,
      deposits[0]!.id,
    );
    expect(unlinked.status).toBe('due');
    expect(unlinked.paidCents).toBe(park.amountCents - deposits[0]!.amountCents);
  });
});
