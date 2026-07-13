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
import { fireEvent, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContractorFormModal } from '../components/forms/ContractorFormModal';
import { LeaseFormModal } from '../components/forms/LeaseFormModal';
import { LeaseTenantsModal } from '../components/forms/LeaseTenantsModal';
import { PropertyFormModal } from '../components/forms/PropertyFormModal';
import { TenantFormModal } from '../components/forms/TenantFormModal';
import { TransactionEditModal } from '../components/forms/TransactionEditModal';
import { UnitFormModal } from '../components/forms/UnitFormModal';
import { OnboardingBanner } from '../components/onboarding/OnboardingBanner';
import { AppShell } from '../components/shell/AppShell';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { MultiSelect } from '../components/ui/MultiSelect';
import { ToastProvider } from '../components/ui/Toast';
import { ContractorDetail } from '../pages/ContractorDetail';
import { ContractorsPage } from '../pages/ContractorsPage';
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
  actionTarget: '/rent?period=2026-07',
  // Structured api_call action so the merge-blocking axe run covers the
  // "Send reminder" button (render only — nothing is clicked here).
  action: {
    label: 'Send reminder',
    action: {
      kind: 'api_call',
      method: 'POST',
      path: '/rent/reminders',
      body: { rentPaymentIds: ['rp1'] },
    },
  },
  propertyId: null,
  tenantId: 't-okafor',
  leaseId: null,
  dedupeKey: 'late_rent:t-okafor:2026-07',
  status: 'active',
  createdAt: '2026-07-03T08:00:00.000Z',
};

