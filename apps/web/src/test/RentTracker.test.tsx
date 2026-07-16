// Late fees v1 (WS7): "Apply late fee" is visible only on rows past their
// grace period with no fee applied yet (the row can't know the lease's
// effective policy up front, so the button stays amount-free and the toast
// reports the real figure from the response); applied rows show "+$X late
// fee" next to the amount due and expose "Waive" from the Deposits modal
// (reachable even with zero deposits, since the fee itself needs a way in).
// Confirm dialogs gate both actions; server 400s surface verbatim via toast.
import type { RentTrackerResponse, RentTrackerRow } from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, ToastViewport } from '../components/ui/Toast';
import { currentPeriod } from '../lib/format';
import { RentTracker } from '../pages/RentTracker';

const period = currentPeriod();

// RowActions reads `(min-width: 768px)` via useMediaQuery — force the
// desktop inline-button layout (precedent: RowActions.test.tsx) so each row's
// actions are directly queryable without going through the mobile sheet.
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

function makeRow(overrides: Partial<RentTrackerRow>): RentTrackerRow {
  return {
    rentPaymentId: 'rp-default',
    leaseId: 'l1',
    tenantId: 't1',
    tenantName: 'T. Okafor',
    unitId: 'u1',
    unitLabel: 'Main',
    propertyId: 'p1',
    propertyLabel: '21 Cedar Ct',
    amountCents: 115000,
    paidCents: 0,
    lateFeeCents: 0,
    dueDate: '2026-07-01T00:00:00.000Z',
    status: 'late',
    daysLate: 6,
    method: null,
    paidAt: null,
    deposits: [],
    tenants: [
      {
        tenantId: 't1',
        tenantName: 'T. Okafor',
        isPrimary: true,
        shareCents: 115000,
        shareSpecified: false,
        paidCents: 0,
        settled: false,
      },
    ],
    sharesMismatch: false,
    ...overrides,
  };
}

// Late, no fee applied yet — eligible for "Apply late fee".
const lateNoFee = makeRow({ rentPaymentId: 'rp-late-no-fee' });

// Late, fee already applied — shows "+$X late fee", offers Waive instead.
const lateWithFee = makeRow({
  rentPaymentId: 'rp-late-fee',
  tenantId: 't2',
  tenantName: 'J. Rivera',
  lateFeeCents: 5000,
  tenants: [
    {
      tenantId: 't2',
      tenantName: 'J. Rivera',
      isPrimary: true,
      shareCents: 115000,
      shareSpecified: false,
      paidCents: 0,
      settled: false,
    },
  ],
});

// Not past grace at all — never eligible regardless of fee state.
const dueNotLate = makeRow({
  rentPaymentId: 'rp-due',
  tenantId: 't3',
  tenantName: 'M. Chen',
  status: 'due',
  daysLate: undefined,
  tenants: [
    {
      tenantId: 't3',
      tenantName: 'M. Chen',
      isPrimary: true,
      shareCents: 115000,
      shareSpecified: false,
      paidCents: 0,
      settled: false,
    },
  ],
});

// Partial past grace with a fee — extends the existing "$X of $Y" pattern.
const partialWithFee = makeRow({
  rentPaymentId: 'rp-partial-fee',
  tenantId: 't4',
  tenantName: 'S. Patel',
  status: 'partial',
  paidCents: 50000,
  lateFeeCents: 2500,
  daysLate: 3,
  tenants: [
    {
      tenantId: 't4',
      tenantName: 'S. Patel',
      isPrimary: true,
      shareCents: 115000,
      shareSpecified: false,
      paidCents: 50000,
      settled: false,
    },
  ],
});

