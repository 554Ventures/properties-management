// (g) Transaction create returns aiSuggestedCategoryId when categoryId is
// omitted; confirm applies the suggestion; both audit-logged. Every row this
// file creates is deleted again so the seeded ledger stays pristine.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import FormData from 'form-data';
import {
  ApiErrorSchema,
  ConfirmAllReviewResponseSchema,
  CreateTransactionResponseSchema,
  DismissAllReviewResponseSchema,
  ImportTransactionsResponseSchema,
  ReceiptScanResponseSchema,
  ReviewQueueResponseSchema,
  TransactionListResponseSchema,
  TransactionSchema,
} from '@hearth/shared';
import { OKAFOR_NAME, OKAFOR_RENT_CENTS } from '../../prisma/seed-constants';
import { buildApp } from '../app';
import { addDays, currentPeriod, iso, monthStart } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import { exchangePublicToken } from '../services/integration.service';
import * as leaseService from '../services/lease.service';
import * as propertyService from '../services/property.service';
import * as rentService from '../services/rent.service';
import { deriveRentStatus, pickRentMatch, type RentMatchCandidate } from '../services/rent.service';
import * as tenantService from '../services/tenant.service';

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
    paidCents: 0,
    lateFeeCents: 0,
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

  it('matches the remaining balance of a partially paid charge (not the full amount)', () => {
    const partial = candidate({ paidCents: 40000 }); // 75000 remaining
    expect(pickRentMatch(txnOn('2026-07-02T00:00:00.000Z', 75000), [partial])?.rentPaymentId).toBe(
      'rp1',
    );
    // The full charge amount no longer matches once part of it is paid.
    expect(pickRentMatch(txnOn('2026-07-02T00:00:00.000Z', 115000), [partial])).toBeNull();
  });

  it('never matches a fully covered charge', () => {
    const covered = candidate({ paidCents: 115000 });
    expect(pickRentMatch(txnOn('2026-07-02T00:00:00.000Z', 115000), [covered])).toBeNull();
    expect(pickRentMatch(txnOn('2026-07-02T00:00:00.000Z', 0), [covered])).toBeNull();
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
    await prisma.rentPaymentDeposit.deleteMany({ where: { rentPaymentId: payment.id } });
    await prisma.rentPayment.update({
      where: { id: payment.id },
      data: {
        status: 'due',
        method: null,
        paidAt: null,
        transactionId: null,
        amountCents: OKAFOR_RENT_CENTS,
        paidCents: 0,
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

describe('transaction attribution ownership', () => {
  it('rejects unknown property/unit ids and unit-property mismatches', async () => {
    const accountId = await getDemoAccountId();
    const badPropertyRes = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      payload: {
        date: iso(new Date()),
        amountCents: 1000,
        type: 'expense',
        description: 'TEST attribution',
        propertyId: 'not-a-real-property',
      },
    });
    expect(badPropertyRes.statusCode).toBe(404);

    // A real unit paired with a different real property.
    const unit = await prisma.unit.findFirstOrThrow({
      where: { property: { accountId } },
      select: { id: true, propertyId: true },
    });
    const otherProperty = await prisma.property.findFirstOrThrow({
      where: { accountId, id: { not: unit.propertyId } },
    });
    const mismatchRes = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      payload: {
        date: iso(new Date()),
        amountCents: 1000,
        type: 'expense',
        description: 'TEST attribution',
        propertyId: otherProperty.id,
        unitId: unit.id,
      },
    });
    expect(mismatchRes.statusCode).toBe(400);
    expect(mismatchRes.json().error.message).toMatch(/does not belong/);

    // PATCH validates the effective pair: swapping the property away from the
    // row's unit is rejected too.
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      payload: {
        date: iso(new Date()),
        amountCents: 1000,
        type: 'expense',
        description: 'TEST attribution ok',
        propertyId: unit.propertyId,
        unitId: unit.id,
      },
    });
    expect(createRes.statusCode).toBe(201);
    const txn = TransactionSchema.parse(createRes.json());
    createdIds.push(txn.id);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/transactions/${txn.id}`,
      payload: { propertyId: otherProperty.id },
    });
    expect(patchRes.statusCode).toBe(400);
    expect(patchRes.json().error.message).toMatch(/does not belong/);
  });
});

// ── manual-income rent reconciliation (the non-bank path) ────────────────────

describe('POST /transactions — manual income rent match and linked-row guard', () => {
  let accountId: string;
  // The rent-linked ledger row created below; later tests assert its edit guard.
  let linkedTxnId: string;

  beforeAll(async () => {
    accountId = await getDemoAccountId();
  });

  afterAll(async () => {
    // Restore the seeded state: Okafor stays late for other test files.
    const payment = await okaforPayment();
    await prisma.rentPaymentDeposit.deleteMany({ where: { rentPaymentId: payment.id } });
    await prisma.rentPayment.update({
      where: { id: payment.id },
      data: {
        status: 'due',
        method: null,
        paidAt: null,
        transactionId: null,
        amountCents: OKAFOR_RENT_CENTS,
        paidCents: 0,
      },
    });
    await prisma.auditLog.deleteMany({
      where: { accountId, entityId: { in: [...createdIds, payment.id] } },
    });
  });

  it('rejects linking a transaction that exceeds the remaining balance', async () => {
    const payment = await okaforPayment();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      payload: {
        date: iso(new Date()),
        amountCents: OKAFOR_RENT_CENTS + 100,
        type: 'income',
        description: 'TEST oversized check from Okafor',
      },
    });
    const over = CreateTransactionResponseSchema.parse(res.json());
    createdIds.push(over.id);

    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${over.id}/confirm`,
      payload: { rentPaymentId: payment.id },
    });
    expect(confirmRes.statusCode).toBe(400);
    expect(confirmRes.json().error.message).toMatch(/exceeds the .* remaining/);

    const untouched = await prisma.rentPayment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(untouched.status).toBe('due');
    expect(untouched.paidCents).toBe(0);
    expect(untouched.amountCents).toBe(OKAFOR_RENT_CENTS);
  });

  it('links a short check as a partial deposit; unlinking restores the charge', async () => {
    const payment = await okaforPayment();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      payload: {
        date: iso(new Date()),
        amountCents: OKAFOR_RENT_CENTS - 50000,
        type: 'income',
        description: 'TEST short check from Okafor',
      },
    });
    const short = CreateTransactionResponseSchema.parse(res.json());
    createdIds.push(short.id);

    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${short.id}/confirm`,
      payload: { rentPaymentId: payment.id },
    });
    expect(confirmRes.statusCode).toBe(200);

    const partial = await prisma.rentPayment.findUniqueOrThrow({
      where: { id: payment.id },
      include: { deposits: true },
    });
    expect(partial.status).toBe('due'); // stored status flips only when covered
    expect(partial.paidCents).toBe(OKAFOR_RENT_CENTS - 50000);
    expect(partial.amountCents).toBe(OKAFOR_RENT_CENTS); // charge never overwritten
    expect(partial.transactionId).toBeNull(); // legacy link is single-full-payment only
    expect(partial.deposits).toHaveLength(1);
    expect(partial.deposits[0]!.transactionId).toBe(short.id);
    expect(deriveRentStatus(partial, 0, 'calendar', 'America/New_York').status).toBe('partial');

    // The deposit-backed row is guarded like a legacy-linked one.
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/transactions/${short.id}`,
      payload: { amountCents: 100 },
    });
    expect(patchRes.statusCode).toBe(400);

    // Unlink restores the charge to fully unpaid; the ledger row survives.
    const unlinked = await rentService.unlinkDeposit(
      accountId,
      payment.id,
      partial.deposits[0]!.id,
    );
    expect(unlinked.paidCents).toBe(0);
    expect(unlinked.status).toBe('due');
    const survivingTxn = await prisma.transaction.findUnique({ where: { id: short.id } });
    expect(survivingTxn?.status).toBe('confirmed');
    const unlinkAudit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'rent_payment.deposit_unlinked', entityId: payment.id },
    });
    expect(unlinkAudit).not.toBeNull();
  });

  it('surfaces the rent match on a manual income entry and links it as method=manual', async () => {
    const payment = await okaforPayment();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      payload: {
        date: iso(new Date()),
        amountCents: OKAFOR_RENT_CENTS,
        type: 'income',
        description: 'TEST check from Okafor',
      },
    });
    expect(res.statusCode).toBe(201);
    const txn = CreateTransactionResponseSchema.parse(res.json());
    createdIds.push(txn.id);
    linkedTxnId = txn.id;
    expect(txn.rentMatch).toMatchObject({
      rentPaymentId: payment.id,
      tenantName: OKAFOR_NAME,
      amountCents: OKAFOR_RENT_CENTS,
      period: currentPeriod(),
    });

    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${txn.id}/confirm`,
      payload: { rentPaymentId: payment.id },
    });
    expect(confirmRes.statusCode).toBe(200);

    const linked = await prisma.rentPayment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(linked.status).toBe('paid');
    expect(linked.method).toBe('manual'); // manual entry, not a bank deposit
    expect(linked.transactionId).toBe(txn.id);
    expect(linked.amountCents).toBe(OKAFOR_RENT_CENTS); // charge never overwritten

    const rentAudit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'rent_payment.recorded', entityId: payment.id },
    });
    expect(JSON.parse(rentAudit!.detailJson!)).toMatchObject({
      method: 'manual',
      via: 'transaction_link',
    });
  });

  it('returns no rent match for expenses or amounts that match nothing', async () => {
    const expenseRes = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      payload: {
        date: iso(new Date()),
        amountCents: OKAFOR_RENT_CENTS,
        type: 'expense',
        description: 'TEST expense, not rent',
      },
    });
    const expense = CreateTransactionResponseSchema.parse(expenseRes.json());
    createdIds.push(expense.id);
    expect(expense.rentMatch).toBeNull();

    const oddRes = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      payload: {
        date: iso(new Date()),
        amountCents: 7777700, // no lease rents this
        type: 'income',
        description: 'TEST unmatched income',
      },
    });
    const odd = CreateTransactionResponseSchema.parse(oddRes.json());
    createdIds.push(odd.id);
    expect(odd.rentMatch).toBeNull();
  });

  it('blocks amount/date/type/category edits on the rent-linked row', async () => {
    const rentCategory = await prisma.category.findFirst({
      where: { name: 'Rent', type: 'income', isSystem: true },
    });
    const otherIncome = await prisma.category.findFirst({
      where: { name: 'Other Income', type: 'income', isSystem: true },
    });
    for (const payload of [
      { amountCents: OKAFOR_RENT_CENTS + 100 },
      { date: iso(addDays(new Date(), -3)) },
      { type: 'expense' },
      { categoryId: otherIncome?.id },
    ]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/transactions/${linkedTxnId}`,
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/backs a recorded rent payment/);
      expect(res.json().error.message).toMatch(/category/);
    }

    // Values that resolve to the same as-stored value (a no-op patch) and
    // unlinked fields still go through — the guard only fires on an actual
    // change.
    const okRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/transactions/${linkedTxnId}`,
      payload: { amountCents: OKAFOR_RENT_CENTS, categoryId: rentCategory?.id },
    });
    expect(okRes.statusCode).toBe(200);
    expect(TransactionSchema.parse(okRes.json()).categoryId).toBe(rentCategory?.id);
  });
});

// ── WS6: rent-link category guard + property/unit looseness (own fixture) ───

describe('PATCH /transactions/:id — rent-link category guard (own lease fixture)', () => {
  let accountId: string;
  let propertyId: string;
  let unitAId: string;
  let unitBId: string;
  let tenantId: string;
  let leaseId: string;
  let linkedTxnId: string;

  beforeAll(async () => {
    accountId = await getDemoAccountId();
    const property = await propertyService.create(accountId, {
      addressLine1: 'ZZCATGUARD 1 Test Way',
      city: 'X',
      state: 'CA',
      zip: '00000',
      units: [{ label: 'A' }, { label: 'B' }],
    });
    propertyId = property.id;
    const units = await prisma.unit.findMany({ where: { propertyId }, orderBy: { label: 'asc' } });
    unitAId = units[0]!.id;
    unitBId = units[1]!.id;

    const tenant = await tenantService.create(accountId, { fullName: 'ZZCatguard Tenant' });
    tenantId = tenant.id;

    const period = currentPeriod();
    const periodStart = monthStart(period);
    const lease = await leaseService.create(accountId, {
      unitId: unitAId,
      tenantIds: [tenantId],
      rentCents: 120_000,
      dueDay: 1,
      startDate: iso(addDays(periodStart, -365)),
      endDate: iso(addDays(periodStart, 365)),
    });
    leaseId = lease.id;

    const payment = await rentService.recordPayment(accountId, {
      leaseId,
      period,
      amountCents: 120_000,
      method: 'manual',
    });
    linkedTxnId = payment.transactionId!;
    createdIds.push(linkedTxnId);
  });

  afterAll(async () => {
    await prisma.rentPayment.deleteMany({ where: { leaseId } });
    await prisma.lease.delete({ where: { id: leaseId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.unit.deleteMany({ where: { propertyId } });
    await prisma.property.delete({ where: { id: propertyId } });
    await prisma.auditLog.deleteMany({
      where: { accountId, entityId: { in: [propertyId, leaseId, tenantId, linkedTxnId] } },
    });
  });

  it('rejects a category change on the rent-linked row', async () => {
    const supplies = await prisma.category.findFirst({
      where: { name: 'Supplies', isSystem: true },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/transactions/${linkedTxnId}`,
      payload: { categoryId: supplies?.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/backs a recorded rent payment/);
    expect(res.json().error.message).toMatch(/category/);
  });

  it('still allows property/unit reattribution on the same linked row', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/transactions/${linkedTxnId}`,
      payload: { unitId: unitBId },
    });
    expect(res.statusCode).toBe(200);
    const txn = TransactionSchema.parse(res.json());
    expect(txn.unitId).toBe(unitBId);
    expect(txn.propertyId).toBe(propertyId); // unchanged, still owned
  });
});

describe('POST /transactions/receipt (mock mode)', () => {
  // PNG signature + IHDR chunk header — enough for magic-byte sniffing to
  // positively identify it as image/png (the bare 8-byte signature alone
  // isn't); content is otherwise irrelevant in mock mode (no model call).
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

  function receiptForm(contentType: string) {
    const form = new FormData();
    form.append('file', png, { filename: 'receipt.png', contentType });
    return form;
  }

  it('returns the deterministic fixture parse with resolved seed ids', async () => {
    const accountId = await getDemoAccountId();
    const form = receiptForm('image/png');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions/receipt',
      payload: form.getBuffer(),
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const scan = ReceiptScanResponseSchema.parse(res.json());

    const repairs = await prisma.category.findFirst({ where: { name: 'Repairs', isSystem: true } });
    const firstProperty = await prisma.property.findFirstOrThrow({
      where: { accountId, archivedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    expect(scan.vendor).toBe('ACE Hardware #2214');
    expect(scan.amountCents).toBe(4327);
    expect(scan.suggestedCategoryId).toBe(repairs?.id);
    expect(scan.suggestedPropertyId).toBe(firstProperty.id);
    expect(scan.confidence).toBe(0.84);
  });

  it('rejects a non-image upload with a 400', async () => {
    const form = receiptForm('text/plain');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions/receipt',
      payload: form.getBuffer(),
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
    expect(res.json().error.message).toMatch(/JPEG, PNG, WebP, or GIF/);
  });

  it('rejects a file whose content does not match its declared (spoofed) image Content-Type', async () => {
    const form = new FormData();
    form.append('file', Buffer.from('not actually an image', 'utf-8'), {
      filename: 'receipt.png',
      contentType: 'image/png',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions/receipt',
      payload: form.getBuffer(),
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
    expect(res.json().error.message).toMatch(/JPEG, PNG, WebP, or GIF/);
  });
});

// ── review queue: search / filters / paging / bulk actions ──────────────────
// Every request here is scoped by a unique description marker so the seeded
// queue rows (and the figures other test files pin) are never touched.

async function createQueueRow(
  accountId: string,
  over: Partial<{
    description: string;
    vendor: string;
    type: string;
    source: string;
    status: string;
    amountCents: number;
    aiSuggestedCategoryId: string | null;
    aiConfidence: number;
  }> = {},
) {
  const row = await prisma.transaction.create({
    data: {
      accountId,
      date: new Date(),
      amountCents: 1111,
      type: 'expense',
      description: 'ZZQUEUE TEST ROW',
      source: 'bank',
      status: 'pending_review',
      ...over,
    },
  });
  createdIds.push(row.id);
  return row;
}

describe('GET /transactions/review — search, filters, and paging', () => {
  beforeAll(async () => {
    const accountId = await getDemoAccountId();
    await createQueueRow(accountId, {
      description: 'ZZQUEUE HARDWARE RUN',
      vendor: 'Acme Plumbing Co',
    });
    await createQueueRow(accountId, {
      description: 'ZZQUEUE CITY WATER',
      source: 'receipt',
      amountCents: 2222,
    });
    await createQueueRow(accountId, {
      description: 'ZZQUEUE MYSTERY DEPOSIT',
      type: 'income',
      amountCents: 3333,
    });
  });

  it('searches description and vendor case-insensitively and reports the filtered total', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/transactions/review?q=zzqueue' });
    expect(res.statusCode).toBe(200);
    const queue = ReviewQueueResponseSchema.parse(res.json());
    expect(queue.total).toBe(3);
    expect(queue.items).toHaveLength(3);
    expect(queue.nextCursor).toBeNull();

    const byVendor = ReviewQueueResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/transactions/review?q=acme+plumbing' })).json(),
    );
    expect(byVendor.total).toBe(1);
    expect(byVendor.items[0]?.description).toBe('ZZQUEUE HARDWARE RUN');
  });

  it('filters by type and source', async () => {
    const income = ReviewQueueResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/transactions/review?q=zzqueue&type=income' })).json(),
    );
    expect(income.total).toBe(1);
    expect(income.items[0]?.description).toBe('ZZQUEUE MYSTERY DEPOSIT');

    const receipts = ReviewQueueResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/transactions/review?q=zzqueue&source=receipt' })).json(),
    );
    expect(receipts.total).toBe(1);
    expect(receipts.items[0]?.description).toBe('ZZQUEUE CITY WATER');
  });

  it('pages with a cursor while total stays the full filtered count', async () => {
    const first = ReviewQueueResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/transactions/review?q=zzqueue&limit=2' })).json(),
    );
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(3);
    expect(first.nextCursor).not.toBeNull();

    const second = ReviewQueueResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/transactions/review?q=zzqueue&limit=2&cursor=${first.nextCursor}`,
        })
      ).json(),
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(3); // no overlap across pages
  });
});

