// Workstream D of TRUSTWORTHY_TRANSACTIONS_PLAN.md: transaction
// classification (transfers/owner money leave P&L, refunds net against their
// expense category), the bulk-confirm confidence gate, and content-fingerprint
// duplicate detection. Every row this file creates is deleted again so pinned
// seed figures stay intact.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ConfirmAllReviewResponseSchema, ReviewQueueResponseSchema } from '@hearth/shared';
import { PARK_NAME, PARK_RENT_CENTS } from '../../prisma/seed-constants';
import { buildApp } from '../app';
import { addDays, currentPeriod, iso, monthEndExclusive, monthStart } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import * as dashboardService from '../services/dashboard.service';
import * as rentService from '../services/rent.service';

let app: FastifyInstance;
let accountId: string;
const createdIds: string[] = [];
const period = currentPeriod();
// A distinctive amount no seed row uses, so duplicate detection in other
// tests never sees these rows.
const ODD_CENTS = 987651;

async function createRow(over: Record<string, unknown> = {}) {
  const row = await prisma.transaction.create({
    data: {
      accountId,
      date: new Date(),
      amountCents: ODD_CENTS,
      type: 'expense',
      description: 'ZZCLASS TEST ROW',
      source: 'manual',
      status: 'confirmed',
      ...over,
    },
  });
  createdIds.push(row.id);
  return row;
}

beforeAll(async () => {
  app = await buildApp();
  accountId = await getDemoAccountId();
});

afterAll(async () => {
  await prisma.transaction.deleteMany({ where: { id: { in: createdIds } } });
  await prisma.auditLog.deleteMany({ where: { accountId, entityId: { in: createdIds } } });
  await app.close();
});

