// (e) schedule_e totals reconcile with the ledger.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ReportDetailResponseSchema, ReportSchema } from '@hearth/shared';
import { buildApp } from '../app';
import { resetMockEmail, sentEmails } from '../integrations/mock/mock-email';
import {
  addDays,
  addMonthsToPeriod,
  currentPeriodInTz,
  iso,
  monthEndExclusiveInTz,
  monthStartInTz,
  yearRange,
} from '../lib/dates';
import { pnlSums } from '../lib/pnl';
import { prisma } from '../lib/prisma';
import {
  BALANCE_SHEET_PROPERTY_ASSETS_CENTS,
  DEMO_TIMEZONE,
  MAPLE_MORTGAGE_BALANCE_CENTS,
  MAPLE_MORTGAGE_LENDER,
  MAPLE_VALUATION_CENTS,
  SEED_PROPERTIES,
} from '../../prisma/seed-constants';
import { getDemoAccountId } from '../plugins/auth';
import * as reportService from '../services/report.service';
import * as transactionService from '../services/transaction.service';

// Monthly review buckets its period on the account's local calendar (WS4), so
// the `from` anchor + reconciliation range use the demo account's timezone.
const TZ = DEMO_TIMEZONE;

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

interface ScheduleEData {
  propertyRows: Array<{ rentsReceivedCents: number; totalExpensesCents: number }>;
  totals: { rentsReceivedCents: number; totalExpensesCents: number; netCents: number };
}