// ── ledger list: search / sort / offset pagination ──────────────────────────
// Rows are marked ZZLEDGER so the query never touches the seeded ledger figures
// other test files pin. createQueueRow handles cleanup via createdIds.

describe('GET /transactions — ledger search, sort, and offset paging', () => {
  beforeAll(async () => {
    const accountId = await getDemoAccountId();
    await createQueueRow(accountId, {
      description: 'ZZLEDGER ALPHA',
      amountCents: 5000,
      type: 'expense',
      status: 'confirmed',
    });
    await createQueueRow(accountId, {
      description: 'ZZLEDGER BRAVO',
      amountCents: 3000,
      type: 'expense',
      status: 'dismissed',
    });
    await createQueueRow(accountId, {
      description: 'ZZLEDGER CHARLIE',
      amountCents: 7000,
      type: 'income',
      status: 'confirmed',
    });
  });

  it('searches description/vendor and reports the filtered total', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/transactions?q=zzledger' });
    expect(res.statusCode).toBe(200);
    const ledger = TransactionListResponseSchema.parse(res.json());
    expect(ledger.total).toBe(3);
    expect(ledger.items).toHaveLength(3);
    expect(ledger.nextCursor).toBeNull(); // 3 ≤ default limit
  });

  it('sorts by a whitelisted column and direction', async () => {
    const asc = TransactionListResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/transactions?q=zzledger&sort=amountCents&dir=asc',
        })
      ).json(),
    );
    expect(asc.items.map((i) => i.amountCents)).toEqual([3000, 5000, 7000]);

    const desc = TransactionListResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/transactions?q=zzledger&sort=amountCents&dir=desc',
        })
      ).json(),
    );
    expect(desc.items.map((i) => i.amountCents)).toEqual([7000, 5000, 3000]);
  });

  it('pages by offset with a stable total and no cursor', async () => {
    const base = '/api/v1/transactions?q=zzledger&sort=amountCents&dir=asc&limit=2';
    const first = TransactionListResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `${base}&offset=0` })).json(),
    );
    expect(first.items.map((i) => i.amountCents)).toEqual([3000, 5000]);
    expect(first.total).toBe(3);
    expect(first.nextCursor).toBeNull(); // offset mode doesn't emit a cursor

    const second = TransactionListResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `${base}&offset=2` })).json(),
    );
    expect(second.items.map((i) => i.amountCents)).toEqual([7000]);
    expect(second.total).toBe(3);

    const ids = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(3); // disjoint pages
  });

  it('combines the search with type and status filters', async () => {
    const income = TransactionListResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/transactions?q=zzledger&type=income' })).json(),
    );
    expect(income.total).toBe(1);
    expect(income.items[0]?.description).toBe('ZZLEDGER CHARLIE');

    const dismissed = TransactionListResponseSchema.parse(
      (
        await app.inject({ method: 'GET', url: '/api/v1/transactions?q=zzledger&status=dismissed' })
      ).json(),
    );
    expect(dismissed.total).toBe(1);
    expect(dismissed.items[0]?.description).toBe('ZZLEDGER BRAVO');
  });

  it('unassigned=true returns only property-less rows; false is not coerced to true', async () => {
    const accountId = await getDemoAccountId();
    const property = await prisma.property.findFirstOrThrow({
      where: { accountId, archivedAt: null },
    });

    // Distinctive amounts so these confirmed rows don't become duplicate
    // matches for other files' default-amount pending rows (confirm-all skips
    // possible duplicates).
    const withProperty = await createQueueRow(accountId, {
      description: 'ZZUNASSIGNEDFILTER WITH',
      status: 'confirmed',
      amountCents: 90011,
    });
    await prisma.transaction.update({
      where: { id: withProperty.id },
      data: { propertyId: property.id },
    });
    const withoutProperty = await createQueueRow(accountId, {
      description: 'ZZUNASSIGNEDFILTER WITHOUT',
      status: 'confirmed',
      amountCents: 90022,
    });

    // Filter honored: propertyId = null only.
    const filtered = TransactionListResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/transactions?q=zzunassignedfilter&unassigned=true',
        })
      ).json(),
    );
    expect(filtered.total).toBe(1);
    expect(filtered.items.map((i) => i.id)).toEqual([withoutProperty.id]);

    // No filter: both rows come back.
    const all = TransactionListResponseSchema.parse(
      (
        await app.inject({ method: 'GET', url: '/api/v1/transactions?q=zzunassignedfilter' })
      ).json(),
    );
    expect(all.total).toBe(2);

    // 'false' must NOT filter — coerceBooleans maps it to real false, unlike
    // z.coerce.boolean() which would turn every non-empty string into true.
    const explicitFalse = TransactionListResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/transactions?q=zzunassignedfilter&unassigned=false',
        })
      ).json(),
    );
    expect(explicitFalse.total).toBe(2);
  });
});

