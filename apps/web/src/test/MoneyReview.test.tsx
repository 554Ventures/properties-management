// Review queue tests, three groups:
//   1. the triage row itself — collapsed one-click confirm, every auto-expand
//      trigger, the expanded attribution grid, the warning strips, and the
//      settled-row mechanism that keeps the list from moving under the pointer
//   2. the manual rent charge picker (rent-match v2)
//   3. the mortgage-payment breakdown, and the bank-correction surface (WS5):
//      "Bank changed these after you confirmed" renders above the queue
//      whenever GET /transactions/bank-discrepancies returns pending rows.
import { formatUsd } from '@hearth/shared';
import type {
  BankDiscrepancyRow,
  Category,
  CurrentUser,
  LeaseDetailResponse,
  RentChargeOption,
  ReviewQueueItem,
  ReviewQueueResponse,
} from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, ToastViewport } from '../components/ui/Toast';
import { formatDate, formatShortDate } from '../lib/format';
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

// Per-row actions go through RowActions, which reads `(min-width: 768px)` via
// useMediaQuery — force the desktop inline-button layout (precedent:
// RowActions.test.tsx, RentTracker.test.tsx) so Dismiss is queryable without
// going through the mobile sheet.
function stubDesktopViewport() {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
    return {
      matches: query === '(min-width: 768px)',
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    } as MediaQueryList;
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

    // The primary action names the outcome it produces (an armed rent link
    // files the deposit as Rent), so "Confirm" alone no longer appears.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm as Rent' }));

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

// Rent deposit tenant attribution: a "Paid by" field wherever a deposit gets
// linked, offered only once the linked charge's lease turns out to have more
// than one tenant — the option list itself doesn't carry the roster, so it's
// fetched (GET /leases/:id) once a charge is chosen.
const sharedLeaseDetail: LeaseDetailResponse = {
  lease: {
    id: 'l1',
    unitId: 'u1',
    rentCents: 115000,
    dueDay: 1,
    lateFeeCents: null,
    startDate: '2025-08-01T12:00:00.000Z',
    endDate: '2026-07-31T12:00:00.000Z',
    status: 'active',
    esignEnvelopeId: null,
    esignStatus: null,
    createdAt: '2025-08-01T12:00:00.000Z',
    unitLabel: 'Main',
    propertyId: 'p1',
    propertyLabel: '21 Cedar Ct',
    tenants: [
      {
        id: 't-okafor',
        accountId: 'acc1',
        fullName: 'T. Okafor',
        email: null,
        phone: null,
        notes: null,
        createdAt: '2025-08-01T00:00:00.000Z',
        archivedAt: null,
        isPrimary: true,
        shareCents: 57500,
      },
      {
        id: 't-roommate',
        accountId: 'acc1',
        fullName: 'R. Diallo',
        email: null,
        phone: null,
        notes: null,
        createdAt: '2025-08-01T00:00:00.000Z',
        archivedAt: null,
        isPrimary: false,
        shareCents: 57500,
      },
    ],
  },
  rentPayments: [],
};

const soleLeaseDetail: LeaseDetailResponse = {
  ...sharedLeaseDetail,
  lease: { ...sharedLeaseDetail.lease, id: 'l2', tenants: [sharedLeaseDetail.lease.tenants[0]!] },
};

describe('MoneyReview rent deposit "Paid by" attribution', () => {
  it('the manual picker offers "Paid by" only for a multi-tenant charge, and sends the chosen tenant on confirm', async () => {
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/transactions/review', body: reviewQueueWithPlainIncome },
      { method: 'GET', path: '/api/v1/categories', body: [] },
      { method: 'GET', path: '/api/v1/properties', body: [] },
      {
        method: 'GET',
        path: '/api/v1/rent/open-charges',
        body: { items: [openChargeFits, openChargeTooSmall] },
      },
      { method: 'GET', path: '/api/v1/leases/l1', body: sharedLeaseDetail },
      { method: 'GET', path: '/api/v1/leases/l2', body: soleLeaseDetail },
      { method: 'POST', path: '/api/v1/transactions/tx-income/confirm', body: {} },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderMoneyReview();

    await screen.findByText('Zelle payment');
    fireEvent.click(screen.getByRole('button', { name: 'Link to rent…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link to a rent charge' });
    await within(dialog).findByText(/T\. Okafor/);

    // No charge picked yet — nothing to ask "paid by" about.
    expect(within(dialog).queryByLabelText('Paid by')).not.toBeInTheDocument();

    const fitsRadio = within(dialog).getByRole('radio', {
      name: `T. Okafor — Jul 2026 — 21 Cedar Ct · Main — ${formatUsd(115000)} remaining`,
    });
    fireEvent.click(fitsRadio);

    const tenantSelect = await within(dialog).findByLabelText('Paid by');
    expect(within(dialog).getByText('Not recorded')).toBeInTheDocument();
    fireEvent.change(tenantSelect, { target: { value: 't-roommate' } });

    const results = await axe.run(dialog, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm as Rent' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/v1/transactions/tx-income/confirm' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeDefined();
      expect((call![1] as RequestInit).body).toBe(
        JSON.stringify({ rentPaymentId: 'rp-fits', linkSource: 'manual', tenantId: 't-roommate' }),
      );
    });
  });

  it('offers no "Paid by" field for a single-tenant charge', async () => {
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/transactions/review', body: reviewQueueWithPlainIncome },
      { method: 'GET', path: '/api/v1/categories', body: [] },
      { method: 'GET', path: '/api/v1/properties', body: [] },
      { method: 'GET', path: '/api/v1/rent/open-charges', body: { items: [openChargeFits] } },
      { method: 'GET', path: '/api/v1/leases/l1', body: soleLeaseDetail },
      { method: 'POST', path: '/api/v1/transactions/tx-income/confirm', body: {} },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderMoneyReview();

    await screen.findByText('Zelle payment');
    fireEvent.click(screen.getByRole('button', { name: 'Link to rent…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link to a rent charge' });
    await within(dialog).findByText(/T\. Okafor/);
    fireEvent.click(
      within(dialog).getByRole('radio', {
        name: `T. Okafor — Jul 2026 — 21 Cedar Ct · Main — ${formatUsd(115000)} remaining`,
      }),
    );

    // The lease-detail fetch resolves with exactly one tenant — confirmed via
    // the request itself, then a settled poll for the field that never
    // appears (a single-tenant lease has exactly one possible answer).
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/v1/leases/l1')).toBe(true),
    );
    await waitFor(() => {
      expect(within(dialog).queryByLabelText('Paid by')).not.toBeInTheDocument();
    });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm as Rent' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/v1/transactions/tx-income/confirm' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeDefined();
      // No tenantId key at all — omitted, not sent empty.
      expect((call![1] as RequestInit).body).toBe(
        JSON.stringify({ rentPaymentId: 'rp-fits', linkSource: 'manual' }),
      );
    });
  });

  it('an accepted AI rent-match chip offers "Paid by" in the confirmation strip for a multi-tenant charge, and sends it on confirm', async () => {
    const suggestedItem: ReviewQueueItem = {
      ...plainIncomeItem,
      id: 'tx-suggested',
      rentMatch: {
        rentPaymentId: 'rp-suggested',
        leaseId: 'l1',
        tenantName: 'T. Okafor',
        propertyId: 'p1',
        propertyLabel: '21 Cedar Ct',
        unitId: 'u1',
        unitLabel: 'Main',
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
      { method: 'GET', path: '/api/v1/leases/l1', body: sharedLeaseDetail },
      { method: 'POST', path: '/api/v1/transactions/tx-suggested/confirm', body: {} },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderMoneyReview();

    await screen.findByText('Zelle payment');
    fireEvent.click(screen.getByRole('button', { name: /suggests: T\. Okafor/ }));

    const tenantSelect = await screen.findByLabelText('Paid by');
    fireEvent.change(tenantSelect, { target: { value: 't-okafor' } });

    fireEvent.click(screen.getByRole('button', { name: 'Confirm as Rent' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/v1/transactions/tx-suggested/confirm' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeDefined();
      expect((call![1] as RequestInit).body).toBe(
        JSON.stringify({
          rentPaymentId: 'rp-suggested',
          linkSource: 'suggestion',
          tenantId: 't-okafor',
        }),
      );
    });
  });
});

// Mortgage payment breakdown (PLAN-REAL-EQUITY §3/D4): a detected row
// (`mortgageId` set, `principalCents` null) offers the shared
// MortgageBreakdownEditor in place of the ordinary category picker; an
// ordinary expense with no `mortgageId` never sees it.
function moneyCategory(overrides: Partial<Category> & Pick<Category, 'id' | 'name' | 'type'>): Category {
  return { accountId: null, irsScheduleELine: null, isSystem: true, ...overrides };
}

const mortgageCategories: Category[] = [
  moneyCategory({ id: 'c-interest', name: 'Mortgage Interest', type: 'expense' }),
  moneyCategory({ id: 'c-tax', name: 'Property Taxes', type: 'expense' }),
  moneyCategory({ id: 'c-ins', name: 'Insurance', type: 'expense' }),
];

const mortgageDetectedItem: ReviewQueueItem = {
  id: 'tx-mortgage',
  accountId: 'acc1',
  propertyId: null,
  unitId: null,
  categoryId: null,
  date: '2026-07-05T00:00:00.000Z',
  amountCents: 240000,
  type: 'expense',
  description: 'Mortgage payment',
  vendor: 'First National Bank',
  source: 'bank',
  status: 'pending_review',
  classification: null,
  aiSuggestedCategoryId: null,
  aiConfidence: null,
  receiptUrl: null,
  mortgageId: 'm1',
  principalCents: null,
  createdAt: '2026-07-05T00:00:00.000Z',
  updatedAt: '2026-07-05T00:00:00.000Z',
  aiSuggestedCategoryName: null,
  rentMatch: null,
};

const plainExpenseItem: ReviewQueueItem = {
  ...mortgageDetectedItem,
  id: 'tx-plain-expense',
  description: 'Yard work',
  vendor: 'GreenThumb',
  mortgageId: null,
};

const mortgageRoutes: RouteFixture[] = [
  { method: 'GET', path: '/api/v1/categories', body: mortgageCategories },
  { method: 'GET', path: '/api/v1/properties', body: [] },
  // The breakdown editor's own last-month-prefill fetch.
  { method: 'GET', path: '/api/v1/transactions', body: { items: [], nextCursor: null, total: 0 } },
];

describe('MoneyReview mortgage payment breakdown', () => {
  it("offers the breakdown for a detected row and starts Confirm disabled", async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        ...mortgageRoutes,
        {
          method: 'GET',
          path: '/api/v1/transactions/review',
          body: { items: [mortgageDetectedItem], nextCursor: null, total: 1 },
        },
      ]),
    );
    renderMoneyReview();

    await screen.findByText('Mortgage payment');
    // The detection now reads as a full-bleed strip above the row (bolded lead
    // + the instruction), so the copy is asserted on the strip's container.
    expect(screen.getByText('Matches your mortgage').parentElement).toHaveTextContent(
      'Matches your mortgage — enter the breakdown below before confirming.',
    );
    // A mortgage row auto-expands: the breakdown is on screen without a click.
    expect(screen.getByLabelText(/^Principal/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Category')).not.toBeInTheDocument();
    const confirmButton = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmButton).toBeDisabled();
    // Defect 4: the disabled button's aria-describedby must resolve to real
    // text from the very first render, before Principal has been typed.
    const describedById = confirmButton.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.getElementById(describedById!)).toHaveTextContent(
      'Enter the principal to see what still needs a category.',
    );
  });

  it('no breakdown is offered for an ordinary expense with no mortgageId', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        ...mortgageRoutes,
        {
          method: 'GET',
          path: '/api/v1/transactions/review',
          body: { items: [plainExpenseItem], nextCursor: null, total: 1 },
        },
      ]),
    );
    renderMoneyReview();

    await screen.findByText('Yard work');
    expect(screen.queryByLabelText(/^Principal/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Category')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).not.toBeDisabled();
  });

  it('a single-category remainder (the default) enables Confirm and sends categoryId, not splits — a loan with no escrow', async () => {
    const fetchMock = makeFetch([
      ...mortgageRoutes,
      {
        method: 'GET',
        path: '/api/v1/transactions/review',
        body: { items: [mortgageDetectedItem], nextCursor: null, total: 1 },
      },
      { method: 'POST', path: '/api/v1/transactions/tx-mortgage/confirm', body: {} },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderMoneyReview();

    await screen.findByText('Mortgage payment');
    const confirmButton = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmButton).toBeDisabled();
    // $2,400 = $400 principal + $2,000 interest, one category — no split
    // rows exist, and none are required to save.
    expect(screen.queryByRole('button', { name: 'Split across categories' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Principal/), { target: { value: '400.00' } });
    fireEvent.change(screen.getByLabelText('Remainder category'), { target: { value: 'c-interest' } });

    expect(confirmButton).not.toBeDisabled();
    fireEvent.click(confirmButton);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/v1/transactions/tx-mortgage/confirm' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
        mortgageId: 'm1',
        principalCents: 40000,
        categoryId: 'c-interest',
      });
    });
  });

  it('splitting across two categories sends splits (2+ entries), never categoryId', async () => {
    const fetchMock = makeFetch([
      ...mortgageRoutes,
      {
        method: 'GET',
        path: '/api/v1/transactions/review',
        body: { items: [mortgageDetectedItem], nextCursor: null, total: 1 },
      },
      { method: 'POST', path: '/api/v1/transactions/tx-mortgage/confirm', body: {} },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderMoneyReview();

    await screen.findByText('Mortgage payment');
    const confirmButton = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/^Principal/), { target: { value: '800.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Split across categories' }));
    fireEvent.change(screen.getByLabelText('Category 1'), { target: { value: 'c-interest' } });
    fireEvent.change(screen.getByLabelText('Amount 1 (USD)'), { target: { value: '1100.00' } });
    fireEvent.change(screen.getByLabelText('Category 2'), { target: { value: 'c-tax' } });
    fireEvent.change(screen.getByLabelText('Amount 2 (USD)'), { target: { value: '500.00' } });

    expect(confirmButton).not.toBeDisabled();
    fireEvent.click(confirmButton);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/v1/transactions/tx-mortgage/confirm' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String((call![1] as RequestInit).body));
      expect(body).toEqual({
        mortgageId: 'm1',
        principalCents: 80000,
        splits: [
          { categoryId: 'c-interest', amountCents: 110000 },
          { categoryId: 'c-tax', amountCents: 50000 },
        ],
      });
      expect(body.splits.length).toBeGreaterThanOrEqual(2);
      expect(body).not.toHaveProperty('categoryId');
    });
  });

  it('"Not a mortgage payment" nulls the link server-side and falls back to ordinary categorization', async () => {
    let mortgageId: string | null = 'm1';
    let principalCents: number | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
      const method = (init?.method ?? 'GET').toUpperCase();
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/v1/transactions/review' && method === 'GET') {
        return json({
          items: [{ ...mortgageDetectedItem, mortgageId, principalCents }],
          nextCursor: null,
          total: 1,
        });
      }
      if (url === '/api/v1/categories' && method === 'GET') return json(mortgageCategories);
      if (url === '/api/v1/properties' && method === 'GET') return json([]);
      if (url === '/api/v1/transactions' && method === 'GET') {
        return json({ items: [], nextCursor: null, total: 0 });
      }
      if (url === '/api/v1/transactions/tx-mortgage' && method === 'PATCH') {
        const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
        expect(body).toEqual({ mortgageId: null, principalCents: null });
        mortgageId = null;
        principalCents = null;
        return json({ ...mortgageDetectedItem, mortgageId: null, principalCents: null });
      }
      return json({ error: { code: 'not_found', message: url } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderMoneyReview();

    await screen.findByText('Mortgage payment');
    fireEvent.click(screen.getByRole('button', { name: 'Not a mortgage payment' }));

    expect(
      await screen.findByText("Won't be treated as a mortgage payment — categorize it normally below."),
    ).toBeInTheDocument();
    expect(await screen.findByLabelText('Category')).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Principal/)).not.toBeInTheDocument();
  });

  it("accepts a principal-only payment (principal === total) with zero remainder", async () => {
    const fetchMock = makeFetch([
      ...mortgageRoutes,
      {
        method: 'GET',
        path: '/api/v1/transactions/review',
        body: { items: [mortgageDetectedItem], nextCursor: null, total: 1 },
      },
      { method: 'POST', path: '/api/v1/transactions/tx-mortgage/confirm', body: {} },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderMoneyReview();

    await screen.findByText('Mortgage payment');
    fireEvent.change(screen.getByLabelText(/^Principal/), { target: { value: '2400.00' } });
    expect(screen.queryByLabelText('Category 1')).not.toBeInTheDocument();

    const confirmButton = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmButton).not.toBeDisabled();
    fireEvent.click(confirmButton);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/v1/transactions/tx-mortgage/confirm' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
        mortgageId: 'm1',
        principalCents: 240000,
      });
    });
  });

  // The breakdown used to be crammed into the card's 256px action column, then
  // (defect 1) hung below the card as a full-width special case. It is now a
  // block *inside* the row's expanded region, alongside the attribution grid —
  // one layout, no exception. The header row keeps identity/amount/actions.
  it('renders the breakdown as a block inside the expanded region, alongside property/unit, with the actions outside it', async () => {
    stubDesktopViewport();
    vi.stubGlobal(
      'fetch',
      makeFetch([
        ...mortgageRoutes,
        {
          method: 'GET',
          path: '/api/v1/transactions/review',
          body: { items: [mortgageDetectedItem], nextCursor: null, total: 1 },
        },
      ]),
    );
    renderMoneyReview();

    await screen.findByText('Mortgage payment');

    // The expanded region is the element the (absent, because this row must
    // stay open) toggle would control: id `review-details-<id>`.
    const region = document.getElementById('review-details-tx-mortgage');
    expect(region).not.toBeNull();
    const scoped = within(region as HTMLElement);
    expect(scoped.getByText('Total (from your bank)')).toBeInTheDocument();
    expect(scoped.getByLabelText(/^Principal/)).toBeInTheDocument();
    expect(scoped.getByLabelText('Property')).toBeInTheDocument();
    expect(scoped.getByLabelText('Unit')).toBeInTheDocument();
    // Actions stay on the header row, not in the form region.
    expect(scoped.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    expect(scoped.queryByRole('button', { name: /^Dismiss/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    // "— <description>" distinguishes the row action from the page's
    // "Dismiss all"; RowActions appends the row context to every label.
    expect(screen.getByRole('button', { name: /^Dismiss — / })).toBeInTheDocument();
    // A row that must stay open offers no way to close it — collapsing it
    // would hide the only control that can enable Confirm.
    expect(screen.queryByRole('button', { name: /details/ })).not.toBeInTheDocument();
  });

  // Defect 2: there's deliberately no "Escrow" category — this affordance
  // sets up the three rows an escrowed payment actually needs, amounts left
  // blank (D4: never computed).
  it('offers the interest + escrow affordance, which creates three blank-amount rows', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        ...mortgageRoutes,
        {
          method: 'GET',
          path: '/api/v1/transactions/review',
          body: { items: [mortgageDetectedItem], nextCursor: null, total: 1 },
        },
      ]),
    );
    renderMoneyReview();

    await screen.findByText('Mortgage payment');
    fireEvent.change(screen.getByLabelText(/^Principal/), { target: { value: '400.00' } });
    expect(
      screen.getByRole('button', { name: 'Interest + escrow (taxes, insurance)' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Interest + escrow (taxes, insurance)' }));

    expect(screen.getByLabelText('Category 1')).toHaveValue('c-interest');
    expect(screen.getByLabelText('Amount 1 (USD)')).toHaveValue(null);
    expect(screen.getByLabelText('Category 2')).toHaveValue('c-tax');
    expect(screen.getByLabelText('Amount 2 (USD)')).toHaveValue(null);
    expect(screen.getByLabelText('Category 3')).toHaveValue('c-ins');
    expect(screen.getByLabelText('Amount 3 (USD)')).toHaveValue(null);
    // Amounts are still blank — Confirm stays disabled until the user types them.
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });

  // Defect 3: the sum check alone used to read as "fully allocated" while an
  // untouched row left Confirm disabled with no stated reason.
  it("names the row still blocking Confirm instead of falsely reading 'fully allocated'", async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        ...mortgageRoutes,
        {
          method: 'GET',
          path: '/api/v1/transactions/review',
          body: { items: [mortgageDetectedItem], nextCursor: null, total: 1 },
        },
      ]),
    );
    renderMoneyReview();

    await screen.findByText('Mortgage payment');
    // $2,400 total, $1,400 principal → $1,000 remainder, one row filled.
    fireEvent.change(screen.getByLabelText(/^Principal/), { target: { value: '1400.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Split across categories' }));
    fireEvent.change(screen.getByLabelText('Category 1'), { target: { value: 'c-interest' } });
    fireEvent.change(screen.getByLabelText('Amount 1 (USD)'), { target: { value: '1000.00' } });

    const confirmButton = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmButton).toBeDisabled();
    expect(
      screen.queryByText('$1,000.00 of $1,000.00 allocated · $0.00 remaining to allocate'),
    ).not.toBeInTheDocument();
    const describedById = confirmButton.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.getElementById(describedById!)).toHaveTextContent(
      '$1,000.00 of $1,000.00 allocated · row 2 still needs a category and amount',
    );
  });
});