describe('schedule_e report', () => {
  it('totals reconcile with the confirmed ledger for the tax year', async () => {
    const accountId = await getDemoAccountId();
    const taxYear = new Date().getUTCFullYear();
    const report = ReportSchema.parse(
      await reportService.generate(accountId, { type: 'schedule_e', taxYear }),
    );
    expect(report.taxYear).toBe(taxYear);

    const detail = await reportService.getById(accountId, report.id);
    const data = detail.data as ScheduleEData;

    // Independent ledger aggregation over the same range.
    const { from, to } = yearRange(taxYear);
    const grouped = await prisma.transaction.groupBy({
      by: ['type'],
      where: { accountId, status: 'confirmed', date: { gte: from, lt: to } },
      _sum: { amountCents: true },
    });
    const ledgerIncome = grouped.find((g) => g.type === 'income')?._sum.amountCents ?? 0;
    const ledgerExpense = grouped.find((g) => g.type === 'expense')?._sum.amountCents ?? 0;

    expect(data.totals.rentsReceivedCents).toBe(ledgerIncome);
    expect(data.totals.totalExpensesCents).toBe(ledgerExpense);
    expect(data.totals.netCents).toBe(ledgerIncome - ledgerExpense);

    // Per-property rows sum to the totals (portfolio row included).
    const rowIncome = data.propertyRows.reduce((s, r) => s + r.rentsReceivedCents, 0);
    const rowExpense = data.propertyRows.reduce((s, r) => s + r.totalExpensesCents, 0);
    expect(rowIncome).toBe(ledgerIncome);
    expect(rowExpense).toBe(ledgerExpense);

    // Audit trail for the generation.
    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'report.generated', entityId: report.id },
    });
    expect(audit).not.toBeNull();
  });

  it('GET /reports/:id returns the snapshot and export produces CSV', async () => {
    const accountId = await getDemoAccountId();
    const report = await reportService.generate(accountId, {
      type: 'pnl',
      taxYear: new Date().getUTCFullYear(),
    });

    const detailRes = await app.inject({ method: 'GET', url: `/api/v1/reports/${report.id}` });
    expect(detailRes.statusCode).toBe(200);
    ReportDetailResponseSchema.parse(detailRes.json());

    const csvRes = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${report.id}/export?format=csv`,
    });
    expect(csvRes.statusCode).toBe(200);
    expect(csvRes.headers['content-type']).toContain('text/csv');
    expect(csvRes.body).toContain('Category');

    const pdfRes = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${report.id}/export?format=pdf`,
    });
    expect(pdfRes.statusCode).toBe(200);
    expect(pdfRes.headers['content-type']).toContain('application/pdf');
    expect(pdfRes.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const pdfText = pdfRes.rawPayload.toString('latin1');
    expect(pdfText).toContain('%%EOF');
    // Report content is actually rendered: detail table heading + a USD figure.
    expect(pdfText).toContain('(Detail)');
    expect(pdfText).toContain('($');
  });

  it('income statement lists income above expenses with totals + net at the bottom', async () => {
    const accountId = await getDemoAccountId();
    const report = await reportService.generate(accountId, {
      type: 'income_statement',
      taxYear: new Date().getUTCFullYear(),
    });
    const detail = await reportService.getById(accountId, report.id);
    const data = detail.data as {
      totals: { incomeCents: number; expenseCents: number; netCents: number };
      table: { rows: Array<{ type: string; categoryName: string; totalCents: number }> };
    };

    // Category lines: every income row precedes every expense row.
    const typeSequence = data.table.rows
      .map((r) => r.type)
      .filter((t) => t === 'income' || t === 'expense');
    expect(typeSequence).toContain('income');
    expect(typeSequence).toContain('expense');
    expect(typeSequence.indexOf('expense')).toBe(typeSequence.lastIndexOf('income') + 1);

    // The table closes with Total income / Total expenses / Net, matching totals.
    const tail = data.table.rows.slice(-3);
    expect(tail.map((r) => r.categoryName)).toEqual(['Total income', 'Total expenses', 'Net']);
    expect(tail[0]!.totalCents).toBe(data.totals.incomeCents);
    expect(tail[1]!.totalCents).toBe(data.totals.expenseCents);
    expect(tail[2]!.totalCents).toBe(data.totals.netCents);

    await prisma.report.delete({ where: { id: report.id } });
    await prisma.auditLog.deleteMany({ where: { accountId, entityId: report.id } });
  });

  it('monthly review exists from seed and has real data', async () => {
    const accountId = await getDemoAccountId();
    const reviews = await reportService.listGenerated(accountId, { type: 'monthly_review' });
    expect(reviews.length).toBeGreaterThanOrEqual(1);
    const first = reviews[0];
    const detail = await reportService.getById(accountId, first!.id);
    const data = detail.data as {
      bottomLine: string;
      propertyNets: Array<{ propertyLabel: string; units: number; netCents: number }>;
      watchItems: string[];
    };
    expect(data.bottomLine).toContain('You netted');
    // 9 seed properties + the Portfolio / unassigned bucket: the seed's prior
    // month carries portfolio-level overhead (insurance, mortgage interest,
    // management fees), so per-property nets reconcile with the bottom line.
    expect(data.propertyNets).toHaveLength(10);
    expect(data.propertyNets.some((r) => r.propertyLabel === 'Portfolio / unassigned')).toBe(true);
    expect(data.watchItems.length).toBeGreaterThanOrEqual(2);
  });

  it('a newly generated monthly review appends the Portfolio / unassigned row with the ledger-derived net', async () => {
    const accountId = await getDemoAccountId();
    const period = currentPeriodInTz(TZ);
    const report = await reportService.generate(accountId, {
      type: 'monthly_review',
      from: iso(monthStartInTz(period, TZ)),
    });
    const detail = await reportService.getById(accountId, report.id);
    const data = detail.data as {
      propertyNets: Array<{ propertyLabel: string; units: number; netCents: number }>;
    };

    // Independent P&L aggregation of the period's confirmed property-less rows
    // (same style as the schedule_e reconciliation above) — no hardcoded pin.
    const grouped = await prisma.transaction.groupBy({
      by: ['type', 'classification'],
      where: {
        accountId,
        status: 'confirmed',
        propertyId: null,
        date: { gte: monthStartInTz(period, TZ), lt: monthEndExclusiveInTz(period, TZ) },
      },
      _sum: { amountCents: true, principalCents: true },
    });
    const expectedNet = pnlSums(grouped).netCents;
    expect(expectedNet).not.toBe(0); // fixture sanity: seed has portfolio overhead

    const unassigned = data.propertyNets.find((r) => r.propertyLabel === 'Portfolio / unassigned');
    expect(unassigned).toBeDefined();
    expect(unassigned!.units).toBe(0);
    expect(unassigned!.netCents).toBe(expectedNet);

    await prisma.report.delete({ where: { id: report.id } });
    await prisma.auditLog.deleteMany({ where: { accountId, entityId: report.id } });
  });
});

