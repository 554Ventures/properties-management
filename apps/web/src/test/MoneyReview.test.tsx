// Bank-correction surface (WS5): "Bank changed these after you confirmed"
// renders above the normal review queue whenever GET
// /transactions/bank-discrepancies returns pending rows, and is absent when
// it doesn't. Diff line + rent-linked guided unlink covered per kind.
import { formatUsd } from '@hearth/shared';
import type {
  BankDiscrepancyRow,
  RentChargeOption,
  ReviewQueueItem,
  ReviewQueueResponse,
} from '@hearth/shared';
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

// Manual rent charge picker (rent-match v2): a "Link to rent…" button on
// income cards opens a radio-group modal fed by GET /rent/open-charges —
// for deposits the heuristic missed entirely, not just an alternative to the
// AiChip suggestion.
const plainIncomeItem: ReviewQueueItem = {
  id: 'tx-income',
  accountId: 'acc1',
  propertyId: null,
  unitId: null,
  categoryId: null,
  date: '2026-07-04T00:00:00.000Z',
  amountCents: 115000,
  type: 'income',
  description: 'Zelle payment',
  vendor: null,
  source: 'bank',
  status: 'pending_review',
  classification: null,
  aiSuggestedCategoryId: null,
  aiConfidence: null,
  receiptUrl: null,
  createdAt: '2026-07-04T00:00:00.000Z',
  updatedAt: '2026-07-04T00:00:00.000Z',
  aiSuggestedCategoryName: null,
  rentMatch: null,
};

const reviewQueueWithPlainIncome: ReviewQueueResponse = {
  items: [plainIncomeItem],
  nextCursor: null,
  total: 1,
};

// Fits the deposit exactly (115000 remaining for a 115000 deposit).
const openChargeFits: RentChargeOption = {
  rentPaymentId: 'rp-fits',
  leaseId: 'l1',
  tenantName: 'T. Okafor',
  unitLabel: 'Main',
  propertyLabel: '21 Cedar Ct',
  period: '2026-07',
  remainingCents: 115000,
};

// Remaining (500.00) < the deposit (1,150.00) — must render disabled.
const openChargeTooSmall: RentChargeOption = {
  rentPaymentId: 'rp-too-small',
  leaseId: 'l2',
  tenantName: 'J. Rivera',
  unitLabel: 'Unit B',
  propertyLabel: '12 Maple St',
  period: '2026-06',
  remainingCents: 50000,
};

describe('MoneyReview manual rent charge picker', () => {
  it('lists open charges, disables one exceeding the deposit with a visible note, and arming a choice puts its rentPaymentId in the confirm body', async () => {
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/transactions/review', body: reviewQueueWithPlainIncome },
      { method: 'GET', path: '/api/v1/categories', body: [] },
      { method: 'GET', path: '/api/v1/properties', body: [] },
      {
        method: 'GET',
        path: '/api/v1/rent/open-charges',
        body: { items: [openChargeFits, openChargeTooSmall] },
      },
      { method: 'POST', path: '/api/v1/transactions/tx-income/confirm', body: {} },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderMoneyReview();

    await screen.findByText('Zelle payment');
    // The manual button is a plain secondary button, not an AiChip/AiSurface.
    fireEvent.click(screen.getByRole('button', { name: 'Link to rent…' }));

    const dialog = await screen.findByRole('dialog', { name: 'Link to a rent charge' });
    await within(dialog).findByText(/T\. Okafor/);

    const fitsRadio = within(dialog).getByRole('radio', {
      name: `T. Okafor — Jul 2026 — 21 Cedar Ct · Main — ${formatUsd(115000)} remaining`,
    });
    expect(fitsRadio).not.toBeDisabled();

    const tooSmallRadio = within(dialog).getByRole('radio', {
      name: `J. Rivera — Jun 2026 — 12 Maple St · Unit B — ${formatUsd(50000)} remaining`,
    });
    expect(tooSmallRadio).toBeDisabled();
    // Visible text note, not color alone.
    expect(within(dialog).getByText('deposit exceeds remaining')).toBeInTheDocument();

    const linkButton = within(dialog).getByRole('button', { name: 'Link' });
    expect(linkButton).toBeDisabled();

    fireEvent.click(fitsRadio);
    expect(linkButton).not.toBeDisabled();
    fireEvent.click(linkButton);

    expect(screen.queryByRole('dialog', { name: 'Link to a rent charge' })).not.toBeInTheDocument();
    expect(screen.getByText(/Confirming marks/)).toHaveTextContent(
      'Confirming marks T. Okafor’s Jul 2026 rent paid and files this under 21 Cedar Ct · Main as Rent.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/v1/transactions/tx-income/confirm' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeDefined();
      // linkSource 'manual' keeps the audit actor 'user' — a hand-picked
      // charge is not an accepted AI suggestion.
      expect((call![1] as RequestInit).body).toBe(
        JSON.stringify({ rentPaymentId: 'rp-fits', linkSource: 'manual' }),
      );
    });
    expect(
      await screen.findByText("Confirmed and marked T. Okafor's Jul 2026 rent paid."),
    ).toBeInTheDocument();
  });

  it('a manual pick replaces an already-accepted AI rent-match chip (mutually exclusive)', async () => {
    const suggestedItem: ReviewQueueItem = {
      ...plainIncomeItem,
      id: 'tx-suggested',
      rentMatch: {
        rentPaymentId: 'rp-suggested',
        leaseId: 'l3',
        tenantName: 'A. Nguyen',
        propertyId: 'p3',
        propertyLabel: '9 Birch Ave',
        unitId: 'u3',
        unitLabel: 'Unit 1',
        period: '2026-07',
        dueDate: '2026-07-01T00:00:00.000Z',
        amountCents: 115000,
        paidCents: 0,
        confidence: 0.9,
      },
    };
    const fetchMock = makeFetch([
      {
        method: 'GET',
        path: '/api/v1/transactions/review',
        body: { items: [suggestedItem], nextCursor: null, total: 1 },
      },
      { method: 'GET', path: '/api/v1/categories', body: [] },
      { method: 'GET', path: '/api/v1/properties', body: [] },
      { method: 'GET', path: '/api/v1/rent/open-charges', body: { items: [openChargeFits] } },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderMoneyReview();

    await screen.findByText('Zelle payment');
    fireEvent.click(screen.getByRole('button', { name: /suggests: A\. Nguyen/ }));
    expect(screen.getByText(/Confirming marks/)).toHaveTextContent(/A\. Nguyen/);

    fireEvent.click(screen.getByRole('button', { name: 'Link to rent…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link to a rent charge' });
    const fitsRadio = await within(dialog).findByRole('radio', {
      name: `T. Okafor — Jul 2026 — 21 Cedar Ct · Main — ${formatUsd(115000)} remaining`,
    });
    fireEvent.click(fitsRadio);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Link' }));

    // The manual pick replaced the chip's link — only one linked charge shown.
    expect(screen.getByText(/Confirming marks/)).toHaveTextContent(/T\. Okafor/);
    expect(screen.getByText(/Confirming marks/)).not.toHaveTextContent(/A\. Nguyen/);
  });
});