describe('POST /transactions/review/confirm-all', () => {
  let accountId: string;

  beforeAll(async () => {
    accountId = await getDemoAccountId();
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { accountId, entityId: { in: createdIds } } });
  });

  it('confirms suggested items, skips rent matches and unsuggested ones, audits as accepted suggestions', async () => {
    const supplies = await prisma.category.findFirst({
      where: { name: 'Supplies', isSystem: true },
    });
    const suggested = await createQueueRow(accountId, {
      description: 'ZZBULK SUGGESTED SUPPLIES',
      aiSuggestedCategoryId: supplies?.id ?? null,
      aiConfidence: 0.84,
    });
    const unsuggested = await createQueueRow(accountId, { description: 'ZZBULK NO SUGGESTION' });
    // Looks exactly like Okafor's open rent → carries a rent match → skipped.
    const rentLike = await createQueueRow(accountId, {
      description: 'ZZBULK ACH RENT DEPOSIT',
      type: 'income',
      amountCents: OKAFOR_RENT_CENTS,
      aiSuggestedCategoryId: (
        await prisma.category.findFirst({ where: { name: 'Rent', type: 'income' } })
      )?.id,
      aiConfidence: 0.8,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions/review/confirm-all',
      payload: { q: 'ZZBULK' },
    });
    expect(res.statusCode).toBe(200);
    const result = ConfirmAllReviewResponseSchema.parse(res.json());
    expect(result).toEqual({ confirmed: 1, skipped: 2 });

    const confirmedRow = await prisma.transaction.findUniqueOrThrow({
      where: { id: suggested.id },
    });
    expect(confirmedRow.status).toBe('confirmed');
    expect(confirmedRow.categoryId).toBe(supplies?.id);
    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'transaction.confirmed', entityId: suggested.id },
    });
    expect(audit?.actor).toBe('ai_suggested_user_confirmed');

    // Skipped rows stay pending; the rent payment is untouched.
    for (const id of [unsuggested.id, rentLike.id]) {
      const row = await prisma.transaction.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('pending_review');
    }
    const payment = await okaforPayment();
    expect(payment.status).toBe('due');
  });
});

