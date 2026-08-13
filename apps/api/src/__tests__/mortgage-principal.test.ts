// The principal carve-out (PLAN-REAL-EQUITY §3). One mortgage payment is ONE
// ledger row for the whole bank debit, but its `principalCents` slice repays a
// liability instead of buying anything — so every money aggregate must count
// only `amountCents − principalCents`, while the general ledger keeps showing
// the full debit (classification/carve-out changes aggregation, never
// visibility). The same $800 that leaves the P&L is what finally moves the
// mortgage's derived balance.
//
// Fixtures live on throwaway accounts (deleted in afterAll, cascading) so the
// seeded demo portfolio — whose figures are pinned across the suite — is
// untouched: no seeded transaction carries principal, so nothing there moves.
// Rows are written with raw prisma on purpose: this file is about read/
// aggregation semantics, and the write-side validation for principal rows is a
// separate change in transaction.service.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentPeriodInTz, iso, monthEndExclusiveInTz, monthStartInTz } from '../lib/dates';
import { pnlBucket } from '../lib/pnl';
import { prisma } from '../lib/prisma';
import * as dashboardService from '../services/dashboard.service';
import * as mortgageService from '../services/mortgage.service';
import * as propertyService from '../services/property.service';
import * as reportService from '../services/report.service';

const PAYMENT_CENTS = 240_000; // $2,400 bank debit
const PRINCIPAL_CENTS = 80_000; // $800 repays the loan — not an expense
const DEDUCTIBLE_CENTS = 160_000; // $1,600 interest (+escrow) — the only spend
const CHECKPOINT_CENTS = 25_000_000; // $250,000 statement balance
const PENDING_CHECKPOINT_CENTS = 10_000_000;
const SPLIT_INTEREST_CENTS = 110_000; // $1,100 Mortgage Interest
const SPLIT_ESCROW_CENTS = 50_000; // $500 Property Taxes — 1,100 + 500 = 1,600

const LINE_12 = 'Line 12 – Mortgage interest';
const LINE_16 = 'Line 16 – Taxes';

interface PnlSnapshot {
  lines: Array<{ categoryName: string; type: string; totalCents: number }>;
  totals: { incomeCents: number; expenseCents: number; netCents: number };
}
interface LedgerSnapshot {
  rows: Array<{ description: string; categoryName: string | null; amountCents: number }>;
  totals: { incomeCents: number; expenseCents: number; netCents: number; count: number };
}
interface ScheduleESnapshot {
  propertyRows: Array<{
    propertyId: string | null;
    expenseLines: Record<string, number>;
    totalExpensesCents: number;
  }>;
  totals: { totalExpensesCents: number };
}

let tz: string;
let period: string;
let monthStart: Date;
let monthEnd: Date; // exclusive
let paymentDate: Date;
let checkpointDate: Date;

let accountId: string;
let propertyId: string;
let mortgageId: string;
let pendingPropertyId: string;
let pendingMortgageId: string;

let splitAccountId: string;
let splitPropertyId: string;
let splitMortgageId: string;

let interestCategoryId: string;
let taxCategoryId: string;

async function createAccount(name: string, email: string): Promise<string> {
  const account = await prisma.account.create({ data: { name, email } });
  return account.id;
}

async function createProperty(acct: string, addressLine1: string): Promise<string> {
  const property = await prisma.property.create({
    data: {
      accountId: acct,
      addressLine1,
      city: 'Springfield',
      state: 'CA',
      zip: '90000',
      // Needed for a non-null `equity` on the property hub.
      acquisitionCostCents: 30_000_000,
    },
  });
  return property.id;
}

async function createMortgage(
  acct: string,
  propId: string,
  balanceCents: number,
): Promise<string> {
  const mortgage = await prisma.mortgage.create({
    data: {
      accountId: acct,
      propertyId: propId,
      lender: 'First Federal Bank',
      balanceCents,
      balanceAsOfDate: checkpointDate,
    },
  });
  return mortgage.id;
}

