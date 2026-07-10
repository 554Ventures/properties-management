// (f) Route-level tests: main GET endpoints parsed with the shared schemas.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  AccountSettingsSchema,
  ActivityListResponseSchema,
  CategoryListResponseSchema,
  ContractorDetailResponseSchema,
  ContractorListResponseSchema,
  DashboardInsightResponseSchema,
  DashboardKpisResponseSchema,
  IncomeExpenseSeriesResponseSchema,
  InsightListResponseSchema,
  IntegrationListResponseSchema,
  LeaseListResponseSchema,
  PropertyDetailResponseSchema,
  PropertyListResponseSchema,
  RentTrackerResponseSchema,
  ReportLibraryResponseSchema,
  ReportListResponseSchema,
  ReviewQueueResponseSchema,
  TenantDetailResponseSchema,
  TenantListResponseSchema,
  TransactionListResponseSchema,
} from '@hearth/shared';
import {
  CONTRACTOR_COUNT,
  EXPENSES_MTD_CENTS,
  NET_CASHFLOW_MTD_CENTS,
  OKAFOR_DAYS_LATE,
  OKAFOR_NAME,
  TAX_SET_ASIDE_CURRENT_CENTS,
  TAX_SET_ASIDE_TARGET_CENTS,
} from '../../prisma/seed-constants';
import { buildApp } from '../app';
import { currentPeriod } from '../lib/dates';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

async function getJson(url: string): Promise<unknown> {
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode, `GET ${url}`).toBe(200);
  return res.json();
}

