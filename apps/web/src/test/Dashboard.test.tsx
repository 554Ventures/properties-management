// Dashboard — "Operating income by property" chart renders the portfolio-
// level "Unassigned" bucket (WS2) alongside per-property rows: as a neutral-
// colored bar (not color-alone — the bar carries its own "Unassigned" label),
// in the chart's accessible description, in the "View as table" alternative,
// and with the reconciliation footnote. Omitted entirely when the API omits
// the bucket (the all-zero case).
import type {
  ActivityItem,
  DashboardKpisResponse,
  Insight,
  PropertyNoiResponse,
  PropertyWithStats,
} from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const noiWithUnassigned: PropertyNoiResponse = {
  month: '2026-07',
  properties: [
    {
      propertyId: 'p1',
      label: '12 Maple St',
      incomeCents: 125000,
      expenseCents: 31000,
      noiCents: 94000,
    },
  ],
  unassigned: { incomeCents: 12000, expenseCents: 4000, noiCents: 8000 },
};

const activity: ActivityItem[] = [];
const insights: Insight[] = [];
const properties: PropertyWithStats[] = [];
const onboardingState = { status: 'completed', steps: [] };

function fixtures(noiByProperty: PropertyNoiResponse): Record<string, unknown> {
  return {
    '/api/v1/dashboard/kpis': kpis,
    '/api/v1/dashboard/cashflow-series': [],
    '/api/v1/dashboard/expense-breakdown': { month: '2026-07', totalCents: 0, slices: [] },
    '/api/v1/dashboard/noi-by-property': noiByProperty,
    '/api/v1/dashboard/activity': activity,
    '/api/v1/insights': insights,
    '/api/v1/properties': properties,
    '/api/v1/onboarding': onboardingState,
  };
}

function fixtureFetch(fixtureMap: Record<string, unknown>) {
  return (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    const body = fixtureMap[path];
    if (body === undefined) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: 'not_found', message: `No fixture for ${path}` } }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderDashboard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Cards render with this class regardless of content — the stable way to
// scope a query to "the NOI chart's Card" when the page also has an earlier
// ChartContainer (the cashflow series chart) with its own "View as table".
function closestCard(el: HTMLElement): HTMLElement {
  const card = el.closest('.shadow-card');
  if (!card) throw new Error('expected an ancestor Card');
  return card as HTMLElement;
}

describe('Dashboard — operating income by property (unassigned bucket)', () => {
  it('renders the Unassigned bar, its label, the table row, and the footnote', async () => {
    vi.stubGlobal('fetch', vi.fn(fixtureFetch(fixtures(noiWithUnassigned))));
    renderDashboard();

    const chart = await screen.findByRole('img', { name: /operating income by property/i });
    // Not color-alone: the bucket is named in the chart's text alternative.
    expect(chart).toHaveAccessibleName(/Unassigned: \$80\b/);
    expect(chart).toHaveAccessibleName(/12 Maple St: \$940\b/);

    expect(
      screen.getByText('Includes unassigned transactions — totals match the dashboard KPIs.'),
    ).toBeInTheDocument();

    const card = closestCard(chart);
    fireEvent.click(within(card).getByRole('button', { name: 'View as table' }));
    const table = within(card).getByRole('table');
    expect(within(table).getByText('Unassigned')).toBeInTheDocument();
    expect(within(table).getByText('12 Maple St')).toBeInTheDocument();
    // Table cells format with cents (formatUsd), unlike the whole-dollar
    // chart description — $80.00 is the unassigned bucket's net.
    expect(within(table).getByText('$80.00')).toBeInTheDocument();
  });

  it('omits the Unassigned row and footnote when the API omits the (all-zero) bucket', async () => {
    const noiWithoutUnassigned: PropertyNoiResponse = {
      month: '2026-07',
      properties: noiWithUnassigned.properties,
    };
    vi.stubGlobal('fetch', vi.fn(fixtureFetch(fixtures(noiWithoutUnassigned))));
    renderDashboard();

    const chart = await screen.findByRole('img', { name: /operating income by property/i });
    expect(chart).not.toHaveAccessibleName(/Unassigned/);
    expect(
      screen.queryByText('Includes unassigned transactions — totals match the dashboard KPIs.'),
    ).not.toBeInTheDocument();
  });
});
