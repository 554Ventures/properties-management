// Contextual AI placement: RentTracker surfaces the single newest late_rent
// insight (with its executable "Send reminder" action) and Money surfaces the
// single newest expense_spike insight — each inside AiSurface/LiveRegion, and
// both pages pass axe with the card rendered (merge-blocking a11y bar).
// Also covers the ?period= deep link selecting the RentTracker period.
import type { Insight, RentTrackerResponse, Transaction } from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui/Toast';
import { currentPeriod, recentPeriods } from '../lib/format';
import { ContractorsPage } from '../pages/ContractorsPage';
import { Money } from '../pages/Money';
import { RentTracker } from '../pages/RentTracker';

const period = currentPeriod();

const lateRentInsight: Insight = {
  id: 'i-late',
  accountId: 'acc1',
  scope: 'tenant',
  type: 'late_rent',
  severity: 'warning',
  title: 'T. Okafor is 6 days late on rent',
  body: 'Rent of $1,150.00 for 21 Cedar Ct was due on the 1st.',
  actionLabel: 'Review',
  actionTarget: `/rent?period=${period}`,
  action: {
    label: 'Send reminder',
    action: {
      kind: 'api_call',
      method: 'POST',
      path: '/rent/reminders',
      body: { rentPaymentIds: ['rp1'] },
    },
  },
  propertyId: 'p1',
  tenantId: 't1',
  leaseId: 'l1',
  dedupeKey: `late_rent:t-okafor:${period}`,
  status: 'active',
  createdAt: '2026-07-03T08:00:00.000Z',
};

const spikeInsight: Insight = {
  id: 'i-spike',
  accountId: 'acc1',
  scope: 'property',
  type: 'expense_spike',
  severity: 'warning',
  title: 'Utilities spending spiked at Birch Lane',
  body: 'Utilities came in at $640 this month vs a $380 three-month average.',
  actionLabel: 'View transactions',
  actionTarget: '/money?type=expense&categoryId=c-util&propertyId=p1',
  action: {
    label: 'View transactions',
    action: { kind: 'navigate', to: '/money?type=expense&categoryId=c-util&propertyId=p1' },
  },
  propertyId: 'p1',
  tenantId: null,
  leaseId: null,
  dedupeKey: `expense_spike:utilities:birch-lane:${period}`,
  status: 'active',
  createdAt: '2026-07-03T08:00:00.000Z',
};

const contractorSpikeInsight: Insight = {
  id: 'i-contractor',
  accountId: 'acc1',
  scope: 'portfolio',
  type: 'contractor_cost_spike',
  severity: 'info',
  title: "Testy Plumbing's latest job cost well above their usual",
  body: '$450 for "Emergency pipe repair" vs their $200 average across 3 earlier jobs.',
  actionLabel: 'View contractor',
  actionTarget: '/maintenance/contractors/c1',
  action: {
    label: 'View contractor',
    action: { kind: 'navigate', to: '/maintenance/contractors/c1' },
  },
  propertyId: null,
  tenantId: null,
  leaseId: null,
  dedupeKey: `contractor_cost_spike:testy-plumbing:${period}`,
  status: 'active',
  createdAt: '2026-07-03T08:00:00.000Z',
};

const tracker: RentTrackerResponse = {
  period,
  collectedCents: 250000,
  outstandingCents: 115000,
  paidUnits: 2,
  partialUnits: 0,
  totalUnits: 3,
  rows: [
    {
      rentPaymentId: 'rp1',
      leaseId: 'l1',
      tenantId: 't1',
      tenantName: 'T. Okafor',
      unitId: 'u1',
      unitLabel: 'Main',
      propertyId: 'p1',
      propertyLabel: '21 Cedar Ct',
      amountCents: 115000,
      paidCents: 0,
      lateFeeCents: 0,
      dueDate: '2026-07-01T00:00:00.000Z',
      status: 'late',
      daysLate: 6,
      method: null,
      paidAt: null,
      deposits: [],
      tenants: [
        {
          tenantId: 't1',
          tenantName: 'T. Okafor',
          isPrimary: true,
          shareCents: 115000,
          shareSpecified: false,
          paidCents: 0,
          settled: false,
        },
      ],
      sharesMismatch: false,
    },
  ],
};

