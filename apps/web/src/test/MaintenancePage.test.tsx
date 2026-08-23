// MaintenancePage (work order index): rows render from a mocked
// useWorkOrders result (same mocked-hook style as Contractors.test.tsx),
// status/priority render as text (never color alone), overdue shows a
// visible marker, the sibling Contractors tab is present, and the create
// flow submits the entered values through the create mutation.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropertyWithStats, WorkOrderListRow } from '@hearth/shared';
import * as queries from '../api/queries';
import { ToastProvider } from '../components/ui/Toast';
import { MaintenancePage } from '../pages/MaintenancePage';

vi.mock('../api/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/queries')>();
  return {
    ...actual,
    useWorkOrders: vi.fn(),
    useProperties: vi.fn(),
    useCreateWorkOrder: vi.fn(),
  };
});

const properties: PropertyWithStats[] = [
  {
    id: 'p1',
    accountId: 'acc1',
    nickname: 'Maple Duplex',
    addressLine1: '12 Maple St',
    city: 'Springfield',
    state: 'IL',
    zip: '62704',
    acquisitionDate: null,
    acquisitionCostCents: null,
    notes: null,
    createdAt: '2020-01-01T00:00:00.000Z',
    archivedAt: null,
    unitCount: 2,
    occupiedCount: 2,
    monthlyRentCents: 250000,
    statusLabel: 'Full',
  },
];

