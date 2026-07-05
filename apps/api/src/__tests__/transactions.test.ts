// (g) Transaction create returns aiSuggestedCategoryId when categoryId is
// omitted; confirm applies the suggestion; both audit-logged. Every row this
// file creates is deleted again so the seeded ledger stays pristine.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ReviewQueueResponseSchema, TransactionSchema } from '@hearth/shared';
import { OKAFOR_NAME, OKAFOR_RENT_CENTS } from '../../prisma/seed-constants';
import { buildApp } from '../app';
import { addDays, currentPeriod, iso } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import { pickRentMatch, type RentMatchCandidate } from '../services/rent.service';

let app: FastifyInstance;
const createdIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await prisma.transaction.deleteMany({ where: { id: { in: createdIds } } });
  await app.close();
});

describe('POST /transactions', () => {
  it('suggests a category (keyword table) when categoryId is omitted', async () => {
    const accountId = await getDemoAccountId();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      payload: {
        date: iso(new Date()),
        amountCents: 21500,
        type: 'expense',
        description: 'Emergency plumbing repair — kitchen sink',
        vendor: 'Reyes Plumbing',
      },
    });
    expect(res.statusCode).toBe(201);
    const txn = TransactionSchema.parse(res.json());
    createdIds.push(txn.id);

    const repairs = await prisma.category.findFirst({ where: { name: 'Repairs', isSystem: true } });
    expect(txn.aiSuggestedCategoryId).toBe(repairs?.id);
    expect(txn.aiConfidence).toBe(0.84);
    expect(txn.categoryId).toBeNull(); // never auto-applied — save is explicit

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'transaction.created', entityId: txn.id },
    });
    expect(audit).not.toBeNull();
  });

  it('falls back to Supplies @ 0.62 for unmatched descriptions', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      payload: {
        date: iso(new Date()),
        amountCents: 3300,
        type: 'expense',
        description: 'Misc odds and ends',
      },
    });
    expect(res.statusCode).toBe(201);
    const txn = TransactionSchema.parse(res.json());
    createdIds.push(txn.id);
    const supplies = await prisma.category.findFirst({
      where: { name: 'Supplies', isSystem: true },
    });
    expect(txn.aiSuggestedCategoryId).toBe(supplies?.id);
    expect(txn.aiConfidence).toBe(0.62);
  });
});

