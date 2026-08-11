// Mortgage-payment semantics — PLAN-REAL-EQUITY §3 and Phase 2 item 4.
//
// A mortgage payment is ONE ledger row per bank debit carrying an integer
// `principalCents` carve-out (never two or three rows: the feed delivers one
// debit and both @@unique([accountId, externalId]) and the duplicate
// fingerprint assume 1:1). This file covers the write/validation half:
//   - the §3 validation rules, enforced in the SERVICE (chat and MCP compose
//     their own input shapes, so a route-only guard is bypassable)
//   - the split invariant: lines sum to amountCents − (principalCents ?? 0)
//   - the confirm path (breakdown at review time, Mortgage-Interest default)
//   - inert vendor↔lender detection per decision D4: it stamps `mortgageId` so
//     the UI knows to *offer* the breakdown editor and never fills in a number
//
// Deliberately asserts persisted row state and thrown errors only — what the
// carve-out does to P&L/KPIs/reports belongs with the lib/pnl.ts change.
// Every row created here is deleted again so pinned seed figures hold.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TransactionSchema, formatUsd } from '@hearth/shared';
import { buildApp } from '../app';
import { addDays, currentPeriod, iso, monthStart } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import * as integrationService from '../services/integration.service';
import * as leaseService from '../services/lease.service';
import * as mortgageService from '../services/mortgage.service';
import * as rentService from '../services/rent.service';
import * as tenantService from '../services/tenant.service';
import * as transactionService from '../services/transaction.service';

const API = '/api/v1';

// $2,400 debit = $800 principal + $1,600 categorizable remainder.
const PAYMENT_CENTS = 240_000;
const PRINCIPAL_CENTS = 80_000;
const REMAINDER_CENTS = PAYMENT_CENTS - PRINCIPAL_CENTS;

const EMAIL_SUFFIX = '@mortgagepaytest.example';
const LENDER = 'ZZMort Principal Savings Bank';
const SECOND_LENDER = 'ZZMort Second Lien Credit Union';

let app: FastifyInstance;
let accountId: string;
let propertyId: string;
let mortgageId: string;
let secondMortgageId: string;
let mortgageInterestId: string;
let propertyTaxesId: string;
let insuranceId: string;
let suppliesId: string;
let rentIncomeId: string;

const createdTxnIds: string[] = [];

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `${API}${url}`, payload: payload as never });
}

/** A row owned by this suite (tracked for cleanup). */
async function row(over: Record<string, unknown> = {}) {
  const created = await prisma.transaction.create({
    data: {
      accountId,
      date: new Date(),
      amountCents: PAYMENT_CENTS,
      type: 'expense',
      description: 'ZZMORT payment fixture',
      source: 'manual',
      status: 'confirmed',
      ...over,
    },
  });
  createdTxnIds.push(created.id);
  return created;
}

const pendingRow = (over: Record<string, unknown> = {}) =>
  row({ status: 'pending_review', source: 'bank', ...over });

/** POST /transactions body with this suite's defaults. */
function createBody(over: Record<string, unknown> = {}) {
  return {
    date: iso(new Date()),
    amountCents: PAYMENT_CENTS,
    type: 'expense',
    description: 'ZZMORT created payment',
    ...over,
  };
}

beforeAll(async () => {
  app = await buildApp();
  accountId = await getDemoAccountId();
  const property = await prisma.property.create({
    data: { accountId, addressLine1: 'ZZMORT 5 Principal Way', city: 'X', state: 'CA', zip: '00000' },
  });
  propertyId = property.id;
  const [primary, second] = await Promise.all([
    prisma.mortgage.create({
      data: {
        accountId,
        propertyId,
        lender: LENDER,
        balanceCents: 20_000_000,
        balanceAsOfDate: new Date('2026-01-01'),
      },
    }),
    prisma.mortgage.create({
      data: {
        accountId,
        propertyId,
        lender: SECOND_LENDER,
        balanceCents: 3_000_000,
        balanceAsOfDate: new Date('2026-01-01'),
      },
    }),
  ]);
  mortgageId = primary.id;
  secondMortgageId = second.id;

  const named = async (name: string, type: 'income' | 'expense') =>
    (await prisma.category.findFirstOrThrow({ where: { name, type, isSystem: true } })).id;
  mortgageInterestId = await named('Mortgage Interest', 'expense');
  propertyTaxesId = await named('Property Taxes', 'expense');
  insuranceId = await named('Insurance', 'expense');
  suppliesId = await named('Supplies', 'expense');
  rentIncomeId = await named('Rent', 'income');
});