async function createPayment(opts: {
  accountId: string;
  propertyId: string;
  mortgageId: string;
  status: 'confirmed' | 'pending_review' | 'dismissed';
  categoryId?: string;
  splits?: Array<{ categoryId: string; amountCents: number }>;
}): Promise<string> {
  const txn = await prisma.transaction.create({
    data: {
      accountId: opts.accountId,
      propertyId: opts.propertyId,
      mortgageId: opts.mortgageId,
      categoryId: opts.categoryId ?? null,
      date: paymentDate,
      amountCents: PAYMENT_CENTS,
      principalCents: PRINCIPAL_CENTS,
      type: 'expense',
      description: 'Mortgage payment',
      vendor: 'First Federal Bank',
      source: 'manual',
      status: opts.status,
      ...(opts.splits ? { splits: { create: opts.splits } } : {}),
    },
  });
  return txn.id;
}

async function pnlSnapshot(acct: string): Promise<PnlSnapshot> {
  const report = await reportService.generate(acct, {
    type: 'pnl',
    from: iso(monthStart),
    to: iso(monthEnd),
  });
  return (await reportService.getById(acct, report.id)).data as PnlSnapshot;
}

beforeAll(async () => {
  accountId = await createAccount('Principal Carveout Co', 'principal-carveout@principaltest.example');
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  tz = account.timezone;
  period = currentPeriodInTz(tz);
  monthStart = monthStartInTz(period, tz);
  monthEnd = monthEndExclusiveInTz(period, tz);
  // The first day of the account-local month: inside the MTD/YTD windows every
  // surface uses, and never in the future (a payment dated after `now` would
  // legitimately not have moved the balance yet).
  paymentDate = monthStart;
  // The checkpoint predates the payment, so the payment is principal paid SINCE
  // the statement and must reduce the derived balance.
  checkpointDate = new Date(monthStart.getTime() - 86_400_000);

  interestCategoryId = (
    await prisma.category.findFirstOrThrow({ where: { name: 'Mortgage Interest', isSystem: true } })
  ).id;
  taxCategoryId = (
    await prisma.category.findFirstOrThrow({ where: { name: 'Property Taxes', isSystem: true } })
  ).id;

  propertyId = await createProperty(accountId, '1 Amortization Way');
  mortgageId = await createMortgage(accountId, propertyId, CHECKPOINT_CENTS);
  await createPayment({
    accountId,
    propertyId,
    mortgageId,
    status: 'confirmed',
    categoryId: interestCategoryId,
  });

  // Second property on the SAME account: an unconfirmed payment, so the
  // account-level assertions above double as proof it contributes nothing.
  pendingPropertyId = await createProperty(accountId, '2 Review Queue Rd');
  pendingMortgageId = await createMortgage(accountId, pendingPropertyId, PENDING_CHECKPOINT_CENTS);
  await createPayment({
    accountId,
    propertyId: pendingPropertyId,
    mortgageId: pendingMortgageId,
    status: 'pending_review',
    categoryId: interestCategoryId,
  });
  await createPayment({
    accountId,
    propertyId: pendingPropertyId,
    mortgageId: pendingMortgageId,
    status: 'dismissed',
    categoryId: interestCategoryId,
  });

  // Its own account so the split row's totals are read in isolation.
  splitAccountId = await createAccount('Principal Split Co', 'principal-split@principaltest.example');
  splitPropertyId = await createProperty(splitAccountId, '3 Escrow Ct');
  splitMortgageId = await createMortgage(splitAccountId, splitPropertyId, CHECKPOINT_CENTS);
  await createPayment({
    accountId: splitAccountId,
    propertyId: splitPropertyId,
    mortgageId: splitMortgageId,
    status: 'confirmed',
    splits: [
      { categoryId: interestCategoryId, amountCents: SPLIT_INTEREST_CENTS },
      { categoryId: taxCategoryId, amountCents: SPLIT_ESCROW_CENTS },
    ],
  });
});

afterAll(async () => {
  // Cascades properties, mortgages, transactions, splits, reports, audit logs
  // and insights — nothing of this file survives into the next test file.
  await prisma.account.deleteMany({ where: { id: { in: [accountId, splitAccountId] } } });
});

