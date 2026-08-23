// WorkOrderDetail: renders from a mocked useWorkOrderDetail result (same
// mocked-hook style as ContractorDetail.test.tsx) — KPI tiles (quote/actual/
// variance/days open), the quick status/priority/contractor/schedule
// controls auto-save through useUpdateWorkOrder, the linked-cost table shows
// which rows count (never color alone), permission gating swaps controls for
// read-only text while loading defaults permissive (owner), and archiving
// navigates back to the index.
import type { CurrentUser, WorkOrderDetailResponse } from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as queries from '../api/queries';
import { ToastProvider } from '../components/ui/Toast';
import { WorkOrderDetail } from '../pages/WorkOrderDetail';

vi.mock('../api/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/queries')>();
  return {
    ...actual,
    useWorkOrderDetail: vi.fn(),
    useContractors: vi.fn(),
    useUpdateWorkOrder: vi.fn(),
    useArchiveWorkOrder: vi.fn(),
    useRestoreWorkOrder: vi.fn(),
    useCurrentUser: vi.fn(),
  };
});

const detail: WorkOrderDetailResponse = {
  id: 'w1',
  accountId: 'acc1',
  propertyId: 'p1',
  unitId: 'u1',
  title: 'Faucet replacement',
  description: 'Kitchen faucet leaking at the base.',
  status: 'in_progress',
  priority: 'normal',
  contractorId: 'c1',
  reportedOn: '2026-07-01',
  scheduledFor: '2026-07-10',
  dueBy: '2026-07-15',
  completedOn: null,
  quotedCents: 20000,
  source: 'landlord',
  tenantId: null,
  notes: 'Tenant says it started last week.',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  archivedAt: null,
  costCents: 24500,
  linkedTransactionCount: 2,
  quoteVarianceCents: 4500,
  daysOpen: 44,
  overdue: false,
  propertyLabel: 'Maple Duplex',
  unitLabel: 'Unit A',
  contractorName: 'Rivera Plumbing',
  tenantName: null,
  costs: [
    {
      transactionId: 't1',
      date: '2026-07-05T00:00:00.000Z',
      description: 'Faucet hardware',
      vendor: 'Rivera Plumbing',
      amountCents: 18500,
      countedInCost: true,
    },
    {
      transactionId: 't2',
      date: '2026-07-08T00:00:00.000Z',
      description: 'Deposit — pending review',
      vendor: 'Rivera Plumbing',
      amountCents: 6000,
      countedInCost: true,
    },
    {
      transactionId: 't3',
      date: '2026-07-09T00:00:00.000Z',
      description: 'Owner reimbursement',
      vendor: null,
      amountCents: 5000,
      countedInCost: false,
    },
  ],
};

const contractors = [
  { id: 'c1', name: 'Rivera Plumbing', trade: 'Plumbing', rating: null, phone: null, email: null, website: null, notes: null, jobsCount: 3, avgCostCents: 20000, lastUsedAt: null },
];

function queryResult<T>(data: T | undefined, opts: { isPending?: boolean; isError?: boolean } = {}) {
  return {
    data,
    isPending: opts.isPending ?? false,
    isError: opts.isError ?? false,
    error: opts.isError ? new Error('boom') : null,
    refetch: vi.fn(),
  };
}

function mutationResult<T>(mutate = vi.fn(), isPending = false): T {
  return { mutate, isPending } as unknown as T;
}

const mockedDetail = vi.mocked(queries.useWorkOrderDetail);
const mockedContractors = vi.mocked(queries.useContractors);
const mockedUpdate = vi.mocked(queries.useUpdateWorkOrder);
const mockedArchive = vi.mocked(queries.useArchiveWorkOrder);
const mockedRestore = vi.mocked(queries.useRestoreWorkOrder);
const mockedCurrentUser = vi.mocked(queries.useCurrentUser);

