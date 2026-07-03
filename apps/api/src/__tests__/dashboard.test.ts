// (a) Dashboard KPIs equal the pinned seed constants exactly.
import { describe, expect, it } from 'vitest';
import {
  EXPENSES_MTD_CENTS,
  NET_CASHFLOW_MTD_CENTS,
  PAID_UNITS,
  RENT_COLLECTED_PCT,
  TAX_SET_ASIDE_CURRENT_CENTS,
  TAX_SET_ASIDE_TARGET_CENTS,
  TOTAL_UNITS,
} from '../../prisma/seed-constants';
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
