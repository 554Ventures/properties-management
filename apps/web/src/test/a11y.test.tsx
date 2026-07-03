// Axe smoke test: AppShell + Dashboard rendered with mocked query data must
// produce zero axe violations (merge-blocking check per ARCHITECTURE §8).
import type {
  ActivityItem,
  DashboardKpisResponse,
  IncomeExpenseSeriesResponse,
  Insight,
  PropertyWithStats,
} from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../components/shell/AppShell';
import { ToastProvider } from '../components/ui/Toast';
import { Dashboard } from '../pages/Dashboard';

const kpis: DashboardKpisResponse = {
  netCashFlowMtdCents: 845000,
  netCashFlowTrendPct: 4.2,
  rentCollectedPct: 86,
  rentCollectedTrendPct: 0,
  paidUnits: 12,
  totalUnits: 14,
  expensesMtdCents: 311000,
  expensesTrendPct: -2.1,
  taxSetAside: { currentCents: 169000, targetCents: 270000 },
};

const series: IncomeExpenseSeriesResponse = [
  { month: '2026-02', incomeCents: 1369500, expenseCents: 891000 },
  { month: '2026-03', incomeCents: 1369500, expenseCents: 965000 },
  { month: '2026-04', incomeCents: 1369500, expenseCents: 873000 },
  { month: '2026-05', incomeCents: 1369500, expenseCents: 924000 },
  { month: '2026-06', incomeCents: 1369500, expenseCents: 916000 },
  { month: '2026-07', incomeCents: 1156000, expenseCents: 311000 },
];

const activity: ActivityItem[] = [
  {
    id: 'a1',
    kind: 'rent_payment',
    text: 'J. Rivera paid $1,250.00 rent for 12 Maple St',
    at: '2026-07-02T14:00:00.000Z',
    link: '/rent',
  },
  {
    id: 'a2',
    kind: 'transaction',
    text: 'Plumbing repair $480.00 at 88 Oak Ave',
    at: '2026-07-01T10:00:00.000Z',
    link: null,
  },
];

const insight: Insight = {
  id: 'i1',
  accountId: 'acc1',
  scope: 'tenant',
  type: 'late_rent',
  severity: 'warning',
  title: 'T. Okafor is 6 days late on July rent',
  body: 'Rent of $1,150.00 for 21 Cedar Ct was due on the 1st. A reminder usually resolves this.',
  actionLabel: 'Review',
  actionTarget: '/rent',
  propertyId: null,
  tenantId: 't-okafor',
  leaseId: null,
  dedupeKey: 'late_rent:t-okafor:2026-07',
  status: 'active',
  createdAt: '2026-07-03T08:00:00.000Z',
};

const properties: PropertyWithStats[] = [
  {
    id: 'p1',
    accountId: 'acc1',
    nickname: null,
    addressLine1: '12 Maple St',
    city: 'Springfield',
    state: 'IL',
    zip: '62704',
    acquisitionDate: null,
    acquisitionCostCents: null,
    notes: null,
    createdAt: '2020-01-01T00:00:00.000Z',
    unitCount: 1,
    occupiedCount: 1,
    monthlyRentCents: 125000,
    statusLabel: 'Full',
  },
];

const fixtures: Record<string, unknown> = {
  '/api/v1/dashboard/kpis': kpis,
  '/api/v1/dashboard/cashflow-series': series,
  '/api/v1/dashboard/activity': activity,
  '/api/v1/dashboard/insight': insight,
  '/api/v1/properties': properties,
};

function fixtureFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
  const body = fixtures[path];
  if (body === undefined) {
    return Promise.resolve(
      new Response(JSON.stringify({ error: { code: 'not_found', message: `No fixture for ${path}` } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('accessibility smoke test', () => {
  it('AppShell + Dashboard has no axe violations', async () => {
    vi.stubGlobal('fetch', vi.fn(fixtureFetch));

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route path="/" element={<AppShell />}>
                <Route index element={<Dashboard />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );

    // Wait for all async sections to settle (KPIs, insight, activity).
    await screen.findByText('$8,450');
    await screen.findByText('T. Okafor is 6 days late on July rent');
    await screen.findByText(/j\. rivera paid/i);

    const results = await axe.run(container, {
      rules: {
        // jsdom does not lay out or paint — color-contrast can't be computed.
        'color-contrast': { enabled: false },
      },
    });

    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  }, 20_000);
});
