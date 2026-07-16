// Bank-correction surface (WS5): "Bank changed these after you confirmed"
// renders above the normal review queue whenever GET
// /transactions/bank-discrepancies returns pending rows, and is absent when
// it doesn't. Diff line + rent-linked guided unlink covered per kind.
import { formatUsd } from '@hearth/shared';
import type { BankDiscrepancyRow, ReviewQueueResponse } from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, ToastViewport } from '../components/ui/Toast';
import { formatShortDate } from '../lib/format';
import { MoneyReview } from '../pages/MoneyReview';

const emptyReviewQueue: ReviewQueueResponse = { items: [], nextCursor: null, total: 0 };

// $128.00 → $132.50, Jul 3 → Jul 5 — both amount and date differ so the diff
// line exercises the "show only fields that actually differ" join.
const modifiedRow: BankDiscrepancyRow = {
  id: 'bd-modified',
  provider: 'plaid',
  kind: 'modified',
  externalId: 'ext-1',
  bankData: {
    date: '2026-07-05T00:00:00.000Z',
    amountCents: 13250,
    type: 'expense',
    description: 'Water bill',
    vendor: 'City Utilities',
  },
  createdAt: '2026-07-06T00:00:00.000Z',
  transaction: {
    id: 'tx-1',
    description: 'Water bill',
    vendor: 'City Utilities',
    amountCents: 12800,
    date: '2026-07-03T00:00:00.000Z',
    type: 'expense',
    status: 'confirmed',
    categoryName: 'Utilities',
  },
};

// A voided rent deposit — carries the guided-unlink context.
const removedRentLinkedRow: BankDiscrepancyRow = {
  id: 'bd-removed',
  provider: 'stripe_fc',
  kind: 'removed',
  externalId: 'ext-2',
  bankData: null,
  createdAt: '2026-07-06T00:00:00.000Z',
  transaction: {
    id: 'tx-2',
    description: 'ACH CREDIT — RENT T OKAFOR',
    vendor: 'ACH transfer',
    amountCents: 115000,
    date: '2026-07-01T00:00:00.000Z',
    type: 'income',
    status: 'confirmed',
    categoryName: 'Rent',
  },
  rentPaymentId: 'rp1',
  depositId: 'dep1',
  rentPeriod: '2026-07',
};

interface RouteFixture {
  method: string;
  path: string;
  status?: number;
  body?: unknown;
}

function makeFetch(routes: RouteFixture[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    const method = (init?.method ?? 'GET').toUpperCase();
    const match = routes.find((r) => r.path === url && r.method === method);
    if (!match) {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: url } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(match.body === undefined ? null : JSON.stringify(match.body), {
      status: match.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function renderMoneyReview() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/money/review']}>
          <Routes>
            <Route path="/money/review" element={<MoneyReview />} />
          </Routes>
        </MemoryRouter>
        <ToastViewport />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const baseRoutes: RouteFixture[] = [
  { method: 'GET', path: '/api/v1/transactions/review', body: emptyReviewQueue },
  { method: 'GET', path: '/api/v1/categories', body: [] },
  { method: 'GET', path: '/api/v1/properties', body: [] },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MoneyReview bank-correction section', () => {
  it('is absent when the discrepancy list is empty', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        ...baseRoutes,
        { method: 'GET', path: '/api/v1/transactions/bank-discrepancies', body: { items: [] } },
      ]),
    );
    renderMoneyReview();

    await screen.findByText("You're all caught up");
    expect(
      screen.queryByText('Bank changed these after you confirmed'),
    ).not.toBeInTheDocument();
  });

  it('renders a restated diff for a modified row and "Removed by your bank" for a removed row', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        ...baseRoutes,
        {
          method: 'GET',
          path: '/api/v1/transactions/bank-discrepancies',
          body: { items: [modifiedRow, removedRentLinkedRow] },
        },
      ]),
    );
    renderMoneyReview();

    expect(
      await screen.findByText('Bank changed these after you confirmed'),
    ).toBeInTheDocument();

    // Modified row: only the fields that actually differ (amount + date).
    // Dates render through formatShortDate (local-timezone display, same as
    // the app), so the expected string is computed rather than hardcoded.
    const expectedDiff = [
      `${formatUsd(12800)} → ${formatUsd(13250)}`,
      `${formatShortDate(modifiedRow.transaction!.date)} → ${formatShortDate(modifiedRow.bankData!.date)}`,
    ].join(' · ');
    expect(screen.getByText(expectedDiff)).toBeInTheDocument();

    // Removed row: icon + text, not color alone.
    expect(screen.getByText('Removed by your bank')).toBeInTheDocument();
  });

  it('shows the guided-unlink note and button for a rent-linked row, and unlinking clears them', async () => {
    const fetchMock = makeFetch([
      ...baseRoutes,
      {
        method: 'GET',
        path: '/api/v1/transactions/bank-discrepancies',
        body: { items: [removedRentLinkedRow] },
      },
      {
        method: 'DELETE',
        path: '/api/v1/rent/payments/rp1/deposits/dep1',
        status: 204,
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderMoneyReview();

    await screen.findByText('Bank changed these after you confirmed');
    expect(screen.getByText(/This transaction backs/)).toHaveTextContent(
      'This transaction backs Jul 2026 rent.',
    );
    const unlinkButton = screen.getByRole('button', { name: 'Unlink deposit' });
    expect(unlinkButton).toBeInTheDocument();

    fireEvent.click(unlinkButton);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === '/api/v1/rent/payments/rp1/deposits/dep1' &&
            (init as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true);
    });
    expect(await screen.findByText(/Deposit unlinked/)).toBeInTheDocument();
  });

  it('Accept bank version calls the accept endpoint; a 400 surfaces the server message via toast', async () => {
    const fetchMock = makeFetch([
      ...baseRoutes,
      {
        method: 'GET',
        path: '/api/v1/transactions/bank-discrepancies',
        body: { items: [modifiedRow] },
      },
      {
        method: 'POST',
        path: '/api/v1/transactions/bank-discrepancies/bd-modified/accept',
        status: 400,
        body: { error: { code: 'bad_request', message: 'this bank change has already been resolved' } },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderMoneyReview();

    const row = (await screen.findByText('Water bill')).closest('div')!.parentElement!
      .parentElement!;
    fireEvent.click(within(row).getByRole('button', { name: 'Accept bank version' }));

    expect(
      await screen.findByText('this bank change has already been resolved'),
    ).toBeInTheDocument();
  });

  it('Keep my version calls the dismiss endpoint', async () => {
    const fetchMock = makeFetch([
      ...baseRoutes,
      {
        method: 'GET',
        path: '/api/v1/transactions/bank-discrepancies',
        body: { items: [modifiedRow] },
      },
      {
        method: 'POST',
        path: '/api/v1/transactions/bank-discrepancies/bd-modified/dismiss',
        body: { id: 'bd-modified', status: 'dismissed', resolvedAt: '2026-07-15T00:00:00.000Z' },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderMoneyReview();

    await screen.findByText('Water bill');
    fireEvent.click(screen.getByRole('button', { name: 'Keep my version' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => String(url) === '/api/v1/transactions/bank-discrepancies/bd-modified/dismiss',
        ),
      ).toBe(true);
    });
    expect(
      await screen.findByText('Kept your version — the bank change is dismissed.'),
    ).toBeInTheDocument();
  });
});