const rows: WorkOrderListRow[] = [
  {
    id: 'w1',
    accountId: 'acc1',
    propertyId: 'p1',
    unitId: null,
    title: 'Roof leak by chimney',
    description: null,
    status: 'open',
    priority: 'emergency',
    contractorId: null,
    reportedOn: '2026-07-01',
    scheduledFor: null,
    dueBy: '2026-07-05',
    completedOn: null,
    quotedCents: null,
    source: 'landlord',
    tenantId: null,
    notes: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    archivedAt: null,
    costCents: 0,
    linkedTransactionCount: 0,
    quoteVarianceCents: null,
    daysOpen: 44,
    overdue: true,
    propertyLabel: 'Maple Duplex',
    unitLabel: null,
    contractorName: null,
    tenantName: null,
  },
  {
    id: 'w2',
    accountId: 'acc1',
    propertyId: 'p1',
    unitId: 'u1',
    title: 'Faucet replacement',
    description: null,
    status: 'scheduled',
    priority: 'normal',
    contractorId: 'c1',
    reportedOn: '2026-08-01',
    scheduledFor: '2026-08-10',
    dueBy: null,
    completedOn: null,
    quotedCents: 20000,
    source: 'landlord',
    tenantId: null,
    notes: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    archivedAt: null,
    costCents: 0,
    linkedTransactionCount: 0,
    quoteVarianceCents: null,
    daysOpen: 13,
    overdue: false,
    propertyLabel: 'Maple Duplex',
    unitLabel: 'Unit A',
    contractorName: 'Rivera Plumbing',
    tenantName: null,
  },
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

function mutationResult<T>(mutate = vi.fn()): T {
  return { mutate, isPending: false } as unknown as T;
}

const mockedWorkOrders = vi.mocked(queries.useWorkOrders);
const mockedProperties = vi.mocked(queries.useProperties);
const mockedCreate = vi.mocked(queries.useCreateWorkOrder);

beforeEach(() => {
  vi.clearAllMocks();
  mockedWorkOrders.mockReturnValue(
    queryResult(rows) as unknown as ReturnType<typeof queries.useWorkOrders>,
  );
  mockedProperties.mockReturnValue(
    queryResult(properties) as unknown as ReturnType<typeof queries.useProperties>,
  );
  mockedCreate.mockReturnValue(mutationResult<ReturnType<typeof queries.useCreateWorkOrder>>());
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/maintenance']}>
          <Routes>
            <Route
              path="/maintenance"
              element={
                <main>
                  <MaintenancePage />
                </main>
              }
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function rowOf(title: string): HTMLElement {
  const row = screen.getByText(title).closest('tr');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe('MaintenancePage', () => {
  it('renders work order rows with property/unit, status, priority, contractor, and cost', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: 'Maintenance' })).toBeInTheDocument();
    expect(screen.getByText('Roof leak by chimney')).toBeInTheDocument();
    expect(screen.getByText('Faucet replacement')).toBeInTheDocument();

    const w1 = within(rowOf('Roof leak by chimney'));
    expect(w1.getByText('Open')).toBeInTheDocument();
    // Overdue is never color alone — visible text beside the status badge.
    expect(w1.getByText('Overdue')).toBeInTheDocument();
    expect(w1.getByText('Unassigned')).toBeInTheDocument();

    const w2 = within(rowOf('Faucet replacement'));
    expect(w2.getByText('Scheduled')).toBeInTheDocument();
    expect(w2.getByText('Rivera Plumbing')).toBeInTheDocument();
    expect(w2.getByText(/Maple Duplex/)).toBeInTheDocument();
    expect(w2.getByText(/Unit A/)).toBeInTheDocument();
  });

  it('renders the Work orders / Contractors tabs', () => {
    renderPage();

    const nav = screen.getByRole('navigation', { name: 'Maintenance sections' });
    expect(within(nav).getByRole('link', { name: 'Work orders' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Contractors' })).toHaveAttribute(
      'href',
      '/maintenance/contractors',
    );
  });

  it('shows the empty state when there are no work orders', () => {
    mockedWorkOrders.mockReturnValue(
      queryResult([]) as unknown as ReturnType<typeof queries.useWorkOrders>,
    );
    renderPage();

    expect(screen.getByText('No work orders yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows a skeleton while the list is pending', () => {
    mockedWorkOrders.mockReturnValue(
      queryResult(undefined, { isPending: true }) as unknown as ReturnType<
        typeof queries.useWorkOrders
      >,
    );
    const { container } = renderPage();

    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('submits the create form with the entered values, letting the server default status', async () => {
    const mutate = vi.fn();
    mockedCreate.mockReturnValue(
      mutationResult<ReturnType<typeof queries.useCreateWorkOrder>>(mutate),
    );
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'New work order' }));
    const dialog = await screen.findByRole('dialog', { name: 'New work order' });
    const modal = within(dialog);

    fireEvent.input(modal.getByLabelText(/^Title/), { target: { value: 'Gutter cleaning' } });
    fireEvent.change(modal.getByLabelText(/^Property/), { target: { value: 'p1' } });
    fireEvent.change(modal.getByLabelText(/^Priority/), { target: { value: 'low' } });
    fireEvent.click(modal.getByRole('button', { name: 'Create work order' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      title: 'Gutter cleaning',
      propertyId: 'p1',
      priority: 'low',
    });
  });

  it('blocks submission with a visible error when required fields are missing', async () => {
    const mutate = vi.fn();
    mockedCreate.mockReturnValue(
      mutationResult<ReturnType<typeof queries.useCreateWorkOrder>>(mutate),
    );
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'New work order' }));
    const dialog = await screen.findByRole('dialog', { name: 'New work order' });
    const modal = within(dialog);

    fireEvent.input(modal.getByLabelText(/^Title/), { target: { value: '   ' } });
    // fireEvent.submit on the form itself (rather than clicking the submit
    // button) bypasses jsdom's own native `required` constraint validation on
    // the empty Property <select>, so this exercises the shared-schema
    // validation path instead of the browser's own blocking.
    fireEvent.submit(modal.getByRole('button', { name: 'Create work order' }).closest('form')!);

    expect(mutate).not.toHaveBeenCalled();
    expect(await modal.findByText('Enter a short title for the work order.')).toBeInTheDocument();
    expect(modal.getByText('Choose a property.')).toBeInTheDocument();
  });
});
