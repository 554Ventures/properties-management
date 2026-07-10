// Reports page: the generated-reports table renders from a mocked list
// response with friendly type/scope labels, supports search + type filtering,
// and the page passes axe (merge-blocking a11y bar per ARCHITECTURE §8).
import type { Report, ReportTypeInfo } from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui/Toast';
import { Reports } from '../pages/Reports';

vi.mock('../state/chat', () => ({
  useChat: () => ({ openWithContext: vi.fn() }),
}));

const library: ReportTypeInfo[] = [
  {
    type: 'pnl',
    name: 'Profit & Loss',
    description: 'Income and expenses by category.',
    maturity: 'full',
    supportedFilters: ['taxYear', 'dateRange', 'property'],
  },
  {
    type: 'rent_roll',
    name: 'Rent Roll',
    description: 'Every active lease.',
    maturity: 'full',
    supportedFilters: ['property'],
  },
];

function report(overrides: Partial<Report> & Pick<Report, 'id' | 'type' | 'title'>): Report {
  return {
    accountId: 'acc1',
    periodStart: '2026-01-01T00:00:00.000Z',
    periodEnd: '2027-01-01T00:00:00.000Z',
    taxYear: 2026,
    propertyId: null,
    generatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const reports: Report[] = [
  report({ id: 'r1', type: 'pnl', title: 'Profit & Loss — 2026' }),
  report({ id: 'r2', type: 'rent_roll', title: 'Rent Roll — 2026', taxYear: null, propertyId: 'p1' }),
  report({ id: 'r3', type: 'pnl', title: 'Profit & Loss — 2025', taxYear: 2025 }),
];

const properties = [
  {
    id: 'p1',
    accountId: 'acc1',
    nickname: '88 Oak Ave',
    addressLine1: '88 Oak Ave',
    city: 'Springfield',
    state: 'IL',
    zip: '62704',
    acquisitionDate: null,
    acquisitionCostCents: null,
    notes: null,
    createdAt: '2020-01-01T00:00:00.000Z',
    archivedAt: null,
    unitCount: 2,
    occupiedCount: 2,
    monthlyRentCents: 250000,
    statusLabel: 'Full',
  },
];

const fixtures: Record<string, unknown> = {
  '/api/v1/reports/library': library,
  '/api/v1/reports': reports,
  '/api/v1/properties': properties,
};

function fixtureFetch(input: RequestInfo | URL): Promise<Response> {
  const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
  const body = fixtures[path];
  return Promise.resolve(
    new Response(
      JSON.stringify(body ?? { error: { code: 'not_found', message: `No fixture for ${path}` } }),
      {
        status: body === undefined ? 404 : 200,
        headers: { 'Content-Type': 'application/json' },
      },
    ),
  );
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/reports']}>
          <Routes>
            <Route
              path="/reports"
              element={
                <main>
                  <Reports />
                </main>
              }
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Reports generated table', () => {
  it('renders report rows with friendly type and scope labels', async () => {
    vi.stubGlobal('fetch', vi.fn(fixtureFetch));
    renderPage();

    expect(await screen.findByRole('link', { name: 'Profit & Loss — 2026' })).toBeInTheDocument();
    // Scope column: portfolio-wide vs. the property's nickname.
    expect(screen.getAllByRole('cell', { name: 'Whole portfolio' })).toHaveLength(2);
    expect(screen.getByRole('cell', { name: '88 Oak Ave' })).toBeInTheDocument();
    // Sortable headers carry aria-sort.
    expect(screen.getByRole('columnheader', { name: /Generated/ })).toHaveAttribute(
      'aria-sort',
      'none',
    );
  });

  it('narrows rows with the search box', async () => {
    vi.stubGlobal('fetch', vi.fn(fixtureFetch));
    renderPage();
    await screen.findByRole('link', { name: 'Profit & Loss — 2026' });

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search reports' }), {
      target: { value: 'rent roll' },
    });

    expect(screen.getByRole('link', { name: 'Rent Roll — 2026' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Profit & Loss — 2026' })).not.toBeInTheDocument();
  });

  it('filters by report type from the header popover', async () => {
    vi.stubGlobal('fetch', vi.fn(fixtureFetch));
    renderPage();
    await screen.findByRole('link', { name: 'Profit & Loss — 2026' });

    fireEvent.click(screen.getByRole('button', { name: 'Filter by Type' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Rent Roll' }));

    expect(screen.getByRole('link', { name: 'Rent Roll — 2026' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Profit & Loss — 2026' })).not.toBeInTheDocument();
  });

  it('has no axe violations with the table rendered', async () => {
    vi.stubGlobal('fetch', vi.fn(fixtureFetch));
    const { container } = renderPage();
    await screen.findByRole('link', { name: 'Profit & Loss — 2026' });

    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });
});