// PLAN-REAL-EQUITY §5: the balance sheet reports real equity. The seed gives
// Maple (SEED_PROPERTIES[0]) one mortgage + one valuation and every other
// property neither, so one report exercises the market-value line, the at-cost
// fallback and a real liability side.
describe('balance_sheet report — real equity', () => {
  const MAPLE = SEED_PROPERTIES[0]!;

  interface BalanceSheetData {
    simplified: boolean;
    assets: Array<{ item: string; amountCents: number }>;
    liabilities: Array<{ item: string; kind: string; amountCents: number }>;
    totals: { totalAssetsCents: number; totalLiabilitiesCents: number; equityCents: number };
    table: {
      columns: Array<{ key: string; label: string }>;
      rows: Array<{ section: string; item: string; amountCents: number }>;
    };
  }

  async function balanceSheet(
    accountId: string,
    input: { taxYear?: number; from?: string; to?: string },
  ): Promise<BalanceSheetData> {
    const report = await reportService.generate(accountId, { type: 'balance_sheet', ...input });
    const detail = await reportService.getById(accountId, report.id);
    await prisma.report.delete({ where: { id: report.id } });
    await prisma.auditLog.deleteMany({ where: { accountId, entityId: report.id } });
    return detail.data as BalanceSheetData;
  }

  const amountOf = (rows: Array<{ item: string; amountCents: number }>, item: string) =>
    rows.find((r) => r.item === item)?.amountCents;

  it('carries Maple at its owner-provided valuation, every other property at cost, and the mortgage as a liability', async () => {
    const accountId = await getDemoAccountId();
    const data = await balanceSheet(accountId, { taxYear: new Date().getUTCFullYear() });

    // A mortgage and a valuation exist → no longer a structural placeholder.
    expect(data.simplified).toBe(false);

    expect(amountOf(data.assets, `${MAPLE.addressLine1} (market value, owner-provided)`)).toBe(
      MAPLE_VALUATION_CENTS,
    );
    for (const spec of SEED_PROPERTIES.slice(1)) {
      expect(amountOf(data.assets, `${spec.addressLine1} (at cost)`)).toBe(spec.acquisitionCostCents);
    }
    // Period cash is range-dependent, so only the property basis is pinned.
    const propertyAssetsCents = data.assets
      // Match the cash line by prefix: only the property basis is pinned here,
      // and its exact wording has changed once already (it now says the
      // mortgage principal has been netted out).
      .filter((r) => !r.item.startsWith('Operating cash'))
      .reduce((s, r) => s + r.amountCents, 0);
    expect(propertyAssetsCents).toBe(BALANCE_SHEET_PROPERTY_ASSETS_CENTS);

    expect(data.liabilities).toHaveLength(1);
    const liability = data.liabilities[0]!;
    expect(liability.kind).toBe('mortgage');
    expect(liability.item).toContain(MAPLE.addressLine1);
    expect(liability.item).toContain(MAPLE_MORTGAGE_LENDER);
    // No principal-bearing rows exist yet (Phase 2), so the derived balance is
    // exactly the statement checkpoint.
    expect(liability.amountCents).toBe(MAPLE_MORTGAGE_BALANCE_CENTS);

    expect(data.totals.totalAssetsCents).toBe(data.assets.reduce((s, r) => s + r.amountCents, 0));
    expect(data.totals.totalLiabilitiesCents).toBe(MAPLE_MORTGAGE_BALANCE_CENTS);
    expect(data.totals.equityCents).toBe(
      data.totals.totalAssetsCents - data.totals.totalLiabilitiesCents,
    );
  });

  it('the view-as-table alternative covers liabilities and equity, not just assets', async () => {
    const accountId = await getDemoAccountId();
    const data = await balanceSheet(accountId, { taxYear: new Date().getUTCFullYear() });

    expect(data.table.columns.map((c) => c.key)).toEqual(['section', 'item', 'amountCents']);
    expect(new Set(data.table.rows.map((r) => r.section))).toEqual(
      new Set(['Assets', 'Liabilities', 'Equity']),
    );
    const liabilityRows = data.table.rows.filter((r) => r.section === 'Liabilities');
    expect(liabilityRows.map((r) => r.item)).toContain('Total liabilities');
    expect(amountOf(liabilityRows, 'Total liabilities')).toBe(data.totals.totalLiabilitiesCents);
    expect(amountOf(data.table.rows, 'Total assets')).toBe(data.totals.totalAssetsCents);
    expect(amountOf(data.table.rows, 'Equity')).toBe(data.totals.equityCents);
  });

  it('a range ending before the valuation keeps Maple at cost, and the mortgage line stays at its checkpoint', async () => {
    const accountId = await getDemoAccountId();
    // The seed dates both the checkpoint and the valuation at the start of
    // month M−6; a report whose period ends the day before must not inherit
    // either of them (a filed past period never picks up today's figures).
    const period = currentPeriodInTz(TZ);
    const equityAsOf = monthStartInTz(addMonthsToPeriod(period, -6), TZ);
    const data = await balanceSheet(accountId, {
      from: iso(monthStartInTz(addMonthsToPeriod(period, -12), TZ)),
      to: iso(addDays(equityAsOf, -1)),
    });

    expect(amountOf(data.assets, `${MAPLE.addressLine1} (at cost)`)).toBe(
      MAPLE.acquisitionCostCents,
    );
    expect(data.assets.some((r) => r.item.includes('market value'))).toBe(false);
    // The liability side is account-level (not date-filtered) and, with no
    // principal rows, reads back the checkpoint for any as-of date.
    expect(data.liabilities).toHaveLength(1);
    expect(data.liabilities[0]!.amountCents).toBe(MAPLE_MORTGAGE_BALANCE_CENTS);
    expect(data.simplified).toBe(false);
  });

  it('treats `to` as exclusive for valuations, exactly as it does for transactions', async () => {
    // `to` is exclusive everywhere in this file (transactions filter `lt: to`)
    // and the web sends the day *after* the picked end date. A valuation dated
    // exactly on `to` therefore belongs to the next period, not this one —
    // otherwise a July value silently lands in the June balance sheet.
    const accountId = await getDemoAccountId();
    const period = currentPeriodInTz(TZ);
    const valuationDate = monthStartInTz(addMonthsToPeriod(period, -6), TZ);
    const data = await balanceSheet(accountId, {
      from: iso(monthStartInTz(addMonthsToPeriod(period, -12), TZ)),
      to: iso(valuationDate),
    });

    expect(amountOf(data.assets, `${MAPLE.addressLine1} (at cost)`)).toBe(
      MAPLE.acquisitionCostCents,
    );
    expect(data.assets.some((r) => r.item.includes('market value'))).toBe(false);
  });
});

