// Bank-correction surface (WS5): "Bank changed these after you confirmed"
// renders above the normal review queue whenever GET
// /transactions/bank-discrepancies returns pending rows, and is absent when
// it doesn't. Diff line + rent-linked guided unlink covered per kind.
import { formatUsd } from '@hearth/shared';
import type {
  BankDiscrepancyRow,
  Category,
  RentChargeOption,
  ReviewQueueItem,
  ReviewQueueResponse,
} from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
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
    expect(
      screen.getByText('This bank row matches your mortgage — enter the breakdown below before confirming.'),
    ).toBeInTheDocument();
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
});
