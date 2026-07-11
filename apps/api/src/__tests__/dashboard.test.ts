// (a) Dashboard KPIs equal the pinned seed constants exactly.
import {
  ExpenseBreakdownResponseSchema,
  PropertyNoiResponseSchema,
} from '@hearth/shared';
import { describe, expect, it } from 'vitest';
import {
  COLLECTED_MTD_CENTS,
  CURRENT_MONTH_EXPENSES,
  EXPENSES_MTD_CENTS,
  NET_CASHFLOW_MTD_CENTS,
  PAID_UNITS,
  RENT_COLLECTED_PCT,
  SEED_PROPERTIES,
  TAX_SET_ASIDE_CURRENT_CENTS,
  TAX_SET_ASIDE_TARGET_CENTS,
  TOTAL_UNITS,
} from '../../prisma/seed-constants';
import { addMonthsToPeriod, currentPeriod, monthStart } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import * as dashboardService from '../services/dashboard.service';

describe('dashboardService.getKpis (seed constants)', () => {
  it('returns the exact §10 figures', async () => {
    const accountId = await getDemoAccountId();
    const kpis = await dashboardService.getKpis(accountId);

    expect(kpis.netCashFlowMtdCents).toBe(NET_CASHFLOW_MTD_CENTS); // $8,450 = 845000
    expect(kpis.expensesMtdCents).toBe(EXPENSES_MTD_CENTS); // $3,110 = 311000
    expect(kpis.paidUnits).toBe(PAID_UNITS); // 12
    expect(kpis.totalUnits).toBe(TOTAL_UNITS); // 14
    expect(kpis.rentCollectedPct).toBe(RENT_COLLECTED_PCT); // 86
    expect(kpis.taxSetAside.currentCents).toBe(TAX_SET_ASIDE_CURRENT_CENTS); // $1,690
    expect(kpis.taxSetAside.targetCents).toBe(TAX_SET_ASIDE_TARGET_CENTS); // $2,700
  });

  it('cashflow series covers 6 months with full trailing rent', async () => {
    const accountId = await getDemoAccountId();
    const series = await dashboardService.getIncomeExpenseSeries(accountId, 6);
    expect(series).toHaveLength(6);
    // Trailing (non-current) months carry the full rent roll.
    const first = series[0];
    expect(first?.incomeCents).toBe(1369500);
    expect(first?.expenseCents).toBeGreaterThan(0);
  });
});

describe('dashboardService.getExpenseBreakdown (seed constants)', () => {
  it('decomposes the MTD expense KPI by category', async () => {
    const accountId = await getDemoAccountId();
    const result = await dashboardService.getExpenseBreakdown(accountId);
    ExpenseBreakdownResponseSchema.parse(result);

    // Total must reconcile with the pinned "Expenses (MTD)" KPI.
    expect(result.totalCents).toBe(EXPENSES_MTD_CENTS); // 311000
    const sliceSum = result.slices.reduce((s, x) => s + x.amountCents, 0);
    expect(sliceSum).toBe(EXPENSES_MTD_CENTS);

    // Slices are sorted descending and cover every current-month category.
    const byCategory = new Map(result.slices.map((s) => [s.categoryName, s.amountCents]));
    for (const e of CURRENT_MONTH_EXPENSES) {
      expect(byCategory.get(e.categoryName)).toBe(e.amountCents);
    }
    const amounts = result.slices.map((s) => s.amountCents);
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
    expect(result.slices.some((s) => s.categoryName === 'Other')).toBe(false);
  });
});

describe('dashboardService.getNoiByProperty (seed constants)', () => {
  it('returns per-property operating income, sorted, excluding portfolio costs', async () => {
    const accountId = await getDemoAccountId();
    const result = await dashboardService.getNoiByProperty(accountId);
    PropertyNoiResponseSchema.parse(result);

    // One row per active seed property.
    expect(result.properties).toHaveLength(SEED_PROPERTIES.length); // 9

    // Attributed income = all collected rent; attributed expense = only the
    // current-month expenses tagged to a property (portfolio-level lines drop).
    const attributedExpense = CURRENT_MONTH_EXPENSES.filter((e) => e.propertyKey !== null).reduce(
      (s, e) => s + e.amountCents,
      0,
    );
    const sumIncome = result.properties.reduce((s, p) => s + p.incomeCents, 0);
    const sumExpense = result.properties.reduce((s, p) => s + p.expenseCents, 0);
    const sumNoi = result.properties.reduce((s, p) => s + p.noiCents, 0);
    expect(sumIncome).toBe(COLLECTED_MTD_CENTS); // 1156000
    expect(sumExpense).toBe(attributedExpense); // 233000 (Insurance excluded)
    expect(sumNoi).toBe(COLLECTED_MTD_CENTS - attributedExpense);

    // noi = income − expense for each row, sorted descending.
    for (const p of result.properties) {
      expect(p.noiCents).toBe(p.incomeCents - p.expenseCents);
    }
    const nois = result.properties.map((p) => p.noiCents);
    expect([...nois].sort((a, b) => b - a)).toEqual(nois);
  });
});

describe('tax set-aside for a young account', () => {
  it('divides the trailing net by months with ledger activity, not a flat 6', async () => {
    const account = await prisma.account.create({
      data: { name: 'Young Tax Test', email: 'young-tax-test@example.com' },
    });
    // Two months of history: $1,000 and $500 of income, nothing older.
    const m1Date = monthStart(addMonthsToPeriod(currentPeriod(), -1));
    const m2Date = monthStart(addMonthsToPeriod(currentPeriod(), -2));
    await prisma.transaction.createMany({
      data: [
        { accountId: account.id, date: m1Date, amountCents: 100_000, type: 'income', description: 'young acct income', source: 'manual', status: 'confirmed' },
        { accountId: account.id, date: m2Date, amountCents: 50_000, type: 'income', description: 'young acct income', source: 'manual', status: 'confirmed' },
      ],
    });

    const kpis = await dashboardService.getKpis(account.id);
    // avg = 150000 / 2 months with activity; target = avg × 3 × 20% (default rate)
    expect(kpis.taxSetAside.targetCents).toBe(Math.round((150_000 / 2) * 3 * 0.2));

    await prisma.transaction.deleteMany({ where: { accountId: account.id } });
    await prisma.account.delete({ where: { id: account.id } });
  });
});