const owner: CurrentUser = { userId: null, role: 'owner', permissions: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mockedDetail.mockReturnValue(
    queryResult(detail) as unknown as ReturnType<typeof queries.useWorkOrderDetail>,
  );
  mockedContractors.mockReturnValue(
    queryResult(contractors) as unknown as ReturnType<typeof queries.useContractors>,
  );
  mockedUpdate.mockReturnValue(mutationResult<ReturnType<typeof queries.useUpdateWorkOrder>>());
  mockedArchive.mockReturnValue(mutationResult<ReturnType<typeof queries.useArchiveWorkOrder>>());
  mockedRestore.mockReturnValue(mutationResult<ReturnType<typeof queries.useRestoreWorkOrder>>());
  mockedCurrentUser.mockReturnValue(
    queryResult(owner) as unknown as ReturnType<typeof queries.useCurrentUser>,
  );
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/maintenance/w1']}>
          <Routes>
            <Route
              path="/maintenance/:id"
              element={
                <main>
                  <WorkOrderDetail />
                </main>
              }
            />
            {/* Marker route so the archive flow's navigation is observable. */}
            <Route path="/maintenance" element={<main>Work orders list</main>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('WorkOrderDetail', () => {
  it('renders the title, KPI tiles (quote, actual, variance, days open), and the quick controls at their current values', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: 'Faucet replacement' })).toBeInTheDocument();
    expect(screen.getByText('Maple Duplex · Unit A')).toBeInTheDocument();

    expect(screen.getByRole('group', { name: 'Quote, $200' })).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Actual cost, $245, across 2 linked transactions' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /Variance, \$45\.00 over quote/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Days open, 44' })).toBeInTheDocument();

    expect(screen.getByLabelText('Status')).toHaveValue('in_progress');
    expect(screen.getByLabelText('Priority')).toHaveValue('normal');
    expect(screen.getByLabelText('Contractor')).toHaveValue('c1');
    expect(screen.getByLabelText('Scheduled for')).toHaveValue('2026-07-10');
    expect(screen.getByLabelText('Due by')).toHaveValue('2026-07-15');
  });

  it('renders the linked-cost table with which rows count toward the derived total, never color alone', () => {
    renderPage();

    const table = screen.getByRole('table', {
      name: 'Faucet replacement — linked expenses and which count toward actual cost',
    });
    // Scoped to the body — the header cell is itself named "Counted".
    const tbody = within(table.querySelector('tbody') as HTMLElement);
    const counted = tbody.getAllByText('Counted');
    const notCounted = tbody.getAllByText('Not counted');
    expect(counted).toHaveLength(2);
    expect(notCounted).toHaveLength(1);
    expect(tbody.getByText('Faucet hardware')).toBeInTheDocument();
    expect(tbody.getByText('Owner reimbursement')).toBeInTheDocument();
    // The general explanation for "not counted" rows renders as visible text.
    expect(
      screen.getByText(/still-pending row, or one marked as a transfer, owner contribution, or/),
    ).toBeInTheDocument();
  });

  it('changing Status/Priority/Contractor/schedule fields auto-saves through useUpdateWorkOrder', () => {
    const mutate = vi.fn();
    mockedUpdate.mockReturnValue(mutationResult<ReturnType<typeof queries.useUpdateWorkOrder>>(mutate));
    renderPage();

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'completed' } });
    expect(mutate).toHaveBeenLastCalledWith(
      { id: 'w1', status: 'completed' },
      expect.anything(),
    );

    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'emergency' } });
    expect(mutate).toHaveBeenLastCalledWith(
      { id: 'w1', priority: 'emergency' },
      expect.anything(),
    );

    fireEvent.change(screen.getByLabelText('Contractor'), { target: { value: '' } });
    expect(mutate).toHaveBeenLastCalledWith(
      { id: 'w1', contractorId: null },
      expect.anything(),
    );

    fireEvent.change(screen.getByLabelText('Scheduled for'), { target: { value: '' } });
    expect(mutate).toHaveBeenLastCalledWith(
      { id: 'w1', scheduledFor: null },
      expect.anything(),
    );
  });

  it('archiving confirms, archives, and navigates back to the work order list', async () => {
    const mutate = vi.fn((_id: string, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
    mockedArchive.mockReturnValue(mutationResult<ReturnType<typeof queries.useArchiveWorkOrder>>(mutate));
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive work order' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toBe('w1');
    expect(await screen.findByText('Work orders list')).toBeInTheDocument();
  });

  it('shows a visible Archived marker and a Restore action instead of Edit/Archive for an archived work order', () => {
    mockedDetail.mockReturnValue(
      queryResult({ ...detail, archivedAt: '2026-07-20T00:00:00.000Z' }) as unknown as ReturnType<
        typeof queries.useWorkOrderDetail
      >,
    );
    renderPage();

    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
  });

  it('a member without the properties permission sees read-only status/priority/contractor/schedule text and no write controls', () => {
    mockedCurrentUser.mockReturnValue(
      queryResult({ userId: 'u2', role: 'member', permissions: [] }) as unknown as ReturnType<
        typeof queries.useCurrentUser
      >,
    );
    renderPage();

    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Priority')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Contractor')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Scheduled for')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();

    // The read-only equivalents still convey the same information as text
    // (the contractor name also appears in the linked-cost table's vendor
    // column, so this asserts at least one visible occurrence).
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('Normal')).toBeInTheDocument();
    expect(screen.getAllByText('Rivera Plumbing').length).toBeGreaterThan(0);
  });

  it('opens the Edit modal prefilled from the work order', async () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit work order' });
    const modal = within(dialog);

    expect(modal.getByLabelText(/^Title/)).toHaveValue('Faucet replacement');
    expect(modal.getByLabelText(/^Quote/)).toHaveValue(200);
    expect(modal.getByLabelText(/^Notes/)).toHaveValue('Tenant says it started last week.');
    // Priority/contractor/schedule stay off the edit modal — they're the
    // detail page's own quick controls.
    expect(modal.queryByLabelText(/^Priority/)).not.toBeInTheDocument();
  });
});