describe('POST /transactions/:id/confirm', () => {
  it('applies the AI suggestion, confirms, and audit-logs the confirmation', async () => {
    const accountId = await getDemoAccountId();
    const utilities = await prisma.category.findFirst({
      where: { name: 'Utilities', isSystem: true },
    });
    const pending = await prisma.transaction.create({
      data: {
        accountId,
        date: new Date(),
        amountCents: 9900,
        type: 'expense',
        description: 'TEST CITY WATER BILL',
        source: 'bank',
        status: 'pending_review',
        aiSuggestedCategoryId: utilities?.id ?? null,
        aiConfidence: 0.91,
      },
    });
    createdIds.push(pending.id);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${pending.id}/confirm`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const confirmed = TransactionSchema.parse(res.json());
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.categoryId).toBe(utilities?.id);

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'transaction.confirmed', entityId: pending.id },
    });
    expect(audit?.actor).toBe('ai_suggested_user_confirmed');
  });
});

describe('PATCH / DELETE /transactions/:id', () => {
  it('audits the update with the prior amount/category and the delete with the removed row', async () => {
    const accountId = await getDemoAccountId();
    const supplies = await prisma.category.findFirst({
      where: { name: 'Supplies', isSystem: true },
    });
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      payload: {
        date: iso(new Date()),
        amountCents: 5000,
        type: 'expense',
        description: 'Audit-trail test row',
        categoryId: supplies?.id,
      },
    });
    expect(createRes.statusCode).toBe(201);
    const txn = TransactionSchema.parse(createRes.json());
    createdIds.push(txn.id); // afterAll cleanup is a no-op once the DELETE below ran

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/transactions/${txn.id}`,
      payload: { amountCents: 7500 },
    });
    expect(patchRes.statusCode).toBe(200);
    const updatedAudit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'transaction.updated', entityId: txn.id },
    });
    expect(updatedAudit?.actor).toBe('user');
    expect(JSON.parse(updatedAudit!.detailJson!)).toEqual({
      priorAmountCents: 5000,
      priorCategoryId: supplies?.id ?? null,
      amountCents: 7500,
      categoryId: supplies?.id ?? null,
    });

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/transactions/${txn.id}`,
    });
    expect(deleteRes.statusCode).toBe(204);
    const deletedAudit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'transaction.deleted', entityId: txn.id },
    });
    expect(deletedAudit?.actor).toBe('user');
    expect(JSON.parse(deletedAudit!.detailJson!)).toEqual({
      amountCents: 7500,
      categoryId: supplies?.id ?? null,
      type: 'expense',
    });
  });
});

// ── bank-import rent reconciliation ──────────────────────────────────────────

/** The seed's late Okafor rent for the current month — the natural match target. */
async function okaforPayment() {
  return prisma.rentPayment.findFirstOrThrow({
    where: {
      period: currentPeriod(),
      amountCents: OKAFOR_RENT_CENTS,
      lease: { leaseTenants: { some: { tenant: { fullName: OKAFOR_NAME } } } },
    },
    include: { lease: { include: { unit: true } } },
  });
}

async function createPendingBankDeposit(accountId: string, amountCents: number) {
  const row = await prisma.transaction.create({
    data: {
      accountId,
      date: new Date(),
      amountCents,
      type: 'income',
      description: 'TEST ACH CREDIT — RENT DEPOSIT',
      vendor: 'ACH transfer',
      source: 'bank',
      status: 'pending_review',
    },
  });
  createdIds.push(row.id);
  return row;
}

describe('pickRentMatch (pure matcher)', () => {
  const candidate = (over: Partial<RentMatchCandidate> = {}): RentMatchCandidate => ({
    rentPaymentId: 'rp1',
    leaseId: 'l1',
    tenantName: 'T. Okafor',
    propertyId: 'p1',
    propertyLabel: '48 Maple St',
    unitId: 'u1',
    unitLabel: 'Main',
    period: '2026-07',
    dueDate: new Date('2026-07-01T00:00:00.000Z'),
    amountCents: 115000,
    ...over,
  });
  const txnOn = (date: string, amountCents = 115000) => ({
    amountCents,
    date: new Date(date),
  });

  it('matches a single exact-amount candidate inside the ±14-day window', () => {
    const match = pickRentMatch(txnOn('2026-07-06T00:00:00.000Z'), [candidate()]);
    expect(match?.rentPaymentId).toBe('rp1');
  });

  it('rejects a deposit dated outside the window', () => {
    expect(pickRentMatch(txnOn('2026-07-16T00:00:00.000Z'), [candidate()])).toBeNull();
    expect(pickRentMatch(txnOn('2026-06-16T00:00:00.000Z'), [candidate()])).toBeNull();
  });

  it('rejects an amount mismatch (no tolerance)', () => {
    expect(pickRentMatch(txnOn('2026-07-02T00:00:00.000Z', 115001), [candidate()])).toBeNull();
  });

  it('suppresses the suggestion when two same-rent candidates are both in window', () => {
    const twins = [candidate(), candidate({ rentPaymentId: 'rp2', leaseId: 'l2' })];
    expect(pickRentMatch(txnOn('2026-07-02T00:00:00.000Z'), twins)).toBeNull();
  });
});

describe('GET /transactions/review — rent match suggestion', () => {
  it('suggests the open expected rent for a matching bank deposit; expenses get null', async () => {
    const accountId = await getDemoAccountId();
    const deposit = await createPendingBankDeposit(accountId, OKAFOR_RENT_CENTS);

    const res = await app.inject({ method: 'GET', url: '/api/v1/transactions/review' });
    expect(res.statusCode).toBe(200);
    const queue = ReviewQueueResponseSchema.parse(res.json());

    const payment = await okaforPayment();
    const item = queue.items.find((i) => i.id === deposit.id);
    expect(item?.rentMatch).toMatchObject({
      rentPaymentId: payment.id,
      tenantName: OKAFOR_NAME,
      amountCents: OKAFOR_RENT_CENTS,
      period: currentPeriod(),
    });

    for (const expense of queue.items.filter((i) => i.type === 'expense')) {
      expect(expense.rentMatch).toBeNull();
    }

    // Leave the queue as the seed had it for later test files.
    await prisma.transaction.delete({ where: { id: deposit.id } });
  });

  it('does not suggest a deposit dated outside the match window', async () => {
    const accountId = await getDemoAccountId();
    const payment = await okaforPayment();
    const stale = await prisma.transaction.create({
      data: {
        accountId,
        date: addDays(payment.dueDate, -20),
        amountCents: OKAFOR_RENT_CENTS,
        type: 'income',
        description: 'TEST STALE DEPOSIT',
        source: 'bank',
        status: 'pending_review',
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/transactions/review' });
    const queue = ReviewQueueResponseSchema.parse(res.json());
    expect(queue.items.find((i) => i.id === stale.id)?.rentMatch).toBeNull();

    await prisma.transaction.delete({ where: { id: stale.id } });
  });
});

describe('POST /transactions/:id/confirm with rentPaymentId', () => {
  let accountId: string;

  beforeAll(async () => {
    accountId = await getDemoAccountId();
  });

  afterAll(async () => {
    // Restore the seeded state: Okafor stays late for other test files, and the
    // audit rows this flow wrote don't leak into activity-feed assertions.
    const payment = await okaforPayment();
    await prisma.rentPayment.update({
      where: { id: payment.id },
      data: {
        status: 'due',
        method: null,
        paidAt: null,
        transactionId: null,
        amountCents: OKAFOR_RENT_CENTS,
      },
    });
    await prisma.auditLog.deleteMany({
      where: { accountId, entityId: { in: [...createdIds, payment.id] } },
    });
  });

  it('confirms the deposit, attributes it from the lease, and marks the rent paid', async () => {
    const payment = await okaforPayment();
    const deposit = await createPendingBankDeposit(accountId, OKAFOR_RENT_CENTS);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${deposit.id}/confirm`,
      payload: { rentPaymentId: payment.id },
    });
    expect(res.statusCode).toBe(200);
    const confirmed = TransactionSchema.parse(res.json());

    const rentCategory = await prisma.category.findFirst({
      where: { name: 'Rent', type: 'income' },
    });
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.categoryId).toBe(rentCategory?.id);
    expect(confirmed.propertyId).toBe(payment.lease.unit.propertyId);
    expect(confirmed.unitId).toBe(payment.lease.unitId);

    const linked = await prisma.rentPayment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(linked.status).toBe('paid');
    expect(linked.method).toBe('bank');
    expect(linked.transactionId).toBe(deposit.id);
    expect(linked.paidAt?.toISOString()).toBe(deposit.date.toISOString());

    const confirmAudit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'transaction.confirmed', entityId: deposit.id },
    });
    expect(confirmAudit?.actor).toBe('ai_suggested_user_confirmed');
    const rentAudit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'rent_payment.recorded', entityId: payment.id },
    });
    expect(rentAudit?.actor).toBe('ai_suggested_user_confirmed');
    expect(JSON.parse(rentAudit!.detailJson!)).toMatchObject({ method: 'bank', via: 'bank_import' });
  });

  it('rejects a second deposit against the now-paid rent', async () => {
    const payment = await okaforPayment();
    const second = await createPendingBankDeposit(accountId, OKAFOR_RENT_CENTS);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${second.id}/confirm`,
      payload: { rentPaymentId: payment.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/already recorded as paid/);
  });

  it('blocks deleting the rent-linked transaction', async () => {
    const payment = await okaforPayment();
    expect(payment.transactionId).not.toBeNull();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/transactions/${payment.transactionId}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/rent payment/);

    const untouched = await prisma.rentPayment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(untouched.status).toBe('paid');
    expect(untouched.transactionId).toBe(payment.transactionId);
  });

  it('rejects linking an expense transaction to a rent payment', async () => {
    const payment = await okaforPayment();
    const expenseRes = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      payload: {
        date: iso(new Date()),
        amountCents: OKAFOR_RENT_CENTS,
        type: 'expense',
        description: 'TEST not a deposit',
      },
    });
    const expense = TransactionSchema.parse(expenseRes.json());
    createdIds.push(expense.id);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${expense.id}/confirm`,
      payload: { rentPaymentId: payment.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/income/);
  });
});

describe('POST /transactions/:id/confirm with property/unit attribution', () => {
  it('applies propertyId/unitId alongside the category', async () => {
    const accountId = await getDemoAccountId();
    const unit = await prisma.unit.findFirstOrThrow({
      where: { property: { accountId } },
      include: { property: true },
    });
    const supplies = await prisma.category.findFirst({
      where: { name: 'Supplies', isSystem: true },
    });
    const pending = await prisma.transaction.create({
      data: {
        accountId,
        date: new Date(),
        amountCents: 4200,
        type: 'expense',
        description: 'TEST HARDWARE RUN',
        source: 'bank',
        status: 'pending_review',
      },
    });
    createdIds.push(pending.id);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${pending.id}/confirm`,
      payload: { categoryId: supplies?.id, propertyId: unit.propertyId, unitId: unit.id },
    });
    expect(res.statusCode).toBe(200);
    const confirmed = TransactionSchema.parse(res.json());
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.propertyId).toBe(unit.propertyId);
    expect(confirmed.unitId).toBe(unit.id);
    expect(confirmed.categoryId).toBe(supplies?.id);
  });
});