const transaction: Transaction = {
  id: 'tx1',
  accountId: 'acc1',
  propertyId: 'p1',
  unitId: null,
  categoryId: 'c-util',
  date: '2026-07-02T00:00:00.000Z',
  amountCents: 64000,
  type: 'expense',
  description: 'City utilities',
  vendor: 'City Power & Water',
  source: 'manual',
  status: 'confirmed',
  classification: null,
  aiSuggestedCategoryId: null,
  aiConfidence: null,
  receiptUrl: null,
  createdAt: '2026-07-02T00:00:00.000Z',
  updatedAt: '2026-07-02T00:00:00.000Z',
};

function stubFetch(fixtures: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
      const body = fixtures[path];
      return Promise.resolve(
        new Response(
          JSON.stringify(
            body ?? { error: { code: 'not_found', message: `No fixture for ${path}` } },
          ),
          {
            status: body === undefined ? 404 : 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );
    }),
  );
}

function Providers({ children, initialEntry }: { children: ReactNode; initialEntry: string }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <main>{children}</main>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RentTracker contextual insight', () => {
  const fixtures = {
    '/api/v1/rent/tracker': tracker,
    '/api/v1/insights': [lateRentInsight, spikeInsight],
  };

  it('shows only the late_rent insight with its Send reminder action, passing axe', async () => {
    stubFetch(fixtures);
    const { container } = render(
      <Providers initialEntry="/rent">
        <Routes>
          <Route path="/rent" element={<RentTracker />} />
        </Routes>
      </Providers>,
    );

    expect(await screen.findByText('T. Okafor is 6 days late on rent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send reminder' })).toBeInTheDocument();
    // "Review" points at /rent — the page we're on — so it's hidden here.
    expect(screen.queryByRole('link', { name: 'Review' })).not.toBeInTheDocument();
    // The expense_spike insight belongs on Money, not here.
    expect(screen.queryByText(/Utilities spending spiked/)).not.toBeInTheDocument();

    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  }, 20_000);

  it('selects the period from a ?period= deep link', async () => {
    stubFetch(fixtures);
    const previous = recentPeriods()[1]!;
    render(
      <Providers initialEntry={`/rent?period=${previous}`}>
        <Routes>
          <Route path="/rent" element={<RentTracker />} />
        </Routes>
      </Providers>,
    );

    expect(await screen.findByLabelText('Period')).toHaveValue(previous);
  });
});

describe('Contractors contextual insight', () => {
  it('shows only the contractor_cost_spike insight with its detail link, passing axe', async () => {
    stubFetch({
      '/api/v1/contractors': [
        {
          id: 'c1',
          name: 'Testy Plumbing',
          trade: 'Plumbing',
          rating: 4.5,
          phone: null,
          email: null,
          website: null,
          notes: null,
          jobsCount: 4,
          avgCostCents: 26250,
          lastUsedAt: '2026-07-02T00:00:00.000Z',
        },
      ],
      '/api/v1/insights': [contractorSpikeInsight, lateRentInsight, spikeInsight],
    });
    const { container } = render(
      <Providers initialEntry="/maintenance/contractors">
        <Routes>
          <Route path="/maintenance/contractors" element={<ContractorsPage />} />
        </Routes>
      </Providers>,
    );

    expect(
      await screen.findByText("Testy Plumbing's latest job cost well above their usual"),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View contractor' })).toHaveAttribute(
      'href',
      '/maintenance/contractors/c1',
    );
    // Other insight kinds belong on their own pages.
    expect(screen.queryByText(/days late on rent/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Utilities spending spiked/)).not.toBeInTheDocument();

    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  }, 20_000);
});

describe('Money contextual insight', () => {
  it('shows only the expense_spike insight, passing axe', async () => {
    stubFetch({
      '/api/v1/transactions': { items: [transaction], nextCursor: null, total: 1 },
      '/api/v1/transactions/review': { items: [], nextCursor: null, total: 0 },
      '/api/v1/categories': [{ id: 'c-util', name: 'Utilities', type: 'expense' }],
      '/api/v1/properties': [],
      '/api/v1/integrations': [],
      '/api/v1/insights': [lateRentInsight, spikeInsight],
    });
    const { container } = render(
      <Providers initialEntry="/money">
        <Routes>
          <Route path="/money" element={<Money />} />
        </Routes>
      </Providers>,
    );

    expect(await screen.findByText('Utilities spending spiked at Birch Lane')).toBeInTheDocument();
    // Its link points back at /money — the page we're on — so it's hidden;
    // the card informs, the table's own filters are right below.
    expect(screen.queryByRole('link', { name: 'View transactions' })).not.toBeInTheDocument();
    // The late_rent insight belongs on Rent Collection, not here.
    expect(screen.queryByText(/days late on rent/)).not.toBeInTheDocument();

    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  }, 20_000);
});
