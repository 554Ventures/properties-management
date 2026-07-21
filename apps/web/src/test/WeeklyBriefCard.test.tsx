// WeeklyBriefCard (W1): the latest weekly brief renders inside AiSurface
// (binding "AI-authored content is visually marked" rule), item actions gate
// through the one chat action allowlist (allowed api_call executes the REST
// route + toasts; anything else renders disabled with a visible note), the
// footer links to the archived report, and a null response (no brief yet)
// renders nothing at all.
import type { WeeklyBriefLatestResponse } from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeeklyBriefCard } from '../components/ai/WeeklyBriefCard';
import { ToastProvider, ToastViewport } from '../components/ui/Toast';

const latest: NonNullable<WeeklyBriefLatestResponse> = {
  report: {
    id: 'r-brief',
    accountId: 'acc1',
    type: 'weekly_brief',
    title: 'Weekly brief — Jul 13 – Jul 19, 2026',
    periodStart: '2026-07-13T04:00:00.000Z',
    periodEnd: '2026-07-20T04:00:00.000Z',
    taxYear: null,
    propertyId: null,
    generatedAt: '2026-07-20T09:00:00.000Z',
  },
  brief: {
    weekStart: '2026-07-13T04:00:00.000Z',
    weekEnd: '2026-07-20T04:00:00.000Z',
    weekLabel: 'Jul 13 – Jul 19, 2026',
    headline: '1 tenant is behind on rent — $1,150 outstanding',
    summary:
      "You've collected $12,545 in rent for July so far, with $1,150 still outstanding.\n\n6 transactions were recorded this week.",
    items: [
      {
        text: 'T. Okafor is 6 days late — $1,150 still owed.',
        action: {
          label: 'Send reminder',
          action: {
            kind: 'api_call',
            method: 'POST',
            path: '/rent/reminders',
            body: { rentPaymentIds: ['rp1'] },
          },
        },
      },
      {
        text: '3 imported transactions are waiting in the review queue.',
        action: {
          label: 'Review transactions',
          action: { kind: 'navigate', to: '/money/review' },
        },
      },
    ],
    stats: {
      rentCollectedCents: 1254500,
      rentOutstandingCents: 115000,
      lateCount: 1,
      newTransactionCount: 6,
      pendingReviewCount: 3,
      leasesEndingSoonCount: 0,
    },
  },
};

function makeFetch(body: WeeklyBriefLatestResponse, extraPost?: () => Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && extraPost) return extraPost();
    if (method === 'GET' && path === '/api/v1/reports/weekly-brief/latest') {
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: path } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <WeeklyBriefCard />
        </MemoryRouter>
        <ToastViewport />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WeeklyBriefCard', () => {
  it('renders the headline, week label, and items inside AiSurface with the ✦ AI badge', async () => {
    vi.stubGlobal('fetch', makeFetch(latest));
    const { container } = renderCard();

    expect(
      await screen.findByText('1 tenant is behind on rent — $1,150 outstanding'),
    ).toBeInTheDocument();
    expect(screen.getByText('Jul 13 – Jul 19, 2026')).toBeInTheDocument();
    expect(screen.getByText('T. Okafor is 6 days late — $1,150 still owed.')).toBeInTheDocument();
    // The ✦ AI badge marks the brief as AI-authored (binding AiSurface rule).
    expect(screen.getByText('AI')).toBeInTheDocument();
    expect(container.querySelector('.ai-frame')).not.toBeNull();

    // The navigate item renders as an in-app link.
    expect(screen.getByRole('link', { name: 'Review transactions' })).toHaveAttribute(
      'href',
      '/money/review',
    );

    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });

  it('executes an allowlisted api_call item through the REST client and toasts', async () => {
    const fetchMock = makeFetch(
      latest,
      () =>
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: 'Send reminder' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/v1/rent/reminders' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeDefined();
      expect((call![1] as RequestInit).body).toBe(JSON.stringify({ rentPaymentIds: ['rp1'] }));
    });
    expect(await screen.findByText('Done — Send reminder.')).toBeInTheDocument();
  });

  it('renders a non-allowlisted action disabled with a visible note, and never executes it', async () => {
    const blocked: WeeklyBriefLatestResponse = {
      ...latest,
      brief: {
        ...latest.brief,
        items: [
          {
            text: 'Email the report to your accountant.',
            action: {
              label: 'Email report',
              action: {
                kind: 'api_call',
                method: 'POST',
                path: '/reports/r-brief/email',
                body: { to: 'a@example.com' },
              },
            },
          },
        ],
      },
    };
    const fetchMock = makeFetch(blocked);
    vi.stubGlobal('fetch', fetchMock);
    renderCard();

    const button = await screen.findByRole('button', { name: 'Email report' });
    expect(button).toBeDisabled();
    expect(screen.getByText("This action isn't available here.")).toBeInTheDocument();

    fireEvent.click(button);
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST'),
    ).toBe(false);
  });

  it('links "Read full brief" to the archived report', async () => {
    vi.stubGlobal('fetch', makeFetch(latest));
    renderCard();

    expect(await screen.findByRole('link', { name: 'Read full brief' })).toHaveAttribute(
      'href',
      '/reports/r-brief',
    );
  });

  it('renders nothing when no brief exists yet (null response)', async () => {
    const fetchMock = makeFetch(null);
    vi.stubGlobal('fetch', fetchMock);
    const { container } = renderCard();

    // Settle the query first — the card also renders null while pending, so
    // asserting emptiness before the null payload lands would pass against a
    // regressed data guard too. Wait for the fetch, then flush React Query's
    // setTimeout(0) notify so the post-settle render is what we assert on.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(screen.queryByText('Weekly brief')).not.toBeInTheDocument();
    expect(container.querySelector('.ai-frame')).toBeNull();
  });

  it('a mailto-composed reminder opens the shared modal instead of claiming a plain success', async () => {
    const fetchMock = makeFetch(
      latest,
      () =>
        new Response(
          JSON.stringify({
            results: [
              {
                rentPaymentId: 'rp1',
                status: 'sent',
                mailto: 'mailto:okafor%40example.com?subject=Rent',
                subject: 'Quick reminder — July rent',
                deliveredVia: 'mailto',
                to: 'okafor@example.com',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: 'Send reminder' }));

    // Nothing was emailed server-side — the composed mailto hand-off is the
    // honest report (same shared modal as the Rent page and chat cards).
    const dialog = await screen.findByRole('dialog', { name: 'Reminder composed' });
    expect(within(dialog).getByRole('link', { name: 'Open email' })).toHaveAttribute(
      'href',
      'mailto:okafor%40example.com?subject=Rent',
    );
    expect(screen.queryByText('Done — Send reminder.')).not.toBeInTheDocument();

    // The modal portals to document.body, so run axe over the whole document.
    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });
});