describe('a confirmed mortgage payment reaches money aggregates net of principal', () => {
  it('the account P&L counts $1,600, not $2,400', async () => {
    const pnl = await pnlSnapshot(accountId);
    expect(pnl.totals.expenseCents).toBe(DEDUCTIBLE_CENTS);
    expect(pnl.totals.incomeCents).toBe(0);
    expect(pnl.totals.netCents).toBe(-DEDUCTIBLE_CENTS);
    const interestLine = pnl.lines.find((l) => l.categoryName === 'Mortgage Interest');
    expect(interestLine?.totalCents).toBe(DEDUCTIBLE_CENTS);
  });

  it('the dashboard KPIs, cashflow series, expense breakdown and per-property NOI all count $1,600', async () => {
    const kpis = await dashboardService.getKpis(accountId);
    expect(kpis.expensesMtdCents).toBe(DEDUCTIBLE_CENTS);
    expect(kpis.netCashFlowMtdCents).toBe(-DEDUCTIBLE_CENTS);

    const series = await dashboardService.getIncomeExpenseSeries(accountId, 3);
    const thisMonth = series.find((s) => s.month === period);
    expect(thisMonth?.expenseCents).toBe(DEDUCTIBLE_CENTS);

    const breakdown = await dashboardService.getExpenseBreakdown(accountId);
    expect(breakdown.totalCents).toBe(DEDUCTIBLE_CENTS);
    expect(breakdown.slices).toEqual([
      { categoryId: interestCategoryId, categoryName: 'Mortgage Interest', amountCents: DEDUCTIBLE_CENTS },
    ]);

    const noi = await dashboardService.getNoiByProperty(accountId);
    const row = noi.properties.find((p) => p.propertyId === propertyId);
    expect(row?.expenseCents).toBe(DEDUCTIBLE_CENTS);
    expect(row?.noiCents).toBe(-DEDUCTIBLE_CENTS);
  });

  it("the property hub's MTD/YTD P&L and category lines count $1,600", async () => {
    const detail = await propertyService.getDetail(accountId, propertyId);
    expect(detail.pnl.mtd.expenseCents).toBe(DEDUCTIBLE_CENTS);
    expect(detail.pnl.mtd.netCents).toBe(-DEDUCTIBLE_CENTS);
    expect(detail.pnl.ytd.expenseCents).toBe(DEDUCTIBLE_CENTS);

    const propertyPnl = await propertyService.getPnl(accountId, propertyId, {
      from: monthStart,
      to: monthEnd,
    });
    expect(propertyPnl.expenseCents).toBe(DEDUCTIBLE_CENTS);
    expect(propertyPnl.lines).toHaveLength(1);
    expect(propertyPnl.lines[0]?.categoryName).toBe('Mortgage Interest');
    expect(propertyPnl.lines[0]?.totalCents).toBe(DEDUCTIBLE_CENTS);
  });

  it('Schedule E line 12 carries $1,600 — the principal is not deductible', async () => {
    const report = await reportService.generate(accountId, {
      type: 'schedule_e',
      taxYear: Number(period.slice(0, 4)),
    });
    const data = (await reportService.getById(accountId, report.id)).data as ScheduleESnapshot;
    const row = data.propertyRows.find((r) => r.propertyId === propertyId);
    expect(row?.expenseLines[LINE_12]).toBe(DEDUCTIBLE_CENTS);
    expect(row?.totalExpensesCents).toBe(DEDUCTIBLE_CENTS);
    expect(data.totals.totalExpensesCents).toBe(DEDUCTIBLE_CENTS);
  });

  it('the general ledger still shows the full $2,400 while its totals count $1,600', async () => {
    // Visibility is never what the carve-out changes: the row the landlord sees
    // must match the bank statement.
    const report = await reportService.generate(accountId, {
      type: 'general_ledger',
      from: iso(monthStart),
      to: iso(monthEnd),
    });
    const data = (await reportService.getById(accountId, report.id)).data as LedgerSnapshot;
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]?.amountCents).toBe(PAYMENT_CENTS);
    expect(data.totals.expenseCents).toBe(DEDUCTIBLE_CENTS);
  });

  it("the mortgage's derived balance drops by exactly the $800 principal", async () => {
    const [mortgage] = await mortgageService.listForProperty(accountId, propertyId);
    expect(mortgage?.balanceCents).toBe(CHECKPOINT_CENTS); // the checkpoint itself never moves
    expect(mortgage?.currentBalanceCents).toBe(CHECKPOINT_CENTS - PRINCIPAL_CENTS);

    // As of the statement date the payment hasn't happened yet.
    const [asOfCheckpoint] = await mortgageService.listForProperty(
      accountId,
      propertyId,
      checkpointDate,
    );
    expect(asOfCheckpoint?.currentBalanceCents).toBe(CHECKPOINT_CENTS);

    const detail = await propertyService.getDetail(accountId, propertyId);
    expect(detail.equity?.liabilityCents).toBe(CHECKPOINT_CENTS - PRINCIPAL_CENTS);
  });

  it('moves balance-sheet equity by the deductible $1,600, not by the $800 it repaid', async () => {
    // The trap the carve-out creates: P&L net no longer sees the principal, but
    // the liability line drops by it. Credit the repayment on both sides and
    // equity overstates by $800 — silently, since it still reconciles. The cash
    // asset line nets the principal back out, so the identity holds:
    // a $2,400 payment = $800 debt reduction + $1,600 of real expense.
    const report = await reportService.generate(accountId, {
      type: 'balance_sheet',
      from: iso(monthStart),
      to: iso(monthEnd),
    });
    const data = (await reportService.getById(accountId, report.id)).data as {
      assets: Array<{ item: string; amountCents: number }>;
      totals: { totalAssetsCents: number; totalLiabilitiesCents: number; equityCents: number };
    };
    await prisma.report.delete({ where: { id: report.id } });
    await prisma.auditLog.deleteMany({ where: { accountId, entityId: report.id } });

    const cash = data.assets.find((r) => r.item.startsWith('Operating cash'));
    // P&L net counted only $1,600; the cash line owes the other $800 too.
    expect(cash?.amountCents).toBe(-PAYMENT_CENTS);

    // Both of this account's mortgages sit on the balance sheet; only the
    // confirmed payment moved one of them.
    const baselineDebtCents = CHECKPOINT_CENTS + PENDING_CHECKPOINT_CENTS;
    expect(data.totals.totalLiabilitiesCents).toBe(baselineDebtCents - PRINCIPAL_CENTS);

    // The claim worth pinning: against a baseline of untouched debt, equity
    // fell by exactly the deductible $1,600 — not by the $2,400 that left the
    // bank (the $800 bought down debt) and not by $800 (the double-credit bug).
    const propertyBasisCents = data.assets
      .filter((r) => !r.item.startsWith('Operating cash'))
      .reduce((s, r) => s + r.amountCents, 0);
    expect(data.totals.equityCents).toBe(
      propertyBasisCents - baselineDebtCents - DEDUCTIBLE_CENTS,
    );
  });

  it("nets out only principal the liability side credited — an archived mortgage's doesn't count", async () => {
    // An archived mortgage (paid off, or entered by mistake) has no liability
    // row, so there is nothing on the other side for its principal to offset.
    // Netting it out of cash anyway understates equity by that amount. The
    // adjustment is therefore derived from the liability rows themselves rather
    // than summed over the period's `principalCents`.
    const localProperty = await createProperty(accountId, '2 Archived Loan Way');
    const localMortgage = await createMortgage(accountId, localProperty, CHECKPOINT_CENTS);
    const localPayment = await createPayment({
      accountId,
      mortgageId: localMortgage,
      propertyId: localProperty,
      status: 'confirmed',
      categoryId: interestCategoryId,
    });
    await prisma.mortgage.update({
      where: { id: localMortgage },
      data: { archivedAt: new Date() },
    });

    const report = await reportService.generate(accountId, {
      type: 'balance_sheet',
      from: iso(monthStart),
      to: iso(monthEnd),
    });
    const data = (await reportService.getById(accountId, report.id)).data as {
      assets: Array<{ item: string; amountCents: number }>;
      liabilities: Array<{ item: string }>;
      totals: { totalLiabilitiesCents: number };
    };
    await prisma.report.delete({ where: { id: report.id } });
    await prisma.auditLog.deleteMany({ where: { accountId, entityId: report.id } });

    // The archived loan is absent from liabilities…
    expect(data.liabilities.some((l) => l.item.includes('Archived Loan'))).toBe(false);
    // …so only the suite's live mortgage credits its $800 back out of cash,
    // even though $1,600 of principal was paid across both this period.
    const pnlNet = (await propertyService.pnlTotals(accountId, { from: monthStart, to: monthEnd }))
      .netCents;
    const cash = data.assets.find((r) => r.item.startsWith('Operating cash'));
    expect(cash?.amountCents).toBe(pnlNet - PRINCIPAL_CENTS);

    // Full cleanup: Transaction.propertyId is SetNull, so deleting the property
    // would leave this confirmed row in the account's P&L and skew sibling tests.
    await prisma.transaction.delete({ where: { id: localPayment } });
    await prisma.mortgage.delete({ where: { id: localMortgage } });
    await prisma.property.delete({ where: { id: localProperty } });
  });

  it('a principal-only payment contributes exactly $0', () => {
    expect(
      pnlBucket({
        type: 'expense',
        classification: null,
        amountCents: PAYMENT_CENTS,
        principalCents: PAYMENT_CENTS,
      }),
    ).toEqual({ bucket: 'expense', amountCents: 0 });
  });
});