afterAll(async () => {
  await prisma.transaction.deleteMany({ where: { id: { in: createdTxnIds } } });
  await prisma.transaction.deleteMany({ where: { accountId, description: { startsWith: 'ZZMORT' } } });
  await prisma.auditLog.deleteMany({ where: { accountId, entityId: { in: createdTxnIds } } });
  await prisma.property.delete({ where: { id: propertyId } }); // cascades the mortgages
  await app.close();
});

describe('create — the breakdown rules hold in the service, not just the route schema', () => {
  it('persists mortgageId + principalCents, and the row keeps the whole debit as its amount', async () => {
    const res = await inject(
      'POST',
      '/transactions',
      createBody({
        vendor: 'ZZMort Unmatched Vendor',
        categoryId: mortgageInterestId,
        mortgageId,
        principalCents: PRINCIPAL_CENTS,
      }),
    );
    expect(res.statusCode).toBe(201);
    const txn = TransactionSchema.parse(res.json());
    createdTxnIds.push(txn.id);
    expect(txn.amountCents).toBe(PAYMENT_CENTS); // one row per debit, never split into components
    expect(txn.mortgageId).toBe(mortgageId);
    expect(txn.principalCents).toBe(PRINCIPAL_CENTS);

    const stored = await prisma.transaction.findUniqueOrThrow({ where: { id: txn.id } });
    expect(stored.principalCents).toBe(PRINCIPAL_CENTS);
    expect(stored.mortgageId).toBe(mortgageId);
  });

  it('rejects a principal amount with no mortgageId (the route schema allows the pair to be partial)', async () => {
    const res = await inject(
      'POST',
      '/transactions',
      createBody({ principalCents: PRINCIPAL_CENTS, description: 'ZZMORT orphan principal' }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/mortgageId/);
    expect(
      await prisma.transaction.count({ where: { accountId, description: 'ZZMORT orphan principal' } }),
    ).toBe(0);
  });

  it('rejects a principal amount on an income row', async () => {
    const res = await inject(
      'POST',
      '/transactions',
      createBody({ type: 'income', mortgageId, principalCents: PRINCIPAL_CENTS }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/expense/);
  });

  it('rejects a principal larger than the payment, and a negative one', async () => {
    const tooBig = await inject(
      'POST',
      '/transactions',
      createBody({ mortgageId, principalCents: PAYMENT_CENTS + 1 }),
    );
    expect(tooBig.statusCode).toBe(400);
    expect(tooBig.json().error.message).toContain(formatUsd(PAYMENT_CENTS));

    // Negative never reaches the route (Zod), so prove the service refuses it
    // too — chat/MCP tools build their own inputs.
    await expect(
      transactionService.create(accountId, {
        ...createBody({ mortgageId, principalCents: -1 }),
        type: 'expense',
      } as never),
    ).rejects.toThrow(/principal portion must be between/);
  });

  it('rejects a principal amount together with a classification', async () => {
    const res = await inject(
      'POST',
      '/transactions',
      createBody({ mortgageId, principalCents: PRINCIPAL_CENTS, classification: 'transfer' }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/transfer/);
  });

  it('accepts principalCents === amountCents — a principal-only payment is legal', async () => {
    const res = await inject(
      'POST',
      '/transactions',
      createBody({ mortgageId, principalCents: PAYMENT_CENTS, description: 'ZZMORT principal-only' }),
    );
    expect(res.statusCode).toBe(201);
    const txn = TransactionSchema.parse(res.json());
    createdTxnIds.push(txn.id);
    expect(txn.principalCents).toBe(PAYMENT_CENTS);
  });

  it("rejects another account's mortgageId and writes nothing", async () => {
    const other = await prisma.account.create({
      data: { name: 'ZZMort Other Co', email: 'other@mortgagepayments.example' },
    });
    const otherProperty = await prisma.property.create({
      data: { accountId: other.id, addressLine1: '9 Elsewhere St', city: 'X', state: 'CA', zip: '00000' },
    });
    const foreign = await prisma.mortgage.create({
      data: {
        accountId: other.id,
        propertyId: otherProperty.id,
        lender: 'Foreign Bank',
        balanceCents: 5_000_000,
        balanceAsOfDate: new Date('2026-01-01'),
      },
    });

    const res = await inject(
      'POST',
      '/transactions',
      createBody({
        mortgageId: foreign.id,
        principalCents: PRINCIPAL_CENTS,
        description: 'ZZMORT foreign mortgage',
      }),
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    expect(
      await prisma.transaction.count({ where: { accountId, description: 'ZZMORT foreign mortgage' } }),
    ).toBe(0);

    await prisma.account.delete({ where: { id: other.id } });
  });
});

describe('update — the breakdown revalidates against the row’s final state', () => {
  it('refuses an amount edit that drops below the stored principal, and allows one above it', async () => {
    const payment = await row({ categoryId: mortgageInterestId, mortgageId, principalCents: PRINCIPAL_CENTS });

    const tooLow = await inject('PATCH', `/transactions/${payment.id}`, {
      amountCents: PRINCIPAL_CENTS - 1,
    });
    expect(tooLow.statusCode).toBe(400);
    expect(tooLow.json().error.message).toMatch(/principal portion must be between/);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: payment.id } })).amountCents).toBe(
      PAYMENT_CENTS,
    );

    const ok = await inject('PATCH', `/transactions/${payment.id}`, { amountCents: 300_000 });
    expect(ok.statusCode).toBe(200);
    expect(TransactionSchema.parse(ok.json()).principalCents).toBe(PRINCIPAL_CENTS);
  });

  it('rewrites the carve-out on its own and records both figures in the audit trail', async () => {
    const payment = await row({ categoryId: mortgageInterestId, mortgageId, principalCents: PRINCIPAL_CENTS });
    const res = await inject('PATCH', `/transactions/${payment.id}`, { principalCents: 90_000 });
    expect(res.statusCode).toBe(200);
    expect(TransactionSchema.parse(res.json()).principalCents).toBe(90_000);

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'transaction.updated', entityId: payment.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(JSON.parse(audit!.detailJson!)).toMatchObject({
      priorPrincipalCents: PRINCIPAL_CENTS,
      principalCents: 90_000,
      mortgageId,
    });
  });

  it('refuses to classify a principal-bearing row, and refuses a foreign mortgageId', async () => {
    const payment = await row({ categoryId: mortgageInterestId, mortgageId, principalCents: PRINCIPAL_CENTS });

    const classified = await inject('PATCH', `/transactions/${payment.id}`, { classification: 'transfer' });
    expect(classified.statusCode).toBe(400);
    expect(classified.json().error.message).toMatch(/transfer/);

    const foreign = await inject('PATCH', `/transactions/${payment.id}`, { mortgageId: 'mortgage_nope' });
    expect(foreign.statusCode).toBe(404);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: payment.id } })).mortgageId).toBe(
      mortgageId,
    );
  });
});