// ── the triage row ─────────────────────────────────────────────────────────
// The queue is a place to clear things, so the default row is one line with a
// primary action that names its outcome; the attribution form appears at full
// card width only when the row can't be cleared in one click.

const suppliesCategory = moneyCategory({ id: 'c-supplies', name: 'Supplies', type: 'expense' });
const rentCategory = moneyCategory({ id: 'c-rent', name: 'Rent', type: 'income' });

// The common case: a confident, learned suggestion.
const confidentExpense: ReviewQueueItem = {
  ...plainExpenseItem,
  id: 'tx-supplies',
  description: 'HD SUPPLY #443',
  vendor: 'HD Supply',
  amountCents: 16400,
  aiSuggestedCategoryId: 'c-supplies',
  aiConfidence: 0.84,
  aiSuggestedCategoryName: 'Supplies',
  suggestionSource: 'learned',
};

// An exact-amount, in-window match on a wholly unpaid charge — the API's
// uncontested 0.9 score.
const uncontestedRentMatch = {
  rentPaymentId: 'rp-match',
  leaseId: 'l1',
  tenantName: 'T. Okafor',
  propertyId: 'p1',
  propertyLabel: '21 Cedar Ct',
  unitId: 'u1',
  unitLabel: 'Main',
  period: '2026-07',
  dueDate: '2026-07-01T00:00:00.000Z',
  amountCents: 115000,
  paidCents: 0,
  confidence: 0.9,
  matchedName: null,
};

