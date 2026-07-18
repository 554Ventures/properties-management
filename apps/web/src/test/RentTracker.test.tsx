// Late fees v1 (WS7): "Apply late fee" is visible only on rows past their
// grace period with no fee applied yet (the row can't know the lease's
// effective policy up front, so the button stays amount-free and the toast
// reports the real figure from the response); applied rows show "+$X late
// fee" next to the amount due and expose "Waive" from the Payment details
// modal (reachable even with zero deposits, since the fee itself needs a way
// in). Confirm dialogs gate both actions; server 400s surface verbatim via
// toast. Also covers the redesigned UI: short status badges + a right-aligned
// Remaining column, triage-first row sort, status filter chips, KpiTile
// summary row, multi-tenant share/mismatch surfacing, and unlinked-deposit
// nudges inside a single AiSurface panel.
import type {
  RentTrackerResponse,
  RentTrackerRow,
  UnlinkedRentDepositsResponse,
} from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, ToastViewport } from '../components/ui/Toast';
import { currentPeriod, formatMonthLong } from '../lib/format';
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
    lastDepositAt: null,
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

// Partial past grace with a fee — drives the short "Partial · Nd" badge and
// the Remaining/paid-so-far assertions.
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
  it('shows Apply late fee only on eligible rows, "+$X late fee" on applied rows, the short partial badge + Remaining column, and passes axe', async () => {
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
      within(lateWithFeeRow).getByRole('button', { name: /Details — J\. Rivera/ }),
    ).toBeInTheDocument();

    const dueRow = screen.getByText('M. Chen').closest('tr') as HTMLElement;
    expect(within(dueRow).queryByRole('button', { name: /Apply late fee/ })).not.toBeInTheDocument();

    // Short badge (not the old long "Partial — $X of $Y ... · N days late"
    // string) plus the Remaining column: 115000 + 2500 − 50000 = 67500.
    const partialRow = screen.getByText('S. Patel').closest('tr') as HTMLElement;
    expect(within(partialRow).getByText('Partial · 3d')).toBeInTheDocument();
    expect(within(partialRow).getByText('$675.00')).toBeInTheDocument();
    expect(within(partialRow).getByText('$500.00 paid')).toBeInTheDocument();

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

  it('waiving a late fee is reachable from the Payment details modal (even with zero deposits), DELETEs, and toasts the result', async () => {
    stubDesktopViewport();
    const fetchMock = makeFetch([
      ...baseRoutes,
      { method: 'DELETE', path: '/api/v1/rent/payments/rp-late-fee/late-fee', status: 204 },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderRentTracker();

    const targetRow = (await screen.findByText('J. Rivera')).closest('tr') as HTMLElement;
    fireEvent.click(within(targetRow).getByRole('button', { name: /Details — J\. Rivera/ }));

    const depositsDialog = await screen.findByRole('dialog', { name: 'Payment details — J. Rivera' });
    expect(within(depositsDialog).getByText('$50.00')).toBeInTheDocument();
    fireEvent.click(within(depositsDialog).getByRole('button', { name: 'Waive' }));

    // Opening Waive closes the Payment details modal (no nested dialogs).
    expect(screen.queryByText('Payment details — J. Rivera')).not.toBeInTheDocument();
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
    fireEvent.click(within(targetRow).getByRole('button', { name: /Details — J\. Rivera/ }));
    const depositsDialog = await screen.findByRole('dialog', { name: 'Payment details — J. Rivera' });
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

// lastDepositAt (finance-correctness-hardening): the Paid column shows the
// newest deposit's date with a text "(partial)" qualifier when the charge
// isn't fully covered yet (paidAt stays null until it is).
describe('RentTracker Paid column — partial deposits', () => {
  it('renders the deposit date with a "(partial)" qualifier for a partial row, and paidAt unchanged for a paid row', async () => {
    stubDesktopViewport();
    const partialRow = makeRow({
      rentPaymentId: 'rp-partial-deposit',
      tenantId: 't5',
      tenantName: 'A. Nguyen',
      status: 'partial',
      paidCents: 50000,
      daysLate: 3,
      paidAt: null,
      lastDepositAt: '2026-07-03T00:00:00.000Z',
      tenants: [
        {
          tenantId: 't5',
          tenantName: 'A. Nguyen',
          isPrimary: true,
          shareCents: 115000,
          shareSpecified: false,
          paidCents: 50000,
          settled: false,
        },
      ],
    });
    const paidRow = makeRow({
      rentPaymentId: 'rp-paid',
      tenantId: 't6',
      tenantName: 'B. Ibrahim',
      status: 'paid',
      paidCents: 115000,
      daysLate: undefined,
      method: 'bank',
      // Distinct from dueDate ('2026-07-01') so the Paid-column assertion
      // below can't collide with the Due-column cell.
      paidAt: '2026-07-02T00:00:00.000Z',
      lastDepositAt: '2026-07-02T00:00:00.000Z',
      tenants: [
        {
          tenantId: 't6',
          tenantName: 'B. Ibrahim',
          isPrimary: true,
          shareCents: 115000,
          shareSpecified: false,
          paidCents: 115000,
          settled: true,
        },
      ],
    });
    const localTracker: RentTrackerResponse = {
      period,
      collectedCents: 165000,
      outstandingCents: 65000,
      paidUnits: 1,
      partialUnits: 1,
      totalUnits: 2,
      rows: [partialRow, paidRow],
    };
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { method: 'GET', path: '/api/v1/rent/tracker', body: localTracker },
        { method: 'GET', path: '/api/v1/rent/unlinked-deposits', body: { items: [] } },
        { method: 'GET', path: '/api/v1/insights', body: [] },
      ]),
    );
    const { container } = renderRentTracker();

    const partialTr = (await screen.findByText('A. Nguyen')).closest('tr') as HTMLElement;
    expect(within(partialTr).getByText('Jul 3, 2026')).toBeInTheDocument();
    expect(within(partialTr).getByText('(partial)')).toBeInTheDocument();

    const paidTr = screen.getByText('B. Ibrahim').closest('tr') as HTMLElement;
    expect(within(paidTr).getByText('Jul 2, 2026')).toBeInTheDocument();
    expect(within(paidTr).queryByText(/partial/)).not.toBeInTheDocument();

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

// Triage-first client sort: late outranks a partial still in grace, which
// outranks due/paid — regardless of tenant name or the fixture's own order.
describe('RentTracker row sort — triage-first', () => {
  it('orders rows late → partial (past grace) → due → paid, not by tenant name or input order', async () => {
    stubDesktopViewport();
    const lateRow = makeRow({
      rentPaymentId: 'rp-sort-late',
      tenantId: 'ts1',
      tenantName: 'Z. Late',
      status: 'late',
      daysLate: 6,
      tenants: [
        {
          tenantId: 'ts1',
          tenantName: 'Z. Late',
          isPrimary: true,
          shareCents: 115000,
          shareSpecified: false,
          paidCents: 0,
          settled: false,
        },
      ],
    });
    const partialLateRow = makeRow({
      rentPaymentId: 'rp-sort-partial',
      tenantId: 'ts2',
      tenantName: 'Y. Partial',
      status: 'partial',
      daysLate: 3,
      paidCents: 50000,
      tenants: [
        {
          tenantId: 'ts2',
          tenantName: 'Y. Partial',
          isPrimary: true,
          shareCents: 115000,
          shareSpecified: false,
          paidCents: 50000,
          settled: false,
        },
      ],
    });
    const dueRow = makeRow({
      rentPaymentId: 'rp-sort-due',
      tenantId: 'ts3',
      tenantName: 'X. Due',
      status: 'due',
      daysLate: undefined,
      tenants: [
        {
          tenantId: 'ts3',
          tenantName: 'X. Due',
          isPrimary: true,
          shareCents: 115000,
          shareSpecified: false,
          paidCents: 0,
          settled: false,
        },
      ],
    });
    const paidRow = makeRow({
      rentPaymentId: 'rp-sort-paid',
      tenantId: 'ts4',
      tenantName: 'W. Paid',
      status: 'paid',
      paidCents: 115000,
      daysLate: undefined,
      paidAt: '2026-07-02T00:00:00.000Z',
      tenants: [
        {
          tenantId: 'ts4',
          tenantName: 'W. Paid',
          isPrimary: true,
          shareCents: 115000,
          shareSpecified: false,
          paidCents: 115000,
          settled: true,
        },
      ],
    });
    // Deliberately shuffled, and named in the reverse of the expected order —
    // proves the sort is triage rank, not alphabetical or fixture order.
    const localTracker: RentTrackerResponse = {
      period,
      collectedCents: 115000,
      outstandingCents: 165000,
      paidUnits: 1,
      partialUnits: 1,
      totalUnits: 4,
      rows: [paidRow, dueRow, partialLateRow, lateRow],
    };
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { method: 'GET', path: '/api/v1/rent/tracker', body: localTracker },
        { method: 'GET', path: '/api/v1/rent/unlinked-deposits', body: { items: [] } },
        { method: 'GET', path: '/api/v1/insights', body: [] },
      ]),
    );
    renderRentTracker();

    await screen.findByText('Z. Late');
    const bodyRows = screen.getAllByRole('row').slice(1); // drop the header row
    expect(bodyRows).toHaveLength(4);
    expect(within(bodyRows[0]!).getByText('Z. Late')).toBeInTheDocument();
    expect(within(bodyRows[1]!).getByText('Y. Partial')).toBeInTheDocument();
    expect(within(bodyRows[2]!).getByText('X. Due')).toBeInTheDocument();
    expect(within(bodyRows[3]!).getByText('W. Paid')).toBeInTheDocument();
  });
});

describe('RentTracker filter chips', () => {
  it('shows chip counts, filters the table, updates aria-pressed and the live status text, and passes axe while filtered', async () => {
    stubDesktopViewport();
    vi.stubGlobal('fetch', makeFetch(baseRoutes));
    const { container } = renderRentTracker();

    await screen.findByText('T. Okafor');

    // Base tracker: 2 late (lateNoFee, lateWithFee), 1 partial (partialWithFee),
    // 1 due (dueNotLate), 0 paid.
    const chipGroup = screen.getByRole('group', { name: 'Filter by status' });
    expect(within(chipGroup).getByRole('button', { name: 'All (4)' })).toBeInTheDocument();
    const lateChip = within(chipGroup).getByRole('button', { name: 'Late (2)' });
    expect(within(chipGroup).getByRole('button', { name: 'Partial (1)' })).toBeInTheDocument();
    expect(within(chipGroup).getByRole('button', { name: 'Due (1)' })).toBeInTheDocument();
    expect(within(chipGroup).getByRole('button', { name: 'Paid (0)' })).toBeInTheDocument();

    fireEvent.click(lateChip);

    expect(lateChip).toHaveAttribute('aria-pressed', 'true');
    expect(within(chipGroup).getByRole('button', { name: 'All (4)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(within(chipGroup).getByRole('button', { name: 'Partial (1)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    const bodyRows = screen.getAllByRole('row').slice(1);
    expect(bodyRows).toHaveLength(2);
    expect(screen.getByText('T. Okafor')).toBeInTheDocument();
    expect(screen.getByText('J. Rivera')).toBeInTheDocument();
    expect(screen.queryByText('M. Chen')).not.toBeInTheDocument();
    expect(screen.queryByText('S. Patel')).not.toBeInTheDocument();

    expect(screen.getByText('Showing 2 of 4 tenants — Late.')).toBeInTheDocument();

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it('selecting a 0-count chip shows an empty-bucket row with a "Show all" reset', async () => {
    stubDesktopViewport();
    vi.stubGlobal('fetch', makeFetch(baseRoutes));
    renderRentTracker();

    await screen.findByText('T. Okafor');
    const chipGroup = screen.getByRole('group', { name: 'Filter by status' });
    fireEvent.click(within(chipGroup).getByRole('button', { name: 'Paid (0)' }));

    expect(screen.getByText(`No paid rows for ${formatMonthLong(period)}.`)).toBeInTheDocument();
    expect(screen.queryByText('T. Okafor')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));

    expect(within(chipGroup).getByRole('button', { name: 'All (4)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await screen.findByText('T. Okafor')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(5); // header + 4 tenant rows
  });
});

describe('RentTracker KPI tiles', () => {
  it('renders the three summary tiles with "of $… billed" lines computed from collected + outstanding', async () => {
    stubDesktopViewport();
    vi.stubGlobal('fetch', makeFetch(baseRoutes));
    renderRentTracker();

    await screen.findByText('T. Okafor');

    // billedCents = collectedCents (50000) + outstandingCents (300000) = 350000.
    const collectedTile = screen.getByRole('group', { name: /^Collected,/ });
    expect(within(collectedTile).getByText(/of \$3,500\.00 billed/)).toBeInTheDocument();
    expect(within(collectedTile).getByText(/1 partial/)).toBeInTheDocument();

    const outstandingTile = screen.getByRole('group', { name: /^Outstanding,/ });
    expect(within(outstandingTile).getByText(/of \$3,500\.00 billed/)).toBeInTheDocument();

    const unitsTile = screen.getByRole('group', { name: /^Units paid,/ });
    expect(within(unitsTile).getByText('0 of 4')).toBeInTheDocument();
    expect(within(unitsTile).getByText('0%')).toBeInTheDocument();
  });
});

describe('RentTracker multi-tenant rows', () => {
  it('collapses a shared lease to one name + an "N tenants" button, flags a share mismatch, and the Payment details modal shows both shares plus the mismatch sentence', async () => {
    stubDesktopViewport();
    const multiTenantRow = makeRow({
      rentPaymentId: 'rp-multi',
      tenantId: 't7',
      tenantName: 'K. Alvarez',
      status: 'due',
      daysLate: undefined,
      sharesMismatch: true,
      tenants: [
        {
          tenantId: 't7',
          tenantName: 'K. Alvarez',
          isPrimary: true,
          shareCents: 60000,
          shareSpecified: true,
          paidCents: 0,
          settled: false,
        },
        {
          tenantId: 't8',
          tenantName: 'L. Novak',
          isPrimary: false,
          shareCents: 60000,
          shareSpecified: true,
          paidCents: 0,
          settled: false,
        },
      ],
    });
    const localTracker: RentTrackerResponse = {
      period,
      collectedCents: 0,
      outstandingCents: 115000,
      paidUnits: 0,
      partialUnits: 0,
      totalUnits: 1,
      rows: [multiTenantRow],
    };
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { method: 'GET', path: '/api/v1/rent/tracker', body: localTracker },
        { method: 'GET', path: '/api/v1/rent/unlinked-deposits', body: { items: [] } },
        { method: 'GET', path: '/api/v1/insights', body: [] },
      ]),
    );
    renderRentTracker();

    const row = (await screen.findByText('K. Alvarez')).closest('tr') as HTMLElement;
    // Only the primary name shows in the Tenant cell — no bare "L. Novak" there.
    expect(within(row).queryByText('L. Novak')).not.toBeInTheDocument();
    const tenantsButton = within(row).getByRole('button', {
      name: /2 tenants — view shares for K\. Alvarez/,
    });
    expect(tenantsButton).toBeInTheDocument();
    expect(within(row).getByText(/Shares don.t match/)).toBeInTheDocument();

    fireEvent.click(tenantsButton);

    const dialog = await screen.findByRole('dialog', { name: 'Payment details — K. Alvarez' });
    expect(within(dialog).getByText('K. Alvarez')).toBeInTheDocument();
    expect(within(dialog).getByText('L. Novak')).toBeInTheDocument();
    // Shares (60000 + 60000 = 120000) don't add up to the 115000 charge.
    expect(
      within(dialog).getByText(/Shares don.t add up to the \$1,150\.00 charge/),
    ).toBeInTheDocument();
  });
});

describe('RentTracker unlinked rent deposits', () => {
  it('renders an unlinked deposit nudge inside the AiSurface panel and links it to the rent charge', async () => {
    stubDesktopViewport();
    const unlinkedItem: UnlinkedRentDepositsResponse['items'][number] = {
      transactionId: 'tx-unlinked',
      description: 'Zelle payment',
      amountCents: 115000,
      date: '2026-07-05T00:00:00.000Z',
      rentPaymentId: 'rp-late-no-fee',
      leaseId: 'l1',
      tenantName: 'T. Okafor',
      unitLabel: 'Main',
      propertyLabel: '21 Cedar Ct',
      period,
      remainingCents: 115000,
    };
    const fetchMock = makeFetch([
      ...baseRoutes.filter((r) => r.path !== '/api/v1/rent/unlinked-deposits'),
      { method: 'GET', path: '/api/v1/rent/unlinked-deposits', body: { items: [unlinkedItem] } },
      { method: 'POST', path: '/api/v1/transactions/tx-unlinked/confirm', body: {} },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderRentTracker();

    const panel = await screen.findByRole('region', { name: 'Unlinked rent deposits' });
    expect(within(panel).getByText('AI')).toBeInTheDocument();
    expect(within(panel).getByText(/Zelle payment/)).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: 'Link to rent' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/v1/transactions/tx-unlinked/confirm' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeDefined();
      expect((call![1] as RequestInit).body).toBe(
        JSON.stringify({ rentPaymentId: 'rp-late-no-fee' }),
      );
    });
  });
});