describe('an unconfirmed mortgage payment moves nothing', () => {
  it('a pending_review (or dismissed) payment moves neither the P&L nor the balance', async () => {
    const propertyPnl = await propertyService.getPnl(accountId, pendingPropertyId, {
      from: monthStart,
      to: monthEnd,
    });
    expect(propertyPnl.expenseCents).toBe(0);
    expect(propertyPnl.lines).toEqual([]);

    // The account-level total is still only the confirmed row's remainder — the
    // two unconfirmed $2,400 rows contribute nothing at all.
    const pnl = await pnlSnapshot(accountId);
    expect(pnl.totals.expenseCents).toBe(DEDUCTIBLE_CENTS);

    const [mortgage] = await mortgageService.listForProperty(accountId, pendingPropertyId);
    expect(mortgage?.currentBalanceCents).toBe(PENDING_CHECKPOINT_CENTS);
  });
});

describe('a split mortgage payment keeps totals and per-category lines in agreement', () => {
  it('splits sum to the $1,600 remainder: line totals equal the P&L expense total', async () => {
    const pnl = await pnlSnapshot(splitAccountId);
    expect(pnl.totals.expenseCents).toBe(DEDUCTIBLE_CENTS);
    const byCategory = new Map(pnl.lines.map((l) => [l.categoryName, l.totalCents]));
    expect(byCategory.get('Mortgage Interest')).toBe(SPLIT_INTEREST_CENTS);
    expect(byCategory.get('Property Taxes')).toBe(SPLIT_ESCROW_CENTS);
    expect(pnl.lines.reduce((sum, l) => sum + l.totalCents, 0)).toBe(pnl.totals.expenseCents);
  });

  it('each split line maps to its own IRS line, and the ledger still shows $2,400', async () => {
    const scheduleE = await reportService.generate(splitAccountId, {
      type: 'schedule_e',
      taxYear: Number(period.slice(0, 4)),
    });
    const data = (await reportService.getById(splitAccountId, scheduleE.id))
      .data as ScheduleESnapshot;
    const row = data.propertyRows.find((r) => r.propertyId === splitPropertyId);
    expect(row?.expenseLines[LINE_12]).toBe(SPLIT_INTEREST_CENTS);
    expect(row?.expenseLines[LINE_16]).toBe(SPLIT_ESCROW_CENTS);
    expect(row?.totalExpensesCents).toBe(DEDUCTIBLE_CENTS);

    const ledger = await reportService.generate(splitAccountId, {
      type: 'general_ledger',
      from: iso(monthStart),
      to: iso(monthEnd),
    });
    const ledgerData = (await reportService.getById(splitAccountId, ledger.id))
      .data as LedgerSnapshot;
    expect(ledgerData.rows[0]?.amountCents).toBe(PAYMENT_CENTS);
    expect(ledgerData.rows[0]?.categoryName).toBe('Split (2 categories)');
    expect(ledgerData.totals.expenseCents).toBe(DEDUCTIBLE_CENTS);
  });

  it('the dashboard KPIs and the mortgage balance agree with the unsplit case', async () => {
    const kpis = await dashboardService.getKpis(splitAccountId);
    expect(kpis.expensesMtdCents).toBe(DEDUCTIBLE_CENTS);

    const [mortgage] = await mortgageService.listForProperty(splitAccountId, splitPropertyId);
    expect(mortgage?.currentBalanceCents).toBe(CHECKPOINT_CENTS - PRINCIPAL_CENTS);
  });
});