describe('POST /transactions/:id/dismiss and /review/dismiss-all', () => {
  let accountId: string;

  beforeAll(async () => {
    accountId = await getDemoAccountId();
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { accountId, entityId: { in: createdIds } } });
  });

  it('dismisses a pending item, audits it, and drops it from the queue without deleting it', async () => {
    const row = await createQueueRow(accountId, { description: 'ZZDISMISS ONE' });

    const res = await app.inject({ method: 'POST', url: `/api/v1/transactions/${row.id}/dismiss` });
    expect(res.statusCode).toBe(200);
    const dismissed = TransactionSchema.parse(res.json());
    expect(dismissed.status).toBe('dismissed');

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'transaction.dismissed', entityId: row.id },
    });
    expect(audit?.actor).toBe('user');

    const queue = ReviewQueueResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/transactions/review?q=zzdismiss+one' })).json(),
    );
    expect(queue.total).toBe(0);
    expect(await prisma.transaction.findUnique({ where: { id: row.id } })).not.toBeNull();
  });

  it('rejects dismissing an already-dismissed (non-pending) transaction', async () => {
    const row = await createQueueRow(accountId, {
      description: 'ZZDISMISS TWICE',
      status: 'dismissed',
    });
    const res = await app.inject({ method: 'POST', url: `/api/v1/transactions/${row.id}/dismiss` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/pending-review/);
  });

  it('dismiss-all dismisses exactly the filtered set', async () => {
    const a = await createQueueRow(accountId, { description: 'ZZDISMISSALL A' });
    const b = await createQueueRow(accountId, { description: 'ZZDISMISSALL B', type: 'income' });
    const outside = await createQueueRow(accountId, { description: 'ZZKEEP OUTSIDE FILTER' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions/review/dismiss-all',
      payload: { q: 'ZZDISMISSALL' },
    });
    expect(res.statusCode).toBe(200);
    expect(DismissAllReviewResponseSchema.parse(res.json())).toEqual({ dismissed: 2 });

    for (const id of [a.id, b.id]) {
      const row = await prisma.transaction.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('dismissed');
    }
    const untouched = await prisma.transaction.findUniqueOrThrow({ where: { id: outside.id } });
    expect(untouched.status).toBe('pending_review');
  });
});

