// Axe smoke test: AppShell + Dashboard rendered with mocked query data must
// produce zero axe violations (merge-blocking check per ARCHITECTURE §8).
import type {
  ActivityItem,
  DashboardKpisResponse,
  IncomeExpenseSeriesResponse,
  Insight,
  PropertyWithStats,
  ReviewQueueResponse,
  Transaction,
} from '@hearth/shared';
import type { LeaseDetailResponse } from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeaseFormModal } from '../components/forms/LeaseFormModal';
import { LeaseTenantsModal } from '../components/forms/LeaseTenantsModal';
import { PropertyFormModal } from '../components/forms/PropertyFormModal';
import { TenantFormModal } from '../components/forms/TenantFormModal';
import { TransactionEditModal } from '../components/forms/TransactionEditModal';
import { UnitFormModal } from '../components/forms/UnitFormModal';
import { AppShell } from '../components/shell/AppShell';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { MultiSelect } from '../components/ui/MultiSelect';
import { ToastProvider } from '../components/ui/Toast';
import { Dashboard } from '../pages/Dashboard';
import { MoneyReview } from '../pages/MoneyReview';

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

const expenseBreakdown = {
  month: '2026-07',
  totalCents: 311000,
  slices: [
    { categoryId: 'c-ins', categoryName: 'Insurance', amountCents: 78000 },
    { categoryId: 'c-util', categoryName: 'Utilities', amountCents: 64000 },
    { categoryId: 'c-hoa', categoryName: 'HOA Fees', amountCents: 50000 },
    { categoryId: 'c-rep', categoryName: 'Repairs', amountCents: 48000 },
    { categoryId: 'c-land', categoryName: 'Landscaping', amountCents: 31000 },
    { categoryId: 'c-clean', categoryName: 'Cleaning & Maintenance', amountCents: 22000 },
    { categoryId: 'c-sup', categoryName: 'Supplies', amountCents: 18000 },
  ],
};

const noiByProperty = {
  month: '2026-07',
  properties: [
    { propertyId: 'p2', label: '88 Oak Ave', incomeCents: 265000, expenseCents: 48000, noiCents: 217000 },
    { propertyId: 'p1', label: '12 Maple St', incomeCents: 125000, expenseCents: 31000, noiCents: 94000 },
  ],
};

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
    archivedAt: null,
    unitCount: 1,
    occupiedCount: 1,
    monthlyRentCents: 125000,
    statusLabel: 'Full',
  },
];