const strongRentSuggestion = {
  aiSuggestedCategoryId: 'c-rent',
  aiConfidence: 0.95,
  aiSuggestedCategoryName: 'Rent',
};

const secondExpense: ReviewQueueItem = {
  ...confidentExpense,
  id: 'tx-second',
  description: 'LOWES #00907',
  vendor: "Lowe's",
  amountCents: 6875,
};

/** The queue list, scoped away from the breadcrumb list and the filter bar
 *  (whose "Property"/"Type" labels would otherwise collide with a row's). */
function queueList(): HTMLElement {
  return screen.getByRole('list', { name: 'Pending transactions' });
}

function queueRows(): HTMLElement[] {
  return within(queueList()).getAllByRole('listitem');
}

function renderQueue(items: ReviewQueueItem[], categories: Category[] = [suppliesCategory, rentCategory], extra: RouteFixture[] = []) {
  const fetchMock = makeFetch([
    {
      method: 'GET',
      path: '/api/v1/transactions/review',
      body: { items, nextCursor: null, total: items.length },
    },
    { method: 'GET', path: '/api/v1/categories', body: categories },
    { method: 'GET', path: '/api/v1/properties', body: [] },
    // The mortgage editor's last-month-prefill lookup.
    { method: 'GET', path: '/api/v1/transactions', body: { items: [], nextCursor: null, total: 0 } },
    ...extra,
  ]);
  vi.stubGlobal('fetch', fetchMock);
  renderMoneyReview();
  return fetchMock;
}