describe('classification semantics in aggregates', () => {
  it('a transfer leaves every P&L surface; a refund nets against its expense category', async () => {
    const repairs = await prisma.category.findFirstOrThrow({
      where: { name: 'Repairs', type: 'expense', isSystem: true },
    });
    const before = await dashboardService.getKpis(accountId);

    // Transfer-classified income: must move nothing.
    await createRow({
      type: 'income',
      classification: 'transfer',
      description: 'ZZCLASS TRANSFER IN',
    });
    const afterTransfer = await dashboardService.getKpis(accountId);
    expect(afterTransfer.netCashFlowMtdCents).toBe(before.netCashFlowMtdCents);
    expect(afterTransfer.expensesMtdCents).toBe(before.expensesMtdCents);

    // A refund on Repairs: expenses drop by the refund, net rises accordingly.
    await createRow({
      type: 'income',
      classification: 'refund',
      categoryId: repairs.id,
      amountCents: 5000,
      description: 'ZZCLASS REPAIRS REFUND',
    });
    const afterRefund = await dashboardService.getKpis(accountId);
    expect(afterRefund.expensesMtdCents).toBe(before.expensesMtdCents - 5000);
    expect(afterRefund.netCashFlowMtdCents).toBe(before.netCashFlowMtdCents + 5000);

    // The P&L report shows the same: income untouched, Repairs line netted.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/reports/generate',
      payload: {
        type: 'pnl',
        from: iso(monthStart(period)),
        to: iso(monthEndExclusive(period)),
      },
    });
    expect(res.statusCode).toBe(201);
    const reportId = res.json().id as string;
    const row = await prisma.report.findUniqueOrThrow({ where: { id: reportId } });
    const data = JSON.parse(row.dataJson) as {
      totals: { incomeCents: number; expenseCents: number };
    };
    expect(data.totals.expenseCents).toBe(before.expensesMtdCents - 5000);
    await prisma.report.delete({ where: { id: reportId } });
    await prisma.auditLog.deleteMany({ where: { accountId, entityId: reportId } });
  });

  it('rejects classifying an expense as a refund', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      payload: {
        date: iso(new Date()),
        amountCents: 1000,
        type: 'expense',
        description: 'ZZCLASS BAD REFUND',
        classification: 'refund',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/income transaction/);
  });

  it('blocks reclassifying a rent-backing deposit', async () => {
    const tracker = await rentService.getMonthStatus(accountId, period);
    const park = tracker.rows.find((r) => r.tenantName === PARK_NAME)!;
    const paid = await rentService.recordPayment(accountId, {
      leaseId: park.leaseId,
      period,
      amountCents: PARK_RENT_CENTS,
      method: 'manual',
    });
    const ledgerTxnId = paid.transactionId as string;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/transactions/${ledgerTxnId}`,
      payload: { classification: 'transfer' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/backs a recorded rent payment/);

    // Restore Park to unpaid for later files (delete cascades the deposit).
    await prisma.transaction.delete({ where: { id: ledgerTxnId } });
    await prisma.rentPayment.update({
      where: { id: park.rentPaymentId },
      data: {
        status: 'due',
        method: null,
        paidAt: null,
        externalRef: null,
        transactionId: null,
        paidCents: 0,
      },
    });
    await prisma.auditLog.deleteMany({
      where: { accountId, entityId: { in: [park.rentPaymentId, ledgerTxnId] } },
    });
  });
});

describe('bulk-confirm confidence gate (plan §D1)', () => {
  it('skips the low-confidence income fallback and sub-threshold suggestions', async () => {
    // The income fallback ("Rent") now sits below the gate by design.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      payload: {
        date: iso(new Date()),
        amountCents: ODD_CENTS + 7,
        type: 'income',
        description: 'ZZGATE laundry income',
        vendor: 'CoinWash',
      },
    });
    const txn = res.json();
    createdIds.push(txn.id);
    expect(txn.aiConfidence).toBe(0.5); // dropped fallback confidence
    // Flip it to pending so bulk confirm sees it.
    await prisma.transaction.update({ where: { id: txn.id }, data: { status: 'pending_review' } });

    const bulk = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions/review/confirm-all',
      payload: { q: 'ZZGATE' },
    });
    const result = ConfirmAllReviewResponseSchema.parse(bulk.json());
    expect(result).toEqual({ confirmed: 0, skipped: 1 });
    const fresh = await prisma.transaction.findUniqueOrThrow({ where: { id: txn.id } });
    expect(fresh.status).toBe('pending_review'); // left for a human eye
  });
});

describe('duplicate detection (plan §D2)', () => {
  it('flags a pending bank row matching a confirmed manual entry; bulk confirm skips it', async () => {
    const supplies = await prisma.category.findFirstOrThrow({
      where: { name: 'Supplies', type: 'expense', isSystem: true },
    });
    // The hand-logged original (no vendor — typical manual entry)…
    const original = await createRow({
      amountCents: ODD_CENTS + 100,
      date: addDays(new Date(), -1),
      description: 'ZZDUP hardware run (logged by hand)',
      categoryId: supplies.id,
    });
    // …and the same money arriving from the bank feed two days later.
    const pending = await createRow({
      amountCents: ODD_CENTS + 100,
      date: new Date(),
      description: 'ZZDUP HD SUPPLY #443',
      vendor: 'HD Supply',
      source: 'bank',
      status: 'pending_review',
      aiSuggestedCategoryId: supplies.id,
      aiConfidence: 0.84,
    });

    const queue = ReviewQueueResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/transactions/review?q=ZZDUP' })).json(),
    );
    const item = queue.items.find((i) => i.id === pending.id);
    expect(item?.possibleDuplicate).toMatchObject({
      transactionId: original.id,
      source: 'manual',
    });
    expect(item?.possibleDuplicate?.rentPeriod).toBeUndefined();

    // Bulk confirm leaves it pending despite the 0.84 suggestion.
    const bulk = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions/review/confirm-all',
      payload: { q: 'ZZDUP' },
    });
    expect(ConfirmAllReviewResponseSchema.parse(bulk.json())).toEqual({
      confirmed: 0,
      skipped: 1,
    });

    // A different amount is not flagged.
    const unrelated = await createRow({
      amountCents: ODD_CENTS + 999,
      description: 'ZZDUP different money',
      source: 'bank',
      status: 'pending_review',
    });
    const queue2 = ReviewQueueResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/transactions/review?q=ZZDUP' })).json(),
    );
    expect(queue2.items.find((i) => i.id === unrelated.id)?.possibleDuplicate).toBeUndefined();
  });

  it('labels the rent-specific case: a bank income matching the manual deposit behind a paid charge', async () => {
    const tracker = await rentService.getMonthStatus(accountId, period);
    const park = tracker.rows.find((r) => r.tenantName === PARK_NAME)!;
    const paid = await rentService.recordPayment(accountId, {
      leaseId: park.leaseId,
      period,
      amountCents: PARK_RENT_CENTS,
      method: 'manual',
    });
    const ledgerTxnId = paid.transactionId as string;

    // The same rent arriving via the bank feed a day later: the charge is
    // already fully paid, so no rent match — but it IS a likely duplicate.
    const bankDeposit = await createRow({
      type: 'income',
      amountCents: PARK_RENT_CENTS,
      date: new Date(),
      description: 'ZZRENTDUP ACH CREDIT',
      source: 'bank',
      status: 'pending_review',
    });
    const queue = ReviewQueueResponseSchema.parse(
      (
        await app.inject({ method: 'GET', url: '/api/v1/transactions/review?q=ZZRENTDUP' })
      ).json(),
    );
    const item = queue.items.find((i) => i.id === bankDeposit.id);
    expect(item?.rentMatch).toBeNull();
    expect(item?.possibleDuplicate).toMatchObject({
      transactionId: ledgerTxnId,
      rentPeriod: period,
    });

    // Restore Park to unpaid for later files.
    await prisma.transaction.delete({ where: { id: ledgerTxnId } });
    await prisma.rentPayment.update({
      where: { id: park.rentPaymentId },
      data: {
        status: 'due',
        method: null,
        paidAt: null,
        externalRef: null,
        transactionId: null,
        paidCents: 0,
      },
    });
    await prisma.auditLog.deleteMany({
      where: { accountId, entityId: { in: [park.rentPaymentId, ledgerTxnId] } },
    });
  });
});