describe('split invariant — the lines describe the amount less the principal', () => {
  it('rejects splits that sum to the full debit and names the carve-out in the message', async () => {
    const payment = await row({ categoryId: null, mortgageId, principalCents: PRINCIPAL_CENTS });
    const res = await inject('PATCH', `/transactions/${payment.id}`, {
      splits: [
        { categoryId: mortgageInterestId, amountCents: 110_000 },
        { categoryId: propertyTaxesId, amountCents: 130_000 },
      ],
    });
    expect(res.statusCode).toBe(400);
    const { message } = res.json().error;
    expect(message).toMatch(/add up to the transaction amount/);
    expect(message).toContain(formatUsd(REMAINDER_CENTS)); // what they must sum to
    expect(message).toContain(formatUsd(PRINCIPAL_CENTS)); // why it isn't the debit
    expect(await prisma.transactionSplit.count({ where: { transactionId: payment.id } })).toBe(0);
  });

  it('accepts splits that sum to the remainder, clearing the parent category and keeping the principal', async () => {
    const payment = await row({ categoryId: mortgageInterestId, mortgageId, principalCents: PRINCIPAL_CENTS });
    const res = await inject('PATCH', `/transactions/${payment.id}`, {
      splits: [
        { categoryId: mortgageInterestId, amountCents: 110_000 },
        { categoryId: propertyTaxesId, amountCents: 35_000 },
        { categoryId: insuranceId, amountCents: 15_000 },
      ],
    });
    expect(res.statusCode).toBe(200);
    const txn = TransactionSchema.parse(res.json());
    expect(txn.categoryId).toBeNull(); // the splits ARE the categorization
    expect(txn.splits!.reduce((sum, s) => sum + s.amountCents, 0)).toBe(REMAINDER_CENTS);
    expect(txn.amountCents).toBe(PAYMENT_CENTS);
    expect(txn.principalCents).toBe(PRINCIPAL_CENTS);
  });

  it('still requires an ordinary row’s splits to sum to its full amount', async () => {
    const ordinary = await row({ categoryId: suppliesId, description: 'ZZMORT ordinary expense' });
    const mismatch = await inject('PATCH', `/transactions/${ordinary.id}`, {
      splits: [
        { categoryId: suppliesId, amountCents: 110_000 },
        { categoryId: propertyTaxesId, amountCents: 100_000 },
      ],
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.message).toMatch(/add up to the transaction amount —/);
    expect(mismatch.json().error.message).not.toMatch(/principal/);

    const exact = await inject('PATCH', `/transactions/${ordinary.id}`, {
      splits: [
        { categoryId: suppliesId, amountCents: 140_000 },
        { categoryId: propertyTaxesId, amountCents: 100_000 },
      ],
    });
    expect(exact.statusCode).toBe(200);
    expect(TransactionSchema.parse(exact.json()).splits).toHaveLength(2);
  });

  it('refuses to move the principal of a split row without new lines', async () => {
    const payment = await row({ categoryId: null, mortgageId, principalCents: PRINCIPAL_CENTS });
    await inject('PATCH', `/transactions/${payment.id}`, {
      splits: [
        { categoryId: mortgageInterestId, amountCents: 120_000 },
        { categoryId: insuranceId, amountCents: 40_000 },
      ],
    });

    const stale = await inject('PATCH', `/transactions/${payment.id}`, { principalCents: 70_000 });
    expect(stale.statusCode).toBe(400);
    expect(stale.json().error.message).toMatch(/principal portion/);

    const together = await inject('PATCH', `/transactions/${payment.id}`, {
      principalCents: 70_000,
      splits: [
        { categoryId: mortgageInterestId, amountCents: 130_000 },
        { categoryId: insuranceId, amountCents: 40_000 },
      ],
    });
    expect(together.statusCode).toBe(200);
    expect(TransactionSchema.parse(together.json()).principalCents).toBe(70_000);
  });
});

describe('confirm — the breakdown is entered at review time', () => {
  it('defaults the remainder to the seeded Mortgage Interest category over the AI guess', async () => {
    const pending = await pendingRow({ aiSuggestedCategoryId: suppliesId, aiConfidence: 0.62 });
    const res = await inject('POST', `/transactions/${pending.id}/confirm`, {
      mortgageId,
      principalCents: PRINCIPAL_CENTS,
    });
    expect(res.statusCode).toBe(200);
    const txn = TransactionSchema.parse(res.json());
    expect(txn.status).toBe('confirmed');
    expect(txn.categoryId).toBe(mortgageInterestId); // not the 'Supplies' fallback
    expect(txn.principalCents).toBe(PRINCIPAL_CENTS);
    expect(txn.mortgageId).toBe(mortgageId);

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'transaction.confirmed', entityId: pending.id },
    });
    expect(audit?.actor).toBe('user'); // the default is not an AI suggestion the user accepted
    expect(JSON.parse(audit!.detailJson!)).toMatchObject({
      principalCents: PRINCIPAL_CENTS,
      mortgageId,
    });
  });

  it('lets an explicit category win over the default', async () => {
    const pending = await pendingRow();
    const res = await inject('POST', `/transactions/${pending.id}/confirm`, {
      mortgageId,
      principalCents: PRINCIPAL_CENTS,
      categoryId: propertyTaxesId,
    });
    expect(res.statusCode).toBe(200);
    expect(TransactionSchema.parse(res.json()).categoryId).toBe(propertyTaxesId);
  });

  it('confirms with splits over the remainder, and rejects splits over the full debit', async () => {
    const bad = await pendingRow();
    const badRes = await inject('POST', `/transactions/${bad.id}/confirm`, {
      mortgageId,
      principalCents: PRINCIPAL_CENTS,
      splits: [
        { categoryId: mortgageInterestId, amountCents: 200_000 },
        { categoryId: insuranceId, amountCents: 40_000 },
      ],
    });
    expect(badRes.statusCode).toBe(400);
    expect(badRes.json().error.message).toContain(formatUsd(REMAINDER_CENTS));
    // Nothing applied: the row is still waiting for review.
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: bad.id } })).status).toBe(
      'pending_review',
    );

    const good = await pendingRow();
    const goodRes = await inject('POST', `/transactions/${good.id}/confirm`, {
      mortgageId,
      principalCents: PRINCIPAL_CENTS,
      splits: [
        { categoryId: mortgageInterestId, amountCents: 120_000 },
        { categoryId: propertyTaxesId, amountCents: 25_000 },
        { categoryId: insuranceId, amountCents: 15_000 },
      ],
    });
    expect(goodRes.statusCode).toBe(200);
    const txn = TransactionSchema.parse(goodRes.json());
    expect(txn.status).toBe('confirmed');
    expect(txn.categoryId).toBeNull();
    expect(txn.splits!.reduce((sum, s) => sum + s.amountCents, 0)).toBe(REMAINDER_CENTS);
    expect(txn.principalCents).toBe(PRINCIPAL_CENTS);
  });

  it('confirms a principal-only payment with nothing to categorize', async () => {
    const pending = await pendingRow();
    const res = await inject('POST', `/transactions/${pending.id}/confirm`, {
      mortgageId,
      principalCents: PAYMENT_CENTS,
    });
    expect(res.statusCode).toBe(200);
    const txn = TransactionSchema.parse(res.json());
    expect(txn.principalCents).toBe(PAYMENT_CENTS);
    expect(txn.categoryId).toBeNull(); // no remainder, so no category is invented
  });

  it("404s a foreign mortgageId and leaves the row pending", async () => {
    const pending = await pendingRow();
    const res = await inject('POST', `/transactions/${pending.id}/confirm`, {
      mortgageId: 'mortgage_nope',
      principalCents: PRINCIPAL_CENTS,
    });
    expect(res.statusCode).toBe(404);
    const stored = await prisma.transaction.findUniqueOrThrow({ where: { id: pending.id } });
    expect(stored.status).toBe('pending_review');
    expect(stored.mortgageId).toBeNull();
  });
});