describe('MoneyReview triage row (collapsed)', () => {
  it('confirms in one click, with the primary button naming the outcome and no form on screen', async () => {
    stubDesktopViewport();
    const fetchMock = renderQueue([confidentExpense], [suppliesCategory], [
      { method: 'POST', path: '/api/v1/transactions/tx-supplies/confirm', body: {} },
    ]);

    await screen.findByText('HD SUPPLY #443');
    // vendor · date on one line, and no attribution form until it's asked for.
    // (Dates render through the app's local-timezone formatter, so expected
    // strings are computed, never hardcoded.)
    expect(
      screen.getByText(`HD Supply · ${formatDate(confidentExpense.date)}`),
    ).toBeInTheDocument();
    const row = within(queueRows()[0]!);
    expect(row.queryByLabelText('Category')).not.toBeInTheDocument();
    expect(row.queryByLabelText('Property')).not.toBeInTheDocument();
    expect(row.queryByLabelText('Treatment')).not.toBeInTheDocument();
    // The suggestion chip keeps its confidence and the learning note.
    expect(
      screen.getByRole('button', { name: /suggests: Supplies \(84%\) — from your past choice/ }),
    ).toBeInTheDocument();
    // Expense: signed amount, tabular, distinguished by the sign not just color.
    expect(screen.getByText(`−${formatUsd(16400)}`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm as Supplies' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/v1/transactions/tx-supplies/confirm' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeDefined();
      // No categoryId means "accept the suggestion", which keeps the audit
      // actor ai_suggested_user_confirmed.
      expect((call![1] as RequestInit).body).toBe('{}');
    });
    expect(await screen.findByText('Confirmed “HD SUPPLY #443”.')).toBeInTheDocument();
  });

  it('the expand control is a real toggle that opens all four attribution fields', async () => {
    stubDesktopViewport();
    renderQueue([confidentExpense], [suppliesCategory]);

    await screen.findByText('HD SUPPLY #443');
    const toggle = screen.getByRole('button', { name: /^Edit details/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // The region is unmounted while collapsed, so there must be no
    // `aria-controls` pointing at a missing id — an invalid reference assistive
    // tech has to guess at. `aria-expanded` carries the state on its own.
    expect(toggle).not.toHaveAttribute('aria-controls');

    fireEvent.click(toggle);

    const opened = screen.getByRole('button', { name: /^Hide details/ });
    expect(opened).toHaveAttribute('aria-expanded', 'true');
    // Now that it exists, the reference must be present and resolve.
    const regionId = opened.getAttribute('aria-controls');
    expect(regionId).toBe('review-details-tx-supplies');
    const region = document.getElementById(regionId!);
    expect(region).not.toBeNull();
    const scoped = within(region as HTMLElement);
    expect(scoped.getByLabelText('Category')).toBeInTheDocument();
    expect(scoped.getByLabelText('Property')).toBeInTheDocument();
    expect(scoped.getByLabelText('Unit')).toBeInTheDocument();
    expect(scoped.getByLabelText('Treatment')).toBeInTheDocument();
    // Unit still depends on Property, and says why it's disabled.
    const unit = scoped.getByLabelText('Unit');
    expect(unit).toBeDisabled();
    const unitWhy = unit.getAttribute('aria-describedby');
    expect(unitWhy).toBeTruthy();
    expect(document.getElementById(unitWhy!)).toHaveTextContent('Pick a property first.');

    // Choosing a category renames the outcome the primary button will produce.
    fireEvent.change(scoped.getByLabelText('Category'), { target: { value: 'c-supplies' } });
    expect(screen.getByRole('button', { name: 'Confirm as Supplies' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Hide details/ }));
    expect(document.getElementById(regionId!)).toBeNull();
  });
});

describe('MoneyReview triage row (auto-expand)', () => {
  it('a row with no suggestion opens itself, and says so instead of guessing', async () => {
    stubDesktopViewport();
    const noSuggestion: ReviewQueueItem = {
      ...confidentExpense,
      id: 'tx-none',
      description: 'SUMMIT ROOFING LLC',
      vendor: 'Summit Roofing',
      aiSuggestedCategoryId: null,
      aiConfidence: null,
      aiSuggestedCategoryName: null,
      suggestionSource: undefined,
    };
    renderQueue([noSuggestion], [suppliesCategory]);

    await screen.findByText('SUMMIT ROOFING LLC');
    expect(screen.getByLabelText('Category')).toBeInTheDocument();
    expect(screen.getByText('No suggestion')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /details/ })).not.toBeInTheDocument();
  });

  it('a suggestion under the 0.7 gate opens the row, leans on the chip, and refuses to name the outcome', async () => {
    stubDesktopViewport();
    renderQueue([{ ...confidentExpense, id: 'tx-weak', aiConfidence: 0.55 }], [suppliesCategory]);

    await screen.findByText('HD SUPPLY #443');
    expect(screen.getByLabelText('Category')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /details/ })).not.toBeInTheDocument();
    // No banner — the confidence lives on the chip, which says the same thing once.
    expect(screen.queryByText(/Low confidence/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /suggests: Supplies \(55%\)/ })).toBeInTheDocument();
    // A weak suggestion is a decision, not a reflex — the button doesn't
    // pre-name it (accepting it is still one click via the chip + Confirm).
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm as Supplies' })).not.toBeInTheDocument();
  });

  it('a possible duplicate opens the row and reads its full copy across the card', async () => {
    stubDesktopViewport();
    const duplicateOf = {
      transactionId: 'tx-old',
      description: 'Roof repair — flashing and shingles',
      date: '2026-08-14T00:00:00.000Z',
      source: 'bank' as const,
    };
    renderQueue(
      [{ ...confidentExpense, id: 'tx-dupe', possibleDuplicate: duplicateOf }],
      [suppliesCategory],
    );

    await screen.findByText('HD SUPPLY #443');
    expect(screen.getByLabelText('Category')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /details/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Possible duplicate:/).parentElement).toHaveTextContent(
      `a confirmed bank transaction matches this amount and date (“Roof repair — flashing and shingles”, ${formatDate(duplicateOf.date)}). If it’s the same money, Dismiss this one.`,
    );
  });

  it('keeps the rent-aware duplicate copy when the match backs a manually recorded rent', async () => {
    stubDesktopViewport();
    const manualRent = {
      transactionId: 'tx-manual-rent',
      description: 'July rent — T. Okafor',
      date: '2026-07-02T00:00:00.000Z',
      source: 'manual' as const,
      rentPeriod: '2026-07',
    };
    renderQueue([{ ...plainIncomeItem, id: 'tx-dupe-rent', possibleDuplicate: manualRent }]);

    await screen.findByText('Zelle payment');
    expect(screen.getByText(/Possible duplicate:/).parentElement).toHaveTextContent(
      `this looks like the deposit behind the rent you recorded manually for Jul 2026 (“July rent — T. Okafor”, ${formatDate(manualRent.date)}). If it’s the same money, Dismiss this one — or unlink the manual payment on the Rent page first.`,
    );
  });

  it('a mortgage payment opens itself with the breakdown, and Confirm explains why it is blocked', async () => {
    stubDesktopViewport();
    renderQueue([mortgageDetectedItem], mortgageCategories);

    await screen.findByText('Mortgage payment');
    expect(screen.getByLabelText(/^Principal/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /details/ })).not.toBeInTheDocument();
    const confirmButton = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmButton).toBeDisabled();
    const describedById = confirmButton.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.getElementById(describedById!)).toHaveTextContent(
      'Enter the principal to see what still needs a category.',
    );
    // Treatment is suppressed for a mortgage row: principal and a P&L
    // classification are mutually exclusive.
    expect(screen.queryByLabelText('Treatment')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not a mortgage payment' })).toBeInTheDocument();
  });

  it('an ambiguous rent match opens the row, keeping the match in its AiSurface chip', async () => {
    stubDesktopViewport();
    // 0.85 is the API's "a name broke an amount/date tie" score — the match came
    // out of an ambiguity, so the row is worth opening. The category suggestion
    // is strong, so nothing else forces it open.
    renderQueue([
      {
        ...plainIncomeItem,
        id: 'tx-amb',
        ...strongRentSuggestion,
        rentMatch: { ...uncontestedRentMatch, confidence: 0.85, matchedName: 'OKAFOR' },
      },
    ]);

    await screen.findByText('Zelle payment');
    expect(screen.getByLabelText('Category')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /details/ })).not.toBeInTheDocument();
    // The chip is a pill, so it carries the label only — the property and unit
    // read as prose beside it rather than wrapping the pill onto three lines.
    expect(
      screen.getByRole('button', {
        name: /suggests: T\. Okafor's Jul 2026 rent \(85%\) — deposit names OKAFOR/,
      }),
    ).toBeInTheDocument();
    // Location and consequence read as one sentence beside the pill.
    expect(
      screen.getByText(
        '21 Cedar Ct · Main — linking marks that charge paid instead of counting this deposit as new income.',
      ),
    ).toBeInTheDocument();
    // The manual picker is reachable in the opened row.
    expect(screen.getByRole('button', { name: 'Link to rent…' })).toBeInTheDocument();
  });

  it('an uncontested rent match stays collapsed — it is still a one-click row', async () => {
    stubDesktopViewport();
    renderQueue([
      {
        ...plainIncomeItem,
        id: 'tx-clean',
        ...strongRentSuggestion,
        rentMatch: uncontestedRentMatch,
      },
    ]);

    await screen.findByText('Zelle payment');
    expect(screen.queryByLabelText('Category')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Edit details/ })).toBeInTheDocument();
    // …and the match still reads across the card, above the row.
    expect(screen.getByText(/T\. Okafor's Jul 2026 rent/)).toBeInTheDocument();
  });
});

