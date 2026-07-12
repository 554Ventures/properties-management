// InsightDeck: active insights as a stack — highest severity on top, a
// position readout with wrap-around Previous/Next cycling, no deck chrome for
// a single card, and axe-clean with the controls rendered. Insights sharing a
// type+severity merge into one grouped card (InsightGroupCard) whose batch
// button executes each member's own allowlisted api_call and marks each
// insight actioned individually.
import type { Insight } from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InsightDeck, groupInsightsForDeck } from '../components/ai/InsightDeck';
import { ToastProvider } from '../components/ui/Toast';

function insight(overrides: Partial<Insight> & Pick<Insight, 'id' | 'severity' | 'title'>): Insight {
  return {
    accountId: 'acc1',
    scope: 'portfolio',
    type: `type-${overrides.id}`, // unique by default so classic deck tests stay ungrouped
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

function lateRent(id: string, tenant: string): Insight {
  return insight({
    id,
    severity: 'warning',
    type: 'late_rent',
    title: `${tenant} is 11 days late on rent`,
    action: {
      label: 'Send reminder',
      action: {
        kind: 'api_call',
        method: 'POST',
        path: '/rent/reminders',
        body: { rentPaymentIds: [`rp-${id}`] },
      },
    },
  });
}

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

function stubFetch() {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '');
      calls.push({
        method: init?.method ?? 'GET',
        path,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return Promise.resolve(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe('InsightDeck grouping', () => {
  const fourLate = [
    lateRent('l1', 'G. Almeida'),
    lateRent('l2', 'E. Fontaine'),
    lateRent('l3', 'C. Marsh'),
    lateRent('l4', 'P. Iyer'),
  ];

  it('merges same type+severity into one group, in severity order', () => {
    const groups = groupInsightsForDeck([
      ...fourLate,
      insight({ id: 'x', severity: 'info', title: 'Solo info', type: 'expense_spike' }),
    ]);
    expect(groups.map((g) => g.length)).toEqual([4, 1]);
  });

  it('renders a grouped card with a plural title, member rows, and a deck count of groups', () => {
    stubFetch();
    renderDeck([
      ...fourLate,
      insight({ id: 'x', severity: 'info', title: 'Water bill spiked', type: 'expense_spike' }),
    ]);

    expect(screen.getByText('4 tenants are late on rent')).toBeInTheDocument();
    expect(screen.getByText('G. Almeida is 11 days late on rent')).toBeInTheDocument();
    expect(screen.getByText('P. Iyer is 11 days late on rent')).toBeInTheDocument();
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
  });

  it('per-row action executes only that member and marks it actioned', async () => {
    const calls = stubFetch();
    renderDeck(fourLate);

    fireEvent.click(
      screen.getByRole('button', { name: 'Send reminder — E. Fontaine is 11 days late on rent' }),
    );

    await waitFor(() => {
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'POST /api/v1/rent/reminders',
        'POST /api/v1/insights/l2/actioned',
      ]);
    });
    expect(calls[0]?.body).toEqual({ rentPaymentIds: ['rp-l2'] });
  });

  it('the batch button executes every member action, each individually marked actioned', async () => {
    const calls = stubFetch();
    renderDeck(fourLate);

    fireEvent.click(screen.getByRole('button', { name: 'Send reminder for all 4' }));

    await waitFor(() => {
      expect(calls.filter((c) => c.path.endsWith('/rent/reminders'))).toHaveLength(4);
      expect(calls.filter((c) => c.path.includes('/actioned'))).toHaveLength(4);
    });
    expect(calls.map((c) => c.body).filter(Boolean)).toContainEqual({
      rentPaymentIds: ['rp-l3'],
    });
  });

  it('Dismiss all dismisses every member', async () => {
    const calls = stubFetch();
    renderDeck(fourLate);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss all' }));

    await waitFor(() => {
      expect(calls.map((c) => c.path)).toEqual([
        '/api/v1/insights/l1/dismiss',
        '/api/v1/insights/l2/dismiss',
        '/api/v1/insights/l3/dismiss',
        '/api/v1/insights/l4/dismiss',
      ]);
    });
  });

  it('collapses past 6 rows behind a Show all toggle', () => {
    stubFetch();
    const eight = Array.from({ length: 8 }, (_, i) => lateRent(`m${i}`, `Tenant ${i}`));
    renderDeck(eight);

    expect(screen.getByText('Tenant 5 is 11 days late on rent')).toBeInTheDocument();
    expect(screen.queryByText('Tenant 6 is 11 days late on rent')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all 8' }));
    expect(screen.getByText('Tenant 7 is 11 days late on rent')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.queryByText('Tenant 7 is 11 days late on rent')).not.toBeInTheDocument();
  });

  it('grouped card has no axe violations', async () => {
    stubFetch();
    const { container } = renderDeck(fourLate);
    await screen.findByRole('button', { name: 'Send reminder for all 4' });
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
