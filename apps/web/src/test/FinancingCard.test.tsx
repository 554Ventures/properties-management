// The Property hub's "Financing & value" card (PLAN-REAL-EQUITY Phase 1):
// mortgages, the latest owner-provided valuation, and the server-derived
// equity figure. Fixtures from propertyHubFixtures (makeMortgage/makeValuation
// /makeEquity) mirror the frozen @hearth/shared shapes.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { FinancingCard } from '../components/property/FinancingCard';
import { ToastProvider } from '../components/ui/Toast';
import { makeEquity, makeMortgage, makeValuation } from './propertyHubFixtures';

function renderCard(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('FinancingCard', () => {
  it('labels the asset figure owner-provided when equity is derived from a valuation', () => {
    renderCard(
      <FinancingCard
        propertyId="p1"
        title="12 Maple St"
        mortgages={[makeMortgage()]}
        latestValuation={makeValuation()}
        equity={makeEquity({ assetBasis: 'valuation' })}
        canProperties
      />,
    );
    expect(screen.getByText('Asset value (owner-provided)')).toBeInTheDocument();
    expect(screen.getByText('$138,000')).toBeInTheDocument(); // equityCents fixture
    expect(screen.queryByText(/asset value \(at cost\)/i)).not.toBeInTheDocument();
  });

  it('labels the asset figure at cost when no valuation feeds equity, so it is not mistaken for market equity', () => {
    renderCard(
      <FinancingCard
        propertyId="p1"
        title="12 Maple St"
        mortgages={[]}
        latestValuation={null}
        equity={makeEquity({ assetBasis: 'cost', assetValueCents: 25_000_000, equityCents: 25_000_000, liabilityCents: 0 })}
        canProperties
      />,
    );
    expect(screen.getByText('Asset value (at cost)')).toBeInTheDocument();
    expect(screen.queryByText(/owner-provided\)/i)).not.toBeInTheDocument();
  });

  it('renders an inviting empty state instead of a $0 equity figure when equity is null', () => {
    renderCard(
      <FinancingCard
        propertyId="p1"
        title="12 Maple St"
        mortgages={[]}
        latestValuation={null}
        equity={null}
        canProperties
      />,
    );
    expect(screen.getByText('Add a value to see equity')).toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
    // The empty state's own affordance, not just the header button.
    expect(screen.getAllByRole('button', { name: 'Record value' })).toHaveLength(2);
  });

  it('renders each mortgage with its derived balance, checkpoint date, and rate', () => {
    renderCard(
      <FinancingCard
        propertyId="p1"
        title="12 Maple St"
        mortgages={[makeMortgage({ currentBalanceCents: 18_150_000, interestRateMilliPct: 6375 })]}
        latestValuation={null}
        equity={null}
        canProperties
      />,
    );
    const table = screen.getByRole('table', { name: '12 Maple St — mortgages' });
    expect(within(table).getByText('First National Bank')).toBeInTheDocument();
    expect(within(table).getByText('$181,500.00')).toBeInTheDocument();
    expect(within(table).getByText('as of Jan 31, 2026')).toBeInTheDocument();
    expect(within(table).getByText('6.375%')).toBeInTheDocument();
  });

  it('hides every write affordance for a member without the properties permission', () => {
    renderCard(
      <FinancingCard
        propertyId="p1"
        title="12 Maple St"
        mortgages={[
          makeMortgage({ id: 'm-active' }),
          makeMortgage({ id: 'm-archived', archivedAt: '2026-01-01T00:00:00.000Z' }),
        ]}
        latestValuation={makeValuation()}
        equity={makeEquity()}
        canProperties={false}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Add mortgage' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record value' })).not.toBeInTheDocument();
    // The active mortgage row: no Update balance / Archive affordances.
    expect(screen.queryByRole('button', { name: /Update balance/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Archive/ })).not.toBeInTheDocument();

    // Reveal the archived row (the show/hide toggle itself is a read affordance,
    // ungated) — no Restore button for a member without properties.
    fireEvent.click(screen.getByRole('button', { name: 'Show archived (1)' }));
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();

    // Reads stay visible: the latest valuation line and history affordance.
    expect(screen.getByText(/Latest value/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Valuation history' })).toBeInTheDocument();
  });

  it('has no axe violations on a populated card', async () => {
    const { container } = renderCard(
      <FinancingCard
        propertyId="p1"
        title="12 Maple St"
        mortgages={[makeMortgage()]}
        latestValuation={makeValuation()}
        equity={makeEquity()}
        canProperties
      />,
    );
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });
});