// "Auto-drafted" badge (PLAN-REAL-EQUITY §6 Phase 2 item 8): a row the
// scheduler drafted from a RecurringTemplate carries `recurringTemplateId` —
// text, not color alone, alongside the row's other state chips.
describe('MoneyReview auto-drafted badge', () => {
  it('shows the Auto-drafted badge only for a row with recurringTemplateId set', async () => {
    stubDesktopViewport();
    renderQueue([
      { ...confidentExpense, id: 'tx-auto', recurringTemplateId: 'rt1' },
      { ...secondExpense, recurringTemplateId: null },
    ]);

    await screen.findByText('HD SUPPLY #443');
    const rows = queueRows();
    expect(within(rows[0]!).getByText('Auto-drafted')).toBeInTheDocument();
    expect(within(rows[1]!).queryByText('Auto-drafted')).not.toBeInTheDocument();
  });
});

// A settled row is how "no jump on confirm" is enforced: the successful write
// never removes the row from the layout, it swaps it for a same-height
// "Confirmed"/"Dismissed" row at the same index, and only leaving the queue
// (pointer or focus) drops it.
describe('MoneyReview holds scroll position on confirm', () => {
  function dynamicQueue() {
    let cleared = false;
    let reviewCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
      const method = (init?.method ?? 'GET').toUpperCase();
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/v1/transactions/review' && method === 'GET') {
        reviewCalls += 1;
        const items = cleared ? [secondExpense] : [confidentExpense, secondExpense];
        return json({ items, nextCursor: null, total: items.length });
      }
      if (url === '/api/v1/categories' && method === 'GET') return json([suppliesCategory]);
      if (url === '/api/v1/properties' && method === 'GET') return json([]);
      if (
        (url === '/api/v1/transactions/tx-supplies/confirm' ||
          url === '/api/v1/transactions/tx-supplies/dismiss') &&
        method === 'POST'
      ) {
        cleared = true;
        return json({ id: 'tx-supplies' });
      }
      return json({ error: { code: 'not_found', message: url } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderMoneyReview();
    return { reviewCalls: () => reviewCalls };
  }

  it('keeps the confirmed row at its index and its height after the queue refetches without it', async () => {
    stubDesktopViewport();
    const { reviewCalls } = dynamicQueue();

    await screen.findByText('HD SUPPLY #443');
    const before = reviewCalls();
    // The live card's height is measured the instant before it settles; the
    // settled card holds it, so nothing below the row can move.
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ height: 402 } as DOMRect);
    fireEvent.click(within(queueRows()[0]!).getByRole('button', { name: 'Confirm as Supplies' }));
    await screen.findByText('Confirmed as Supplies');
    rect.mockRestore();

    // The server has since dropped the row from the queue…
    await waitFor(() => expect(reviewCalls()).toBeGreaterThan(before));
    // …and it is still exactly where it was, at the height it had.
    const rowsAfter = queueRows();
    expect(rowsAfter).toHaveLength(2);
    expect(rowsAfter[0]).toHaveTextContent('HD SUPPLY #443');
    expect(rowsAfter[0]).toHaveTextContent('Confirmed as Supplies');
    expect(rowsAfter[1]).toHaveTextContent('LOWES #00907');
    expect(rowsAfter[0]!.firstElementChild).toHaveStyle({ minHeight: '402px' });
    // Its controls are gone, so a second click can't re-fire anything.
    expect(
      within(rowsAfter[0]!).queryByRole('button', { name: 'Confirm as Supplies' }),
    ).not.toBeInTheDocument();

    // Leaving the queue is what finally drops it — and it never comes back as
    // pending, even though this render's queue response still listed it.
    fireEvent(queueList().parentElement!, new Event('pointerleave'));
    await waitFor(() => expect(queueRows()).toHaveLength(1));
    expect(screen.queryByText('HD SUPPLY #443')).not.toBeInTheDocument();
  });

  it('keeps focus on the settled row, and only a real move out of the queue drops it', async () => {
    stubDesktopViewport();
    dynamicQueue();

    await screen.findByText('HD SUPPLY #443');
    fireEvent.click(within(queueRows()[0]!).getByRole('button', { name: 'Confirm as Supplies' }));
    await screen.findByText('Confirmed as Supplies');

    // The pressed button unmounted; focus lands on the outcome, not the body.
    expect(queueRows()[0]!.contains(document.activeElement)).toBe(true);

    // A focusout with no new target is exactly that unmount — it must not
    // drop the row (that would undo the whole point).
    fireEvent.focusOut(queueList(), { relatedTarget: null });
    expect(queueRows()).toHaveLength(2);

    // Tabbing out of the queue is a real move away, so the row leaves.
    fireEvent.focusOut(queueList(), { relatedTarget: screen.getByLabelText('Search') });
    await waitFor(() => expect(queueRows()).toHaveLength(1));
  });

  it('dismissing settles the row in place the same way', async () => {
    stubDesktopViewport();
    dynamicQueue();

    await screen.findByText('HD SUPPLY #443');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss — “HD SUPPLY #443”' }));

    expect(await screen.findByText('Dismissed')).toBeInTheDocument();
    const rowsAfter = queueRows();
    expect(rowsAfter).toHaveLength(2);
    expect(rowsAfter[0]).toHaveTextContent('HD SUPPLY #443');
    expect(rowsAfter[1]).toHaveTextContent('LOWES #00907');
  });
});

