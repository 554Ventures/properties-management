// InsightCard structured actions: allowed api_call actions execute the
// embedded REST route and then mark the insight actioned; non-allowlisted
// actions render disabled with a visible note (refused, never silent);
// navigate actions are plain in-app links; legacy actionLabel/actionTarget
// stays as the context link. Axe covers the card with every button variant.
import type { Insight } from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InsightCard } from '../components/ai/InsightCard';
import { ToastProvider } from '../components/ui/Toast';

function insight(overrides: Partial<Insight> = {}): Insight {
  return {
    id: 'i1',
    accountId: 'acc1',
    scope: 'tenant',
    type: 'late_rent',
    severity: 'warning',
    title: 'T. Okafor is 6 days late on July rent',
    body: 'Rent of $1,150.00 for 21 Cedar Ct was due on the 1st.',
    actionLabel: 'Review',
    actionTarget: '/rent?period=2026-07',
    action: null,
    propertyId: null,
    tenantId: 't-okafor',
    leaseId: null,
    dedupeKey: 'late_rent:t-okafor:2026-07',
    status: 'active',
    createdAt: '2026-07-03T08:00:00.000Z',
    ...overrides,
  };
}

const sendReminder: Insight['action'] = {
  label: 'Send reminder',
  action: {
    kind: 'api_call',
    method: 'POST',
    path: '/rent/reminders',
    body: { rentPaymentIds: ['rp1'] },
  },
};

function renderCard(data: Insight, initialEntry = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <InsightCard insight={data} />
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

describe('InsightCard structured actions', () => {
  it('executes an allowlisted api_call action, then marks the insight actioned', async () => {
    const calls = stubFetch();
    renderCard(insight({ action: sendReminder }));

    fireEvent.click(screen.getByRole('button', { name: 'Send reminder' }));

    await waitFor(() => {
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'POST /api/v1/rent/reminders',
        'POST /api/v1/insights/i1/actioned',
      ]);
    });
    expect(calls[0]?.body).toEqual({ rentPaymentIds: ['rp1'] });
  });

  it('keeps the legacy context link next to an api_call action', () => {
    stubFetch();
    renderCard(insight({ action: sendReminder }));

    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute(
      'href',
      '/rent?period=2026-07',
    );
  });

  it('renders a non-allowlisted api_call disabled with a visible note — never executes', () => {
    const calls = stubFetch();
    renderCard(
      insight({
        action: {
          label: 'Email the report',
          action: { kind: 'api_call', method: 'POST', path: '/reports/r1/email' },
        },
      }),
    );

    const button = screen.getByRole('button', { name: 'Email the report' });
    expect(button).toBeDisabled();
    expect(screen.getByText("This action isn't available here.")).toBeInTheDocument();
    fireEvent.click(button);
    expect(calls).toEqual([]);
  });

  it('renders a navigate action as an in-app link (no duplicate legacy link)', () => {
    stubFetch();
    renderCard(
      insight({
        type: 'renewal_window',
        actionLabel: 'Review renewals',
        actionTarget: '/tenants/t1',
        action: {
          label: 'Review renewals',
          action: { kind: 'navigate', to: '/tenants/t1' },
        },
      }),
    );

    const links = screen.getAllByRole('link', { name: 'Review renewals' });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/tenants/t1');
  });

  it('hides navigation that points at the page the card is on (contextual placements)', () => {
    stubFetch();
    // Legacy "Review" → /rent?period=… while the card sits on /rent.
    renderCard(insight({ action: sendReminder }), '/rent');
    expect(screen.queryByRole('link', { name: 'Review' })).not.toBeInTheDocument();
    // The executable action and Dismiss are unaffected.
    expect(screen.getByRole('button', { name: 'Send reminder' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('hides a same-page navigate action too (e.g. underperforming card on its own property page)', () => {
    stubFetch();
    renderCard(
      insight({
        type: 'underperforming_property',
        actionLabel: 'View property',
        actionTarget: '/properties/p1',
        action: {
          label: 'View property',
          action: { kind: 'navigate', to: '/properties/p1' },
        },
      }),
      '/properties/p1',
    );
    expect(screen.queryByRole('link', { name: 'View property' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('falls back to the legacy link when there is no structured action (old rows)', () => {
    stubFetch();
    renderCard(insight());

    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute(
      'href',
      '/rent?period=2026-07',
    );
    expect(screen.queryByText("This action isn't available here.")).not.toBeInTheDocument();
  });

  it('has no axe violations with an executable action rendered', async () => {
    stubFetch();
    const { container } = renderCard(insight({ action: sendReminder }));
    await screen.findByRole('button', { name: 'Send reminder' });

    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });
});