const fixtures: Record<string, unknown> = {
  '/api/v1/dashboard/kpis': kpis,
  '/api/v1/dashboard/cashflow-series': series,
  '/api/v1/dashboard/expense-breakdown': expenseBreakdown,
  '/api/v1/dashboard/noi-by-property': noiByProperty,
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

// --- CRUD modals -----------------------------------------------------------

const leaseDetailFixture: LeaseDetailResponse = {
  lease: {
    id: 'l1',
    unitId: 'u1',
    rentCents: 125000,
    dueDay: 1,
    startDate: '2025-08-01T12:00:00.000Z',
    endDate: '2026-07-31T12:00:00.000Z',
    status: 'active',
    esignEnvelopeId: null,
    esignStatus: null,
    createdAt: '2025-08-01T12:00:00.000Z',
    unitLabel: 'Unit A',
    propertyId: 'p1',
    propertyLabel: '12 Maple St',
    tenants: [
      {
        id: 't1',
        accountId: 'acc1',
        fullName: 'Alex Primary',
        email: null,
        phone: null,
        notes: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        archivedAt: null,
      },
    ],
  },
  rentPayments: [],
};

const modalFixtures: Record<string, unknown> = {
  '/api/v1/tenants': [],
  '/api/v1/leases/l1': leaseDetailFixture,
};

function modalFetch(input: RequestInfo | URL): Promise<Response> {
  const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
  const body = modalFixtures[path] ?? {};
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function Providers({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>{children}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

async function expectNoModalViolations() {
  const dialog = await screen.findByRole('dialog');
  const results = await axe.run(dialog, {
    rules: { 'color-contrast': { enabled: false } },
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

describe('CRUD modal accessibility', () => {
  it('PropertyFormModal (create) has no axe violations', async () => {
    vi.stubGlobal('fetch', vi.fn(modalFetch));
    render(
      <Providers>
        <PropertyFormModal mode="create" open onClose={() => {}} />
      </Providers>,
    );
    await expectNoModalViolations();
  });

  it('UnitFormModal (create) has no axe violations', async () => {
    vi.stubGlobal('fetch', vi.fn(modalFetch));
    render(
      <Providers>
        <UnitFormModal mode="create" open propertyId="p1" onClose={() => {}} />
      </Providers>,
    );
    await expectNoModalViolations();
  });

  it('TenantFormModal (create) has no axe violations', async () => {
    vi.stubGlobal('fetch', vi.fn(modalFetch));
    render(
      <Providers>
        <TenantFormModal mode="create" open onClose={() => {}} />
      </Providers>,
    );
    await expectNoModalViolations();
  });

  it('LeaseFormModal (create) has no axe violations', async () => {
    vi.stubGlobal('fetch', vi.fn(modalFetch));
    render(
      <Providers>
        <LeaseFormModal mode="create" open unitId="u1" unitLabel="Unit A" onClose={() => {}} />
      </Providers>,
    );
    await expectNoModalViolations();
  });

  it('LeaseTenantsModal has no axe violations', async () => {
    vi.stubGlobal('fetch', vi.fn(modalFetch));
    render(
      <Providers>
        <LeaseTenantsModal open leaseId="l1" onClose={() => {}} />
      </Providers>,
    );
    // Wait for the tenant roster to load before auditing.
    await screen.findByText('Alex Primary');
    await expectNoModalViolations();
  });

  it('ConfirmDialog has no axe violations', async () => {
    render(
      <Providers>
        <ConfirmDialog
          open
          onClose={() => {}}
          onConfirm={() => {}}
          title="Archive property"
          confirmLabel="Archive"
          body="Archiving hides this property but keeps its history."
        />
      </Providers>,
    );
    await expectNoModalViolations();
  });

  it('TransactionEditModal has no axe violations', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
        if (path === '/api/v1/properties') return fixtureFetch(input);
        return Promise.resolve(
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }),
    );
    render(
      <Providers>
        <TransactionEditModal open onClose={() => {}} transaction={importedTransaction} />
      </Providers>,
    );
    await expectNoModalViolations();
  });

  it('MultiSelect (open dropdown) has no axe violations', async () => {
    render(
      <Providers>
        <MultiSelect
          label="Tenants"
          placeholder="Search tenants…"
          options={[
            { value: 't1', label: 'Alex Primary', description: 'alex@example.com' },
            { value: 't2', label: 'Jordan Cotenant' },
          ]}
          value={['t1']}
          onChange={() => {}}
        />
      </Providers>,
    );
    // Open the portaled listbox before auditing (options live outside any dialog).
    fireEvent.focus(screen.getByRole('combobox'));
    await screen.findByRole('listbox');
    // Audit the whole body (the listbox is portaled out of the control). The
    // page-level 'region' landmark rule doesn't apply to an isolated component.
    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

// --- Review queue (rent match + attribution selects) -------------------------

const importedTransaction: Transaction = {
  id: 'tx-income',
  accountId: 'acc1',
  propertyId: null,
  unitId: null,
  categoryId: null,
  date: '2026-07-04T00:00:00.000Z',
  amountCents: 115000,
  type: 'income',
  description: 'ACH CREDIT — RENT T OKAFOR',
  vendor: 'ACH transfer',
  source: 'bank',
  status: 'pending_review',
  aiSuggestedCategoryId: 'c-rent',
  aiConfidence: 0.8,
  receiptUrl: null,
  createdAt: '2026-07-04T00:00:00.000Z',
  updatedAt: '2026-07-04T00:00:00.000Z',
};

const reviewQueue: ReviewQueueResponse = {
  items: [
    {
      ...importedTransaction,
      aiSuggestedCategoryName: 'Rent',
      rentMatch: {
        rentPaymentId: 'rp1',
        leaseId: 'l1',
        tenantName: 'T. Okafor',
        propertyId: 'p1',
        propertyLabel: '21 Cedar Ct',
        unitId: 'u1',
        unitLabel: 'Main',
        period: '2026-07',
        dueDate: '2026-07-01T00:00:00.000Z',
        amountCents: 115000,
        confidence: 0.9,
      },
    },
    {
      ...importedTransaction,
      id: 'tx-expense',
      type: 'expense',
      description: 'LOWES #00907',
      vendor: "Lowe's",
      amountCents: 6875,
      aiSuggestedCategoryId: 'c-supplies',
      aiConfidence: 0.62,
      aiSuggestedCategoryName: 'Supplies',
      rentMatch: null,
    },
  ],
  nextCursor: null,
  total: 2,
};

describe('review queue accessibility', () => {
  it('MoneyReview with a rent match and attribution selects has no axe violations', async () => {
    const reviewFixtures: Record<string, unknown> = {
      '/api/v1/transactions/review': reviewQueue,
      '/api/v1/categories': [
        { id: 'c-rent', name: 'Rent', type: 'income' },
        { id: 'c-supplies', name: 'Supplies', type: 'expense' },
      ],
      '/api/v1/properties': properties,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
        const body = reviewFixtures[path];
        return Promise.resolve(
          new Response(JSON.stringify(body ?? { error: { code: 'not_found', message: path } }), {
            status: body === undefined ? 404 : 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }),
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/money/review']}>
            <Routes>
              <Route path="/money/review" element={<MoneyReview />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );

    // Rent-match chip + both items' selects rendered before auditing.
    await screen.findByText(/T\. Okafor's Jul 2026 rent/);
    await screen.findByText('LOWES #00907');

    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  }, 20_000);
});
