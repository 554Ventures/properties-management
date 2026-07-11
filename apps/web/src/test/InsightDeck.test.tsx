// InsightDeck: all active insights as a stack — highest severity on top, a
// position readout with wrap-around Previous/Next cycling, no deck chrome for
// a single card, and axe-clean with the controls rendered.
import type { Insight } from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { InsightDeck } from '../components/ai/InsightDeck';
import { ToastProvider } from '../components/ui/Toast';

function insight(overrides: Partial<Insight> & Pick<Insight, 'id' | 'severity' | 'title'>): Insight {
  return {
    accountId: 'acc1',
    scope: 'portfolio',
    type: 'renewal_window',
    body: 'Body text.',
    actionLabel: null,
    actionTarget: null,
    action: null,
    propertyId: null,
    tenantId: null,
    leaseId: null,
    dedupeKey: `key:${overrides.id}`,
    status: 'active',
    createdAt: '2026-07-03T08:00:00.000Z',
    ...overrides,
  };
}

const three: Insight[] = [
  insight({ id: 'a', severity: 'info', title: 'Older info card', createdAt: '2026-07-01T00:00:00.000Z' }),
  insight({ id: 'b', severity: 'warning', title: 'The warning card' }),
  insight({ id: 'c', severity: 'info', title: 'Newer info card', createdAt: '2026-07-02T00:00:00.000Z' }),
];

function renderDeck(insights: Insight[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <main>
            <InsightDeck insights={insights} />
          </main>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('InsightDeck', () => {
  it('puts the highest-severity insight on top with a position readout', () => {
    renderDeck(three);
    expect(screen.getByText('The warning card')).toBeInTheDocument();
    expect(screen.queryByText('Newer info card')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
  });

  it('cycles forward through severity-then-newest order and wraps around', () => {
    renderDeck(three);
    const next = screen.getByRole('button', { name: 'Next insight' });

    fireEvent.click(next);
    expect(screen.getByText('Newer info card')).toBeInTheDocument();
    expect(screen.getByText('2 of 3')).toBeInTheDocument();

    fireEvent.click(next);
    expect(screen.getByText('Older info card')).toBeInTheDocument();

    fireEvent.click(next); // wraps back to the top card
    expect(screen.getByText('The warning card')).toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
  });

  it('cycles backward with wrap-around', () => {
    renderDeck(three);
    fireEvent.click(screen.getByRole('button', { name: 'Previous insight' }));
    expect(screen.getByText('Older info card')).toBeInTheDocument();
    expect(screen.getByText('3 of 3')).toBeInTheDocument();
  });

  it('renders a single insight without deck chrome', () => {
    renderDeck([three[1]!]);
    expect(screen.getByText('The warning card')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next insight' })).not.toBeInTheDocument();
    expect(screen.queryByText(/1 of/)).not.toBeInTheDocument();
  });

  it('renders nothing for an empty list', () => {
    const { container } = renderDeck([]);
    expect(container.querySelector('section')).toBeNull();
  });

  it('has no axe violations with controls and stacked edges rendered', async () => {
    const { container } = renderDeck(three);
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