// ── permission gating (money write area) ────────────────────────────────────
// Every write on this page — bulk actions, per-row confirm/dismiss, the
// attribution selects, the rent-link picker, the mortgage breakdown, "Not a
// mortgage payment", and the bank-correction actions — sits behind the single
// `money` permission (transactions.ts routes are all requirePermission('money')).
// One mortgage-flagged expense + one plain income row together surface every
// gated control in one render; a bank discrepancy with a linked deposit adds
// the correction actions, including Unlink deposit.
describe('MoneyReview permission gating (money write area)', () => {
  const noMoneyMember: CurrentUser = { userId: 'u-member', role: 'member', permissions: [] };
  const moneyMember: CurrentUser = { userId: 'u-member', role: 'member', permissions: ['money'] };
  const owner: CurrentUser = { userId: null, role: 'owner', permissions: [] };
  const incomeCategory = moneyCategory({ id: 'c-rent-perm', name: 'Rent', type: 'income' });
  const permissionCategories = [...mortgageCategories, incomeCategory];

  function renderAsUser(user: CurrentUser) {
    return renderQueue([mortgageDetectedItem, plainIncomeItem], permissionCategories, [
      { method: 'GET', path: '/api/v1/settings/me', body: user },
      {
        method: 'GET',
        path: '/api/v1/transactions/bank-discrepancies',
        body: { items: [removedRentLinkedRow] },
      },
    ]);
  }

  it('hides every write control from a member without money, and shows the explanatory note', async () => {
    stubDesktopViewport();
    renderAsUser(noMoneyMember);

    await screen.findByText('Mortgage payment');
    await screen.findByText('Zelle payment');
    await screen.findByText('Bank changed these after you confirmed');

    expect(
      screen.getByText(/You can see everything in this queue/),
    ).toBeInTheDocument();

    // Bulk actions.
    expect(screen.queryByRole('button', { name: 'Confirm all suggested' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss all' })).not.toBeInTheDocument();

    // Per-row confirm/dismiss and the attribution/rent-link/mortgage controls
    // they gate. Scoped to the row list: the filter bar has its own "Property"
    // select, and filtering is a read affordance that must survive.
    const queue = within(screen.getByRole('list', { name: 'Pending transactions' }));
    expect(queue.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    expect(queue.queryByRole('button', { name: /^Dismiss/ })).not.toBeInTheDocument();
    expect(queue.queryByLabelText('Category')).not.toBeInTheDocument();
    expect(queue.queryByLabelText('Property')).not.toBeInTheDocument();
    expect(queue.queryByLabelText('Unit')).not.toBeInTheDocument();
    expect(queue.queryByLabelText('Treatment')).not.toBeInTheDocument();
    // (An AI suggestion chip becomes non-interactive for a member too — these
    // fixtures carry no suggestion, so that lives in AiChip.test.tsx.)
    // Filtering is a read affordance and survives.
    expect(document.getElementById('review-filter-property')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link to rent…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not a mortgage payment' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Principal/)).not.toBeInTheDocument();

    // Bank-correction actions.
    expect(screen.queryByRole('button', { name: 'Accept bank version' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep my version' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlink deposit' })).not.toBeInTheDocument();
  });

  it('a member with the money permission sees every write control', async () => {
    stubDesktopViewport();
    renderAsUser(moneyMember);

    await screen.findByText('Mortgage payment');
    await screen.findByText('Zelle payment');
    await screen.findByText('Bank changed these after you confirmed');

    expect(screen.queryByText(/You can see everything in this queue/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm all suggested' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss all' })).toBeInTheDocument();
    // Scoped: the filter bar owns a "Property" select and the page header owns
    // "Dismiss all", so unscoped counts run one over.
    const queue = within(screen.getByRole('list', { name: 'Pending transactions' }));
    expect(queue.getAllByRole('button', { name: 'Confirm' })).toHaveLength(2);
    expect(queue.getAllByRole('button', { name: /^Dismiss/ })).toHaveLength(2);
    expect(queue.getByLabelText('Category')).toBeInTheDocument();
    expect(queue.getAllByLabelText('Property')).toHaveLength(2);
    expect(queue.getAllByLabelText('Unit')).toHaveLength(2);
    expect(queue.getByLabelText('Treatment')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link to rent…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not a mortgage payment' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Principal/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept bank version' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep my version' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlink deposit' })).toBeInTheDocument();
  });

  it('an owner sees every write control', async () => {
    stubDesktopViewport();
    renderAsUser(owner);

    await screen.findByText('Mortgage payment');
    expect(screen.getByRole('button', { name: 'Confirm all suggested' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Confirm' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Not a mortgage payment' })).toBeInTheDocument();
    expect(screen.queryByText(/You can see everything in this queue/)).not.toBeInTheDocument();
  });

  // usePermissions defaults permissive while /settings/me is in flight (an
  // owner's own buttons must never flicker out). /settings/me here never
  // resolves during the test, so this proves the controls are up while that
  // request is genuinely still pending — not just after it settles.
  it('the permissive default keeps an owner’s controls visible while /settings/me is still loading', async () => {
    stubDesktopViewport();
    const settingsMe = new Promise<Response>(() => {}); // intentionally never resolves
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url === '/api/v1/settings/me' && method === 'GET') return settingsMe;
      const routes: RouteFixture[] = [
        {
          method: 'GET',
          path: '/api/v1/transactions/review',
          body: { items: [mortgageDetectedItem], nextCursor: null, total: 1 },
        },
        { method: 'GET', path: '/api/v1/categories', body: mortgageCategories },
        { method: 'GET', path: '/api/v1/properties', body: [] },
        { method: 'GET', path: '/api/v1/transactions', body: { items: [], nextCursor: null, total: 0 } },
      ];
      const match = routes.find((r) => r.path === url && r.method === method);
      return new Response(JSON.stringify(match ? match.body : { error: { code: 'not_found', message: url } }), {
        status: match ? 200 : 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderMoneyReview();

    await screen.findByText('Mortgage payment');
    // /settings/me is still unresolved at this point — the row loaded from a
    // separate request, so this is a genuine mid-flight assertion.
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not a mortgage payment' })).toBeInTheDocument();
    // Scoped past the filter bar's own Property select.
    const queue = within(screen.getByRole('list', { name: 'Pending transactions' }));
    expect(queue.getByLabelText('Property')).toBeInTheDocument();
  });
});