describe('GET endpoints satisfy the shared response schemas', () => {
  it('/healthz', async () => {
    expect(await getJson('/api/v1/healthz')).toEqual({ status: 'ok' });
  });

  it('/properties — 9 rows with derived stats', async () => {
    const body = PropertyListResponseSchema.parse(await getJson('/api/v1/properties'));
    expect(body).toHaveLength(9);
    const cedar = body.find((p) => p.addressLine1 === '21 Cedar Ct');
    expect(cedar?.statusLabel).toBe('1 late');
    expect(cedar?.unitCount).toBe(1);
    const oak = body.find((p) => p.addressLine1 === '88 Oak Ave');
    expect(oak?.statusLabel).toBe('Full');
    expect(oak?.monthlyRentCents).toBe(265000);
  });

  it('/properties/:id — detail composite', async () => {
    const list = PropertyListResponseSchema.parse(await getJson('/api/v1/properties'));
    const first = list[0]!;
    const detail = PropertyDetailResponseSchema.parse(
      await getJson(`/api/v1/properties/${first.id}`),
    );
    expect(detail.units.length).toBe(first.unitCount);
    expect(detail.units.every((u) => u.status === 'occupied')).toBe(true);
  });

  it('/tenants + /tenants/:id', async () => {
    const tenants = TenantListResponseSchema.parse(await getJson('/api/v1/tenants'));
    expect(tenants).toHaveLength(14);
    const okafor = tenants.find((t) => t.fullName === OKAFOR_NAME)!;
    const detail = TenantDetailResponseSchema.parse(await getJson(`/api/v1/tenants/${okafor.id}`));
    expect(detail.paymentHistory.length).toBeGreaterThanOrEqual(7);
    const current = detail.paymentHistory.find((p) => p.period === currentPeriod());
    expect(current?.status).toBe('late');
    expect(current?.daysLate).toBe(OKAFOR_DAYS_LATE);
    // Okafor's lease carries the mock e-sign document.
    expect(detail.documents).toHaveLength(1);
  });

  it('/leases', async () => {
    const leases = LeaseListResponseSchema.parse(await getJson('/api/v1/leases?status=active'));
    expect(leases).toHaveLength(14);
  });

  it('/transactions + /transactions/review', async () => {
    const txns = TransactionListResponseSchema.parse(
      await getJson('/api/v1/transactions?limit=20'),
    );
    expect(txns.items).toHaveLength(20);
    expect(txns.nextCursor).not.toBeNull();

    const review = ReviewQueueResponseSchema.parse(await getJson('/api/v1/transactions/review'));
    expect(review.items).toHaveLength(3);
    expect(review.items.every((i) => i.aiSuggestedCategoryName !== null)).toBe(true);
  });

  it('/contractors — 6 rows with derived usage stats; /contractors/:id agrees', async () => {
    const contractors = ContractorListResponseSchema.parse(await getJson('/api/v1/contractors'));
    expect(contractors).toHaveLength(CONTRACTOR_COUNT);
    // Stats derive from confirmed expense txns matched by vendor name (§4).
    const summit = contractors.find((c) => c.name === 'Summit Roofing');
    expect(summit?.jobsCount).toBe(4);
    expect(summit?.avgCostCents).toBe(115000);
    expect(summit?.website).toBe('summitroofingco.com');

    // Detail derives from the same match — stats must equal the list row.
    const detail = ContractorDetailResponseSchema.parse(
      await getJson(`/api/v1/contractors/${summit!.id}`),
    );
    expect(detail.jobsCount).toBe(summit!.jobsCount);
    expect(detail.avgCostCents).toBe(summit!.avgCostCents);
    expect(detail.lastUsedAt).toBe(summit!.lastUsedAt);
    expect(detail.jobs).toHaveLength(4);
  });

  it('/categories', async () => {
    const categories = CategoryListResponseSchema.parse(await getJson('/api/v1/categories'));
    expect(categories.length).toBe(16);
    expect(categories.every((c) => c.isSystem)).toBe(true);
  });

  it('/rent/tracker', async () => {
    const tracker = RentTrackerResponseSchema.parse(
      await getJson(`/api/v1/rent/tracker?period=${currentPeriod()}`),
    );
    expect(tracker.totalUnits).toBe(14);
    const okafor = tracker.rows.find((r) => r.tenantName === OKAFOR_NAME);
    expect(okafor?.daysLate).toBe(OKAFOR_DAYS_LATE);
  });

  it('/reports/library + /reports', async () => {
    const library = ReportLibraryResponseSchema.parse(await getJson('/api/v1/reports/library'));
    expect(library).toHaveLength(14);
    expect(library.find((i) => i.type === 'schedule_e')?.maturity).toBe('full');
    expect(library.find((i) => i.type === 'balance_sheet')?.maturity).toBe('simplified');

    const reports = ReportListResponseSchema.parse(await getJson('/api/v1/reports'));
    expect(reports.length).toBeGreaterThanOrEqual(1); // seed's monthly review

    const reviews = ReportListResponseSchema.parse(await getJson('/api/v1/insights/monthly-reviews'));
    expect(reviews.every((r) => r.type === 'monthly_review')).toBe(true);
    expect(reviews.length).toBeGreaterThanOrEqual(1);
  });

  it('/insights', async () => {
    const insights = InsightListResponseSchema.parse(await getJson('/api/v1/insights'));
    expect(insights.length).toBeGreaterThanOrEqual(3);
    const active = InsightListResponseSchema.parse(await getJson('/api/v1/insights?status=active'));
    expect(active.every((i) => i.status === 'active')).toBe(true);
  });

  it('/dashboard/* — kpis carry the exact cents figures over HTTP', async () => {
    const kpis = DashboardKpisResponseSchema.parse(await getJson('/api/v1/dashboard/kpis'));
    expect(kpis.netCashFlowMtdCents).toBe(NET_CASHFLOW_MTD_CENTS);
    expect(kpis.expensesMtdCents).toBe(EXPENSES_MTD_CENTS);
    expect(kpis.taxSetAside).toEqual({
      currentCents: TAX_SET_ASIDE_CURRENT_CENTS,
      targetCents: TAX_SET_ASIDE_TARGET_CENTS,
    });

    const series = IncomeExpenseSeriesResponseSchema.parse(
      await getJson('/api/v1/dashboard/cashflow-series?months=6'),
    );
    expect(series).toHaveLength(6);

    const activity = ActivityListResponseSchema.parse(
      await getJson('/api/v1/dashboard/activity?limit=10'),
    );
    expect(activity).toHaveLength(10);

    const insight = DashboardInsightResponseSchema.parse(await getJson('/api/v1/dashboard/insight'));
    expect(insight?.severity).toBe('warning');
  });

  it('/settings/account + /integrations', async () => {
    const account = AccountSettingsSchema.parse(await getJson('/api/v1/settings/account'));
    expect(account.email).toBe('demo@hearth.app');
    expect(account.taxRatePct).toBe(20);

    const integrations = IntegrationListResponseSchema.parse(await getJson('/api/v1/integrations'));
    expect(integrations).toHaveLength(4);
    expect(integrations.every((i) => i.status === 'mock')).toBe(true);
  });

  it('unknown route and validation errors use the ApiError envelope', async () => {
    const notFound = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toMatchObject({ error: { code: 'not_found' } });

    const badBody = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      payload: { amountCents: -5 },
    });
    expect(badBody.statusCode).toBe(400);
    const err = badBody.json() as { error: { code: string; fields: Record<string, string> } };
    expect(err.error.code).toBe('validation_error');
    expect(Object.keys(err.error.fields)).toContain('amountCents');
  });
});