describe('POST /transactions/:id/restore', () => {
  let accountId: string;

  beforeAll(async () => {
    accountId = await getDemoAccountId();
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { accountId, entityId: { in: createdIds } } });
  });

  it('puts a dismissed transaction back into pending_review and audit-logs it', async () => {
    const row = await createQueueRow(accountId, {
      description: 'ZZRESTORE DISMISSED',
      status: 'dismissed',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${row.id}/restore`,
    });
    expect(res.statusCode).toBe(200);
    const restored = TransactionSchema.parse(res.json());
    expect(restored.status).toBe('pending_review');

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'transaction.restored', entityId: row.id },
    });
    expect(audit?.actor).toBe('user');
    expect(JSON.parse(audit!.detailJson!)).toEqual({
      source: row.source,
      amountCents: row.amountCents,
      vendor: row.vendor,
    });
  });

  it('rejects restoring a confirmed transaction', async () => {
    const row = await createQueueRow(accountId, {
      description: 'ZZRESTORE CONFIRMED',
      status: 'confirmed',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${row.id}/restore`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/dismissed/);
  });

  it('rejects restoring a still pending-review transaction', async () => {
    const row = await createQueueRow(accountId, { description: 'ZZRESTORE PENDING' }); // default pending_review
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${row.id}/restore`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/dismissed/);
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

describe('POST /transactions/import', () => {
  it('parses the shared schema on 200 and returns the rate-limit envelope on 429', async () => {
    const accountId = await getDemoAccountId();
    // The seeded demo Plaid row is status 'mock'; capture it so every field
    // this test mutates (status, config, lastSyncedAt) is restored verbatim.
    const originalPlaid = await prisma.integration.findFirstOrThrow({
      where: { accountId, type: 'plaid' },
    });

    try {
      const first = await app.inject({ method: 'POST', url: '/api/v1/transactions/import' });
      expect(first.statusCode).toBe(200);
      expect(ImportTransactionsResponseSchema.parse(first.json())).toEqual({
        imported: 4,
        skipped: 0,
        updated: 0,
        removed: 0,
      });

      // Connect the row so the cooldown has a connected Plaid item (plus the
      // lastSyncedAt just stamped by the import above) to gate on.
      await exchangePublicToken(accountId, 'mock-public-token');
      process.env.HEARTH_IMPORT_COOLDOWN_MINUTES = '60';

      const second = await app.inject({ method: 'POST', url: '/api/v1/transactions/import' });
      expect(second.statusCode).toBe(429);
      const body = ApiErrorSchema.parse(second.json());
      expect(body.error.code).toBe('import_rate_limited');
      expect(body.error.detail?.nextAllowedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      delete process.env.HEARTH_IMPORT_COOLDOWN_MINUTES;
      await prisma.integration.update({
        where: { id: originalPlaid.id },
        data: {
          status: originalPlaid.status,
          externalRef: originalPlaid.externalRef,
          configJson: originalPlaid.configJson,
          lastSyncedAt: originalPlaid.lastSyncedAt,
        },
      });
      // Keep the seeded ledger pristine for the pinned-figure tests.
      await prisma.transaction.deleteMany({
        where: { accountId, externalId: { startsWith: 'plaid_mock_' } },
      });
    }
  });
});