// Second insight so the Dashboard deck renders its cycle controls + stacked
// edge under axe.
const renewalInsight: Insight = {
  ...insight,
  id: 'i2',
  scope: 'portfolio',
  type: 'renewal_window',
  severity: 'info',
  title: '2 leases up for renewal in the next 60 days',
  body: 'Review terms and draft renewals before the leases lapse into month-to-month.',
  actionLabel: 'Review renewals',
  actionTarget: '/tenants?status=renew_soon',
  action: {
    label: 'Review renewals',
    action: { kind: 'navigate', to: '/tenants?status=renew_soon' },
  },
  tenantId: null,
  dedupeKey: 'renewal_window:2026-07',
  createdAt: '2026-07-02T08:00:00.000Z',
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

// In-progress so the dashboard smoke audits the onboarding banner (incl. its
// progress bar) alongside everything else.
const onboardingState = {
  status: 'in_progress',
  steps: [
    { id: 'add_property', state: 'completed' },
    { id: 'add_tenant', state: 'skipped' },
    { id: 'create_lease', state: 'pending' },
    { id: 'connect_bank', state: 'pending' },
  ],
};

const fixtures: Record<string, unknown> = {
  '/api/v1/dashboard/kpis': kpis,
  '/api/v1/dashboard/cashflow-series': series,
  '/api/v1/dashboard/expense-breakdown': expenseBreakdown,
  '/api/v1/dashboard/noi-by-property': noiByProperty,
  '/api/v1/dashboard/activity': activity,
  '/api/v1/insights': [renewalInsight, insight],
  '/api/v1/properties': properties,
  '/api/v1/onboarding': onboardingState,
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

  it('ContractorFormModal (create) has no axe violations', async () => {
    vi.stubGlobal('fetch', vi.fn(modalFetch));
    render(
      <Providers>
        <ContractorFormModal mode="create" open onClose={() => {}} />
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

describe('onboarding accessibility', () => {
  const onboardingFixtures: Record<string, unknown> = {
    '/api/v1/onboarding': onboardingState,
    '/api/v1/properties': [],
    '/api/v1/tenants': [],
  };

  function onboardingFetch(input: RequestInfo | URL): Promise<Response> {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    return Promise.resolve(
      new Response(JSON.stringify(onboardingFixtures[path] ?? []), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }

  it('OnboardingWizard (mixed step states) has no axe violations', async () => {
    vi.stubGlobal('fetch', vi.fn(onboardingFetch));
    render(
      <Providers>
        <OnboardingBanner />
      </Providers>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Continue setup' }));
    await expectNoModalViolations();
  });

  it('dismiss confirmation dialog has no axe violations', async () => {
    vi.stubGlobal('fetch', vi.fn(onboardingFetch));
    render(
      <Providers>
        <OnboardingBanner />
      </Providers>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await expectNoModalViolations();
  });
});

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

// --- Contractor directory ----------------------------------------------------

describe('contractor directory accessibility', () => {
  it('ContractorsPage with rows (incl. low-sample and no-history) has no axe violations', async () => {
    const contractorFixtures: Record<string, unknown> = {
      '/api/v1/contractors': [
        {
          id: 'c1',
          name: 'Mario Rossi',
          trade: 'Plumbing',
          rating: 4.9,
          jobsCount: 12,
          avgCostCents: 21000,
          lastUsedAt: '2026-06-15T00:00:00.000Z',
        },
        {
          id: 'c2',
          name: 'Ana Silva',
          trade: 'Painting',
          rating: 4.5,
          jobsCount: 2, // < 3 jobs → muted rating + visible "low sample" text
          avgCostCents: 89000,
          lastUsedAt: '2026-03-02T00:00:00.000Z',
        },
        {
          id: 'c3',
          name: 'Ken Watts',
          trade: 'HVAC',
          rating: null,
          jobsCount: 0,
          avgCostCents: null,
          lastUsedAt: null,
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
        const body = contractorFixtures[path];
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
          <MemoryRouter initialEntries={['/maintenance/contractors']}>
            <Routes>
              {/* Pages render inside AppShell's <main> in the app. */}
              <Route
                path="/maintenance/contractors"
                element={
                  <main>
                    <ContractorsPage />
                  </main>
                }
              />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );

    await screen.findByText('Mario Rossi');
    await screen.findByText('· low sample');

    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  }, 20_000);

  it('ContractorDetail with website and job history has no axe violations', async () => {
    const detailFixtures: Record<string, unknown> = {
      '/api/v1/contractors/c1': {
        contractor: {
          id: 'c1',
          accountId: 'a1',
          name: 'Mario Rossi',
          trade: 'Plumbing',
          rating: 4.9,
          phone: '555-0100',
          email: 'mario@rossi.example',
          website: 'rossiplumbing.com',
          notes: 'Fast and tidy.',
          createdAt: '2026-01-05T00:00:00.000Z',
          archivedAt: null,
        },
        jobsCount: 12,
        avgCostCents: 21000,
        lastUsedAt: '2026-06-15T00:00:00.000Z',
        jobs: [
          {
            id: 't1',
            date: '2026-06-15T00:00:00.000Z',
            description: 'Water heater replacement',
            amountCents: 48500,
            propertyLabel: 'Maple Duplex',
          },
          {
            id: 't2',
            date: '2026-05-02T00:00:00.000Z',
            description: 'Leak repair',
            amountCents: 18500,
            propertyLabel: null, // renders the em-dash path
          },
        ],
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
        const body = detailFixtures[path];
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
          <MemoryRouter initialEntries={['/maintenance/contractors/c1']}>
            <Routes>
              {/* Pages render inside AppShell's <main> in the app. */}
              <Route
                path="/maintenance/contractors/:id"
                element={
                  <main>
                    <ContractorDetail />
                  </main>
                }
              />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );

    await screen.findByRole('heading', { name: 'Mario Rossi' });
    await screen.findByText('Water heater replacement');

    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  }, 20_000);

  // LogJobModal (opened from ContractorDetail): audits both steps of the
  // "log a job manually" flow — the entry form, and the duplicate-review step
  // a `possible_duplicate` response switches into.
  function contractorJobFixtures(): Record<string, unknown> {
    return {
      '/api/v1/contractors/c1': {
        contractor: {
          id: 'c1',
          accountId: 'a1',
          name: 'Mario Rossi',
          trade: 'Plumbing',
          rating: 4.9,
          phone: '555-0100',
          email: 'mario@rossi.example',
          website: null,
          notes: null,
          createdAt: '2026-01-05T00:00:00.000Z',
          archivedAt: null,
        },
        jobsCount: 1,
        avgCostCents: 18500,
        lastUsedAt: '2026-06-15T00:00:00.000Z',
        jobs: [
          {
            id: 't1',
            date: '2026-06-15T00:00:00.000Z',
            description: 'Leak repair',
            amountCents: 18500,
            propertyLabel: null,
          },
        ],
      },
      '/api/v1/properties': properties,
    };
  }

  function stubContractorJobFetch(fixtures: Record<string, unknown>, postResponse?: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
        if (init?.method === 'POST' && path === '/api/v1/contractors/c1/jobs') {
          return Promise.resolve(
            new Response(JSON.stringify(postResponse ?? {}), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
        const body = fixtures[path];
        return Promise.resolve(
          new Response(JSON.stringify(body ?? { error: { code: 'not_found', message: path } }), {
            status: body === undefined ? 404 : 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }),
    );
  }

  function renderContractorDetail() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/maintenance/contractors/c1']}>
            <Routes>
              <Route
                path="/maintenance/contractors/:id"
                element={
                  <main>
                    <ContractorDetail />
                  </main>
                }
              />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
  }

  it('LogJobModal entry form has no axe violations', async () => {
    stubContractorJobFetch(contractorJobFixtures());
    renderContractorDetail();

    await screen.findByRole('heading', { name: 'Mario Rossi' });
    fireEvent.click(screen.getByRole('button', { name: 'Log a job' }));
    await expectNoModalViolations();
  }, 20_000);

  it('LogJobModal duplicate-review step has no axe violations', async () => {
    stubContractorJobFetch(contractorJobFixtures(), {
      status: 'possible_duplicate',
      duplicates: [
        {
          id: 't1',
          date: '2026-06-15T00:00:00.000Z',
          description: 'Leak repair',
          amountCents: 18500,
          propertyLabel: null,
        },
      ],
    });
    renderContractorDetail();

    await screen.findByRole('heading', { name: 'Mario Rossi' });
    fireEvent.click(screen.getByRole('button', { name: 'Log a job' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.input(within(dialog).getByLabelText(/^Description/), {
      target: { value: 'Leak repair' },
    });
    fireEvent.input(within(dialog).getByLabelText(/^Amount/), { target: { value: '185.00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Log job' }));

    await screen.findByText(/looks similar to 1 existing expense/);
    await expectNoModalViolations();
  }, 20_000);
});