describe('schedule_e income line mapping', () => {
  it('income mapped off Line 3 lands in otherIncomeCents, not rents received', async () => {
    const accountId = await getDemoAccountId();
    const taxYear = new Date().getUTCFullYear();
    const category = await prisma.category.create({
      data: {
        accountId,
        name: 'TEST Vending income',
        type: 'income',
        irsScheduleELine: 'Line 19 – Other',
      },
    });
    const txn = await prisma.transaction.create({
      data: {
        accountId,
        date: new Date(),
        amountCents: 12_300,
        type: 'income',
        description: 'TEST vending machine income',
        source: 'manual',
        status: 'confirmed',
        categoryId: category.id,
      },
    });

    const report = await reportService.generate(accountId, { type: 'schedule_e', taxYear });
    const detail = await reportService.getById(accountId, report.id);
    const data = detail.data as ScheduleEData & {
      totals: { otherIncomeCents: number };
      propertyRows: Array<{ otherIncomeCents: number }>;
    };

    expect(data.totals.otherIncomeCents).toBe(12_300);
    // Rents received = confirmed income minus the off-line-3 row.
    const { from, to } = yearRange(taxYear);
    const income = await prisma.transaction.aggregate({
      where: { accountId, status: 'confirmed', type: 'income', date: { gte: from, lt: to } },
      _sum: { amountCents: true },
    });
    expect(data.totals.rentsReceivedCents).toBe((income._sum.amountCents ?? 0) - 12_300);
    // The Schedule E net EXCLUDES off-line-3 income — it isn't rental income,
    // so folding it in would put it back on the return.
    expect(data.totals.netCents).toBe(
      data.totals.rentsReceivedCents - data.totals.totalExpensesCents,
    );

    await prisma.report.delete({ where: { id: report.id } });
    await prisma.transaction.delete({ where: { id: txn.id } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.auditLog.deleteMany({ where: { accountId, entityId: report.id } });
  });

  // The seeded escape hatch: without it every income category maps to Line 3,
  // so a tax refund or an interest deposit is rental income on the return.
  it('the seeded Not Rental Income category keeps a Treasury refund off Line 3 and out of net', async () => {
    const accountId = await getDemoAccountId();
    const taxYear = new Date().getUTCFullYear();
    const nonRental = await prisma.category.findFirstOrThrow({
      where: { name: 'Not Rental Income', type: 'income', isSystem: true },
    });
    expect(nonRental.irsScheduleELine).toBe('Not reported on Schedule E');

    const baseline = await reportService.generate(accountId, { type: 'schedule_e', taxYear });
    const baseData = (await reportService.getById(accountId, baseline.id)).data as ScheduleEData;

    const txn = await prisma.transaction.create({
      data: {
        accountId,
        date: new Date(),
        amountCents: 184_200,
        type: 'income',
        description: 'TEST IRS TREAS 310 TAX REF',
        source: 'manual',
        status: 'confirmed',
        categoryId: nonRental.id,
      },
    });
    await prisma.report.delete({ where: { id: baseline.id } });
    const report = await reportService.generate(accountId, { type: 'schedule_e', taxYear });
    const data = (await reportService.getById(accountId, report.id)).data as ScheduleEData & {
      totals: { otherIncomeCents: number };
    };

    // The refund moved nothing on the form: rents, expenses and net are all
    // exactly what they were before it landed.
    expect(data.totals.otherIncomeCents).toBe(184_200);
    expect(data.totals.rentsReceivedCents).toBe(baseData.totals.rentsReceivedCents);
    expect(data.totals.netCents).toBe(baseData.totals.netCents);

    await prisma.report.delete({ where: { id: report.id } });
    await prisma.transaction.delete({ where: { id: txn.id } });
    await prisma.auditLog.deleteMany({
      where: { accountId, entityId: { in: [baseline.id, report.id] } },
    });
  });
});

// Splitting a row moves money BETWEEN category lines and nowhere else: every
// total in every report has to come out identical.
describe('transaction splits in reports', () => {
  const REPAIRS_LINE = 'Line 14 – Repairs';
  const SUPPLIES_LINE = 'Line 15 – Supplies';

  interface PnlData {
    lines: Array<{ categoryName: string; type: string; totalCents: number }>;
    totals: { incomeCents: number; expenseCents: number; netCents: number };
  }
  interface LedgerData {
    rows: Array<{ description: string; categoryName: string | null; amountCents: number }>;
    totals: { incomeCents: number; expenseCents: number; netCents: number };
  }
  interface ScheduleELinesData {
    propertyRows: Array<{
      propertyLabel: string;
      expenseLines: Record<string, number>;
      totalExpensesCents: number;
    }>;
    totals: { totalExpensesCents: number; netCents: number };
  }

  /** Generates `type` for the tax year and returns its snapshot, cleaned up. */
  async function snapshot<T>(accountId: string, type: 'pnl' | 'general_ledger' | 'schedule_e') {
    const report = await reportService.generate(accountId, {
      type,
      taxYear: new Date().getUTCFullYear(),
    });
    const detail = await reportService.getById(accountId, report.id);
    await prisma.report.delete({ where: { id: report.id } });
    await prisma.auditLog.deleteMany({ where: { accountId, entityId: report.id } });
    return detail.data as T;
  }

  async function fixtureTransaction(accountId: string, categoryId: string) {
    return prisma.transaction.create({
      data: {
        accountId,
        date: new Date(),
        amountCents: 50_000,
        type: 'expense',
        description: 'TEST split reporting fixture',
        source: 'manual',
        status: 'confirmed',
        categoryId,
      },
    });
  }

  async function cleanup(accountId: string, txnId: string) {
    await prisma.transaction.delete({ where: { id: txnId } });
    await prisma.auditLog.deleteMany({ where: { accountId, entityId: txnId } });
  }

  it('moves P&L category lines by the split amounts and leaves the totals alone', async () => {
    const accountId = await getDemoAccountId();
    const [repairs, supplies] = await Promise.all([
      prisma.category.findFirstOrThrow({ where: { name: 'Repairs', isSystem: true } }),
      prisma.category.findFirstOrThrow({ where: { name: 'Supplies', isSystem: true } }),
    ]);
    const txn = await fixtureTransaction(accountId, repairs.id);

    const before = await snapshot<PnlData>(accountId, 'pnl');
    const lineOf = (data: PnlData, name: string) =>
      data.lines.find((l) => l.type === 'expense' && l.categoryName === name)?.totalCents ?? 0;

    await transactionService.update(accountId, txn.id, {
      splits: [
        { categoryId: repairs.id, amountCents: 30_000 },
        { categoryId: supplies.id, amountCents: 20_000 },
      ],
    });

    const after = await snapshot<PnlData>(accountId, 'pnl');
    expect(after.totals).toEqual(before.totals); // the row's money never moved
    expect(lineOf(after, 'Repairs')).toBe(lineOf(before, 'Repairs') - 20_000);
    expect(lineOf(after, 'Supplies')).toBe(lineOf(before, 'Supplies') + 20_000);

    await cleanup(accountId, txn.id);
  });

  it('renders one general-ledger row labelled Split (N categories)', async () => {
    const accountId = await getDemoAccountId();
    const [repairs, supplies] = await Promise.all([
      prisma.category.findFirstOrThrow({ where: { name: 'Repairs', isSystem: true } }),
      prisma.category.findFirstOrThrow({ where: { name: 'Supplies', isSystem: true } }),
    ]);
    const txn = await fixtureTransaction(accountId, repairs.id);
    const before = await snapshot<LedgerData>(accountId, 'general_ledger');

    await transactionService.update(accountId, txn.id, {
      splits: [
        { categoryId: repairs.id, amountCents: 30_000 },
        { categoryId: supplies.id, amountCents: 20_000 },
      ],
    });

    const after = await snapshot<LedgerData>(accountId, 'general_ledger');
    const rows = after.rows.filter((r) => r.description === 'TEST split reporting fixture');
    expect(rows).toHaveLength(1); // one row, not one per split
    expect(rows[0]!.categoryName).toBe('Split (2 categories)');
    expect(rows[0]!.amountCents).toBe(50_000);
    expect(after.totals).toEqual(before.totals);

    await cleanup(accountId, txn.id);
  });

  it('maps each split line through its own IRS Schedule E line', async () => {
    const accountId = await getDemoAccountId();
    const [repairs, supplies] = await Promise.all([
      prisma.category.findFirstOrThrow({ where: { name: 'Repairs', isSystem: true } }),
      prisma.category.findFirstOrThrow({ where: { name: 'Supplies', isSystem: true } }),
    ]);
    const txn = await fixtureTransaction(accountId, repairs.id);

    const before = await snapshot<ScheduleELinesData>(accountId, 'schedule_e');
    const portfolioLines = (data: ScheduleELinesData) =>
      data.propertyRows.find((r) => r.propertyLabel === 'Portfolio / unassigned')!;

    await transactionService.update(accountId, txn.id, {
      splits: [
        { categoryId: repairs.id, amountCents: 30_000 },
        { categoryId: supplies.id, amountCents: 20_000 },
      ],
    });

    const after = await snapshot<ScheduleELinesData>(accountId, 'schedule_e');
    const beforeRow = portfolioLines(before);
    const afterRow = portfolioLines(after);
    expect(afterRow.expenseLines[REPAIRS_LINE]).toBe(
      (beforeRow.expenseLines[REPAIRS_LINE] ?? 0) - 20_000,
    );
    expect(afterRow.expenseLines[SUPPLIES_LINE]).toBe(
      (beforeRow.expenseLines[SUPPLIES_LINE] ?? 0) + 20_000,
    );
    expect(afterRow.totalExpensesCents).toBe(beforeRow.totalExpensesCents);
    expect(after.totals).toEqual(before.totals);

    await cleanup(accountId, txn.id);
  });
});

describe('emailToAccountant', () => {
  it('routes through the email adapter factory — the send lands in the mock recorder', async () => {
    const accountId = await getDemoAccountId();
    const report = await reportService.generate(accountId, {
      type: 'pnl',
      taxYear: new Date().getUTCFullYear(),
    });

    resetMockEmail();
    await reportService.emailToAccountant(accountId, report.id, 'accountant@example.com');
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.to).toBe('accountant@example.com');
    expect(sentEmails[0]!.subject).toContain(report.title);

    await prisma.report.delete({ where: { id: report.id } });
    await prisma.auditLog.deleteMany({ where: { accountId, entityId: report.id } });
  });
});