const tracker: RentTrackerResponse = {
  period,
  collectedCents: 50000,
  outstandingCents: 300000,
  paidUnits: 0,
  partialUnits: 1,
  totalUnits: 4,
  rows: [lateNoFee, lateWithFee, dueNotLate, partialWithFee],
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

const baseRoutes: RouteFixture[] = [
  { method: 'GET', path: '/api/v1/rent/tracker', body: tracker },
  { method: 'GET', path: '/api/v1/rent/unlinked-deposits', body: { items: [] } },
  { method: 'GET', path: '/api/v1/insights', body: [] },
];

function renderRentTracker() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/rent']}>
          <Routes>
            <Route path="/rent" element={<RentTracker />} />
          </Routes>
        </MemoryRouter>
        <ToastViewport />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RentTracker late fees (WS7)', () => {
  it('shows Apply late fee only on eligible rows, "+$X late fee" on applied rows, extends the partial label, and passes axe', async () => {
    stubDesktopViewport();
    vi.stubGlobal('fetch', makeFetch(baseRoutes));
    const { container } = renderRentTracker();

    await screen.findByText('T. Okafor');

    const lateNoFeeRow = screen.getByText('T. Okafor').closest('tr') as HTMLElement;
    expect(
      within(lateNoFeeRow).getByRole('button', { name: /Apply late fee — T\. Okafor/ }),
    ).toBeInTheDocument();

    const lateWithFeeRow = screen.getByText('J. Rivera').closest('tr') as HTMLElement;
    expect(
      within(lateWithFeeRow).queryByRole('button', { name: /Apply late fee/ }),
    ).not.toBeInTheDocument();
    expect(within(lateWithFeeRow).getByText('+$50.00 late fee')).toBeInTheDocument();
    // Zero deposits, but the fee itself needs a way to the Waive action.
    expect(
      within(lateWithFeeRow).getByRole('button', { name: /Deposits — J\. Rivera/ }),
    ).toBeInTheDocument();

    const dueRow = screen.getByText('M. Chen').closest('tr') as HTMLElement;
    expect(within(dueRow).queryByRole('button', { name: /Apply late fee/ })).not.toBeInTheDocument();

    const partialRow = screen.getByText('S. Patel').closest('tr') as HTMLElement;
    expect(
      within(partialRow).getByText('Partial — $500.00 of $1,150.00 (+$25.00 late fee) · 3 days late'),
    ).toBeInTheDocument();

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  }, 20_000);

  it('applying a late fee opens a confirm dialog, POSTs with feeCents omitted, and toasts the applied amount from the response', async () => {
    stubDesktopViewport();
    const fetchMock = makeFetch([
      ...baseRoutes,
      {
        method: 'POST',
        path: '/api/v1/rent/payments/rp-late-no-fee/late-fee',
        body: { ...lateNoFee, lateFeeCents: 5000 },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderRentTracker();

    const targetRow = (await screen.findByText('T. Okafor')).closest('tr') as HTMLElement;
    fireEvent.click(within(targetRow).getByRole('button', { name: /Apply late fee — T\. Okafor/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Apply late fee?' });
    expect(within(dialog).getByText(/Applies T\. Okafor.s lease late-fee policy/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply late fee' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/v1/rent/payments/rp-late-no-fee/late-fee' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeDefined();
      expect((call![1] as RequestInit).body).toBe(JSON.stringify({}));
    });

    expect(await screen.findByText('Late fee of $50.00 applied.')).toBeInTheDocument();
    expect(screen.queryByText('Apply late fee?')).not.toBeInTheDocument();
  });

  it("surfaces the server's 400 message verbatim when applying a late fee fails", async () => {
    stubDesktopViewport();
    const fetchMock = makeFetch([
      ...baseRoutes,
      {
        method: 'POST',
        path: '/api/v1/rent/payments/rp-late-no-fee/late-fee',
        status: 400,
        body: { error: { code: 'bad_request', message: 'no late-fee policy configured' } },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderRentTracker();

    const targetRow = (await screen.findByText('T. Okafor')).closest('tr') as HTMLElement;
    fireEvent.click(within(targetRow).getByRole('button', { name: /Apply late fee — T\. Okafor/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Apply late fee?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply late fee' }));

    expect(await screen.findByText('no late-fee policy configured')).toBeInTheDocument();
  });

  it('waiving a late fee is reachable from the Deposits modal (even with zero deposits), DELETEs, and toasts the result', async () => {
    stubDesktopViewport();
    const fetchMock = makeFetch([
      ...baseRoutes,
      { method: 'DELETE', path: '/api/v1/rent/payments/rp-late-fee/late-fee', status: 204 },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderRentTracker();

    const targetRow = (await screen.findByText('J. Rivera')).closest('tr') as HTMLElement;
    fireEvent.click(within(targetRow).getByRole('button', { name: /Deposits — J\. Rivera/ }));

    const depositsDialog = await screen.findByRole('dialog', { name: 'Deposits — J. Rivera' });
    expect(within(depositsDialog).getByText('$50.00')).toBeInTheDocument();
    fireEvent.click(within(depositsDialog).getByRole('button', { name: 'Waive' }));

    // Opening Waive closes the Deposits modal (no nested dialogs).
    expect(screen.queryByText('Deposits — J. Rivera')).not.toBeInTheDocument();
    const waiveDialog = await screen.findByRole('dialog', { name: 'Waive late fee?' });
    expect(within(waiveDialog).getByText(/Removes the \$50\.00 late fee/)).toBeInTheDocument();
    fireEvent.click(within(waiveDialog).getByRole('button', { name: 'Waive fee' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === '/api/v1/rent/payments/rp-late-fee/late-fee' &&
            (init as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true);
    });
    expect(await screen.findByText('Late fee waived for J. Rivera.')).toBeInTheDocument();
  });

  it("surfaces the server's 400 message verbatim when waiving fails (e.g. fully collected)", async () => {
    stubDesktopViewport();
    const fetchMock = makeFetch([
      ...baseRoutes,
      {
        method: 'DELETE',
        path: '/api/v1/rent/payments/rp-late-fee/late-fee',
        status: 400,
        body: {
          error: {
            code: 'bad_request',
            message: 'part of this late fee has already been collected — waiving it now would leave an overpayment',
          },
        },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderRentTracker();

    const targetRow = (await screen.findByText('J. Rivera')).closest('tr') as HTMLElement;
    fireEvent.click(within(targetRow).getByRole('button', { name: /Deposits — J\. Rivera/ }));
    const depositsDialog = await screen.findByRole('dialog', { name: 'Deposits — J. Rivera' });
    fireEvent.click(within(depositsDialog).getByRole('button', { name: 'Waive' }));
    const waiveDialog = await screen.findByRole('dialog', { name: 'Waive late fee?' });
    fireEvent.click(within(waiveDialog).getByRole('button', { name: 'Waive fee' }));

    expect(
      await screen.findByText(
        'part of this late fee has already been collected — waiving it now would leave an overpayment',
      ),
    ).toBeInTheDocument();
  });
});