describe('rent links and principal are mutually exclusive', () => {
  let rentPropertyId: string;
  let leaseAId: string;
  let leaseBId: string;
  let tenantId: string;
  let linkedTxnId: string;
  let openRentPaymentId: string;
  let openRentCents: number;

  beforeAll(async () => {
    const property = await prisma.property.create({
      data: {
        accountId,
        addressLine1: 'ZZMORT 7 Rentlink Rd',
        city: 'X',
        state: 'CA',
        zip: '00000',
        units: { create: [{ label: 'A' }, { label: 'B' }] },
      },
      include: { units: true },
    });
    rentPropertyId = property.id;
    const [unitA, unitB] = [...property.units].sort((a, b) => a.label.localeCompare(b.label));
    const tenant = await tenantService.create(accountId, { fullName: 'ZZMort Rentlink Tenant' });
    tenantId = tenant.id;

    const period = currentPeriod();
    const periodStart = monthStart(period);
    const leaseDates = {
      startDate: iso(addDays(periodStart, -365)),
      endDate: iso(addDays(periodStart, 365)),
      dueDay: 1,
    };
    const leaseA = await leaseService.create(accountId, {
      unitId: unitA!.id,
      tenantIds: [tenantId],
      rentCents: 120_000,
      ...leaseDates,
    });
    leaseAId = leaseA.id;
    const leaseB = await leaseService.create(accountId, {
      unitId: unitB!.id,
      tenantIds: [tenantId],
      rentCents: 130_000,
      ...leaseDates,
    });
    leaseBId = leaseB.id;

    // Lease A: a recorded payment (its ledger row is rent-linked).
    const paid = await rentService.recordPayment(accountId, {
      leaseId: leaseAId,
      period,
      amountCents: 120_000,
      method: 'manual',
    });
    linkedTxnId = paid.transactionId!;
    createdTxnIds.push(linkedTxnId);

    // Lease B: an open expected charge for a deposit to be linked against.
    await rentService.materializeExpectedPayments(accountId, period);
    const open = await prisma.rentPayment.findFirstOrThrow({ where: { leaseId: leaseBId, period } });
    openRentPaymentId = open.id;
    openRentCents = open.amountCents;
  });

  afterAll(async () => {
    await prisma.rentPayment.deleteMany({ where: { leaseId: { in: [leaseAId, leaseBId] } } });
    await prisma.lease.deleteMany({ where: { id: { in: [leaseAId, leaseBId] } } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.property.delete({ where: { id: rentPropertyId } });
    await prisma.auditLog.deleteMany({
      where: { accountId, entityId: { in: [rentPropertyId, leaseAId, leaseBId, tenantId] } },
    });
  });

  it('refuses a principal carve-out on a row backing a recorded rent payment', async () => {
    const res = await inject('PATCH', `/transactions/${linkedTxnId}`, {
      mortgageId,
      principalCents: 10_000,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/rent payment/);
    const stored = await prisma.transaction.findUniqueOrThrow({ where: { id: linkedTxnId } });
    expect(stored.principalCents).toBeNull();
    expect(stored.mortgageId).toBeNull();
  });

  it('refuses a confirm that both links a rent charge and carries a principal portion', async () => {
    const deposit = await row({
      type: 'income',
      amountCents: openRentCents,
      status: 'pending_review',
      source: 'bank',
      description: 'ZZMORT rent deposit',
    });
    const res = await inject('POST', `/transactions/${deposit.id}/confirm`, {
      rentPaymentId: openRentPaymentId,
      mortgageId,
      principalCents: 10_000,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/rent payment/);
    // Neither side applied: no deposit recorded, row still pending.
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: deposit.id } })).status).toBe(
      'pending_review',
    );
    expect((await prisma.rentPayment.findUniqueOrThrow({ where: { id: openRentPaymentId } })).paidCents).toBe(
      0,
    );

    // Without the breakdown the same link goes through — the rejection is about
    // the combination, not the deposit.
    const ok = await inject('POST', `/transactions/${deposit.id}/confirm`, {
      rentPaymentId: openRentPaymentId,
      categoryId: rentIncomeId,
    });
    expect(ok.statusCode).toBe(200);
    expect(TransactionSchema.parse(ok.json()).principalCents).toBeNull();
  });
});

describe('detection (D4) — the vendor↔lender match is inert', () => {
  it('stamps mortgageId on confirm without touching the principal or the categorization', async () => {
    // Case- and whitespace-insensitive, like the contractor match.
    const pending = await pendingRow({
      vendor: `  ${LENDER.toUpperCase()} `,
      aiSuggestedCategoryId: suppliesId,
      aiConfidence: 0.84,
    });
    const res = await inject('POST', `/transactions/${pending.id}/confirm`, {});
    expect(res.statusCode).toBe(200);
    const txn = TransactionSchema.parse(res.json());
    expect(txn.mortgageId).toBe(mortgageId);
    expect(txn.principalCents).toBeNull(); // detection never fills in a number
    expect(txn.categoryId).toBe(suppliesId); // and never re-categorizes
  });

  it('stamps mortgageId on a manually created expense too, leaving principalCents null', async () => {
    const res = await inject(
      'POST',
      '/transactions',
      createBody({ vendor: LENDER.toLowerCase(), categoryId: mortgageInterestId }),
    );
    expect(res.statusCode).toBe(201);
    const txn = TransactionSchema.parse(res.json());
    createdTxnIds.push(txn.id);
    expect(txn.mortgageId).toBe(mortgageId);
    expect(txn.principalCents).toBeNull();
  });

  it('links nothing when two non-archived mortgages share the lender key, and resumes when one is archived', async () => {
    const twin = await prisma.mortgage.create({
      data: {
        accountId,
        propertyId,
        lender: LENDER.toLowerCase(), // same vendorKey → ambiguous
        balanceCents: 1_000_000,
        balanceAsOfDate: new Date('2026-01-01'),
      },
    });

    const ambiguous = await pendingRow({ vendor: LENDER });
    expect(
      TransactionSchema.parse((await inject('POST', `/transactions/${ambiguous.id}/confirm`, {})).json())
        .mortgageId,
    ).toBeNull();

    // Archived mortgages are out of the running, so the pair stops being ambiguous.
    await prisma.mortgage.update({ where: { id: twin.id }, data: { archivedAt: new Date() } });
    const afterArchive = await pendingRow({ vendor: LENDER });
    expect(
      TransactionSchema.parse((await inject('POST', `/transactions/${afterArchive.id}/confirm`, {})).json())
        .mortgageId,
    ).toBe(mortgageId);

    await prisma.mortgage.delete({ where: { id: twin.id } });
  });

  it('lets an explicit mortgageId win over the vendor match', async () => {
    const pending = await pendingRow({ vendor: LENDER });
    const res = await inject('POST', `/transactions/${pending.id}/confirm`, {
      mortgageId: secondMortgageId,
      principalCents: PRINCIPAL_CENTS,
    });
    expect(res.statusCode).toBe(200);
    expect(TransactionSchema.parse(res.json()).mortgageId).toBe(secondMortgageId);
  });

  it('never stamps an income row, whatever its vendor says', async () => {
    const pending = await pendingRow({ type: 'income', vendor: LENDER });
    const res = await inject('POST', `/transactions/${pending.id}/confirm`, {});
    expect(res.statusCode).toBe(200);
    const txn = TransactionSchema.parse(res.json());
    expect(txn.mortgageId).toBeNull();
    expect(txn.principalCents).toBeNull();
  });

  it('stamps a BANK row at import, while it is still pending review', async () => {
    // The whole point of detection: the review-queue card reads `mortgageId` to
    // decide whether to offer the breakdown editor, and a real mortgage payment
    // arrives as a bank row. Detecting only at confirm would mean the editor is
    // never offered where it's actually needed — the user would have to confirm
    // the row first and go back to fix it.
    const account = await prisma.account.create({
      data: { name: 'Mortgage Import Co', email: `mortgage-import${EMAIL_SUFFIX}` },
    });
    const property = await prisma.property.create({
      data: { accountId: account.id, addressLine1: '9 Import Way', city: 'X', state: 'CA', zip: '00000' },
    });
    // The mock Plaid feed's first row is an expense from 'Sherwin-Williams';
    // naming the lender to match is how we exercise the vendor↔lender match
    // through the real import path.
    await prisma.mortgage.create({
      data: {
        accountId: account.id,
        propertyId: property.id,
        lender: 'Sherwin-Williams',
        balanceCents: 5_000_000,
        balanceAsOfDate: new Date('2026-01-01'),
      },
    });
    await integrationService.exchangePublicToken(account.id, 'mock-public-token');
    await transactionService.importFromBank(account.id);

    const imported = await prisma.transaction.findFirstOrThrow({
      where: { accountId: account.id, externalId: 'plaid_mock_1' },
    });
    expect(imported.status).toBe('pending_review');
    expect(imported.mortgageId).not.toBeNull(); // offered before confirm
    expect(imported.principalCents).toBeNull(); // but never guessed

    // Inert: a pending row moves no balance.
    const [mortgage] = await mortgageService.listForProperty(account.id, property.id);
    expect(mortgage?.currentBalanceCents).toBe(5_000_000);

    // A non-matching vendor in the same batch stays unstamped.
    const other = await prisma.transaction.findFirstOrThrow({
      where: { accountId: account.id, externalId: 'plaid_mock_3' },
    });
    expect(other.mortgageId).toBeNull();

    await prisma.account.delete({ where: { id: account.id } });
  });
});
