// ContractorsPage: rows render from a mocked useContractors result (the hooks
// are mocked so the suite doesn't depend on the backend routes landing),
// formatting rules hold (whole-dollar avg cost, month+year last-used, em-dash
// nulls, visible low-sample marker), and the create flow submits the entered
// values through the create mutation.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as queries from '../api/queries';
import type { ContractorListRow } from '../api/queries';
import { ToastProvider } from '../components/ui/Toast';
import { ContractorsPage } from '../pages/ContractorsPage';

vi.mock('../api/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/queries')>();
  return {
    ...actual,
    useContractors: vi.fn(),
    useCreateContractor: vi.fn(),
    useUpdateContractor: vi.fn(),
    useArchiveContractor: vi.fn(),
  };
});

const rows: ContractorListRow[] = [
  {
    id: 'c1',
    name: 'Mario Rossi',
    trade: 'Plumbing',
    rating: 4.9,
    phone: '555-0100',
    email: 'mario@rossi.example',
    website: 'rossiplumbing.com',
    notes: null,
    jobsCount: 12,
    avgCostCents: 21000,
    lastUsedAt: '2026-06-15T00:00:00.000Z',
  },
  {
    id: 'c2',
    name: 'Ana Silva',
    trade: 'Painting',
    rating: 4.5,
    phone: null,
    email: null,
    website: null,
    notes: null,
    jobsCount: 2,
    avgCostCents: 89000,
    lastUsedAt: '2026-03-02T00:00:00.000Z',
  },
  {
    id: 'c3',
    name: 'Ken Watts',
    trade: 'HVAC',
    rating: null,
    phone: null,
    email: null,
    website: null,
    notes: null,
    jobsCount: 0,
    avgCostCents: null,
    lastUsedAt: null,
  },
  {
    id: 'c4',
    name: 'Rosa Delgado',
    trade: 'Electrical',
    rating: 5,
    phone: null,
    email: null,
    website: null,
    notes: null,
    jobsCount: 7,
    avgCostCents: 45500,
    lastUsedAt: '2026-05-20T00:00:00.000Z',
  },
  {
    id: 'c5',
    name: 'Sam Igwe',
    trade: 'Roofing',
    rating: 4.2,
    phone: null,
    email: null,
    website: null,
    notes: null,
    jobsCount: 4,
    avgCostCents: 310000,
    lastUsedAt: '2025-11-08T00:00:00.000Z',
  },
  {
    id: 'c6',
    name: 'Lena Park',
    trade: 'Cleaning',
    rating: 4.8,
    phone: null,
    email: null,
    website: null,
    notes: null,
    jobsCount: 22,
    avgCostCents: 12000,
    lastUsedAt: '2026-07-01T00:00:00.000Z',
  },
];

function queryResult(
  data: ContractorListRow[] | undefined,
  opts: { isPending?: boolean; isError?: boolean } = {},
) {
  return {
    data,
    isPending: opts.isPending ?? false,
    isError: opts.isError ?? false,
    error: opts.isError ? new Error('boom') : null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof queries.useContractors>;
}

/** Idle mutation stub, cast to the hook's own result type at the call site. */
function mutationResult<T>(mutate = vi.fn()): T {
  return { mutate, isPending: false } as unknown as T;
}

type CreateResult = ReturnType<typeof queries.useCreateContractor>;
type UpdateResult = ReturnType<typeof queries.useUpdateContractor>;
type ArchiveResult = ReturnType<typeof queries.useArchiveContractor>;

const mockedContractors = vi.mocked(queries.useContractors);
const mockedCreate = vi.mocked(queries.useCreateContractor);
const mockedUpdate = vi.mocked(queries.useUpdateContractor);
const mockedArchive = vi.mocked(queries.useArchiveContractor);

beforeEach(() => {
  vi.clearAllMocks();
  mockedContractors.mockReturnValue(queryResult(rows));
  mockedCreate.mockReturnValue(mutationResult<CreateResult>());
  mockedUpdate.mockReturnValue(mutationResult<UpdateResult>());
  mockedArchive.mockReturnValue(mutationResult<ArchiveResult>());
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/maintenance/contractors']}>
          <Routes>
            {/* Pages render inside AppShell's <main> in the app; mirroring that
                here keeps PageHeader's <header> out of the banner landmark. */}
            <Route
              path="/maintenance/contractors"
              element={
                <main>
                  <ContractorsPage />
                </main>
              }
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest('tr');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe('ContractorsPage', () => {
  it('renders contractor rows and the saved count', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: 'Your contractors' })).toBeInTheDocument();
    expect(screen.getByText('6 saved')).toBeInTheDocument();
    for (const row of rows) {
      expect(screen.getByText(row.name)).toBeInTheDocument();
    }
    expect(within(rowOf('Mario Rossi')).getByText('Plumbing')).toBeInTheDocument();
  });

  it('formats avg cost as whole dollars, last used as month + year, and ratings to one decimal', () => {
    renderPage();

    const mario = within(rowOf('Mario Rossi'));
    expect(mario.getByText('$210')).toBeInTheDocument(); // 21000 cents, no decimals
    expect(mario.getByText('Jun 2026')).toBeInTheDocument();
    expect(mario.getByText('4.9')).toBeInTheDocument();
    expect(within(rowOf('Rosa Delgado')).getByText('5.0')).toBeInTheDocument();
  });

  it('renders — for null rating, avg cost, and last used', () => {
    renderPage();

    // Ken Watts has no job history: rating, avg cost, and last used all null.
    expect(within(rowOf('Ken Watts')).getAllByText('—')).toHaveLength(3);
  });

  it('marks ratings with fewer than 3 jobs with visible low-sample text', () => {
    renderPage();

    expect(within(rowOf('Ana Silva')).getByText('· low sample')).toBeInTheDocument();
    // Text, not color, carries the status — and well-sampled rows omit it.
    expect(within(rowOf('Mario Rossi')).queryByText('· low sample')).not.toBeInTheDocument();
    expect(screen.getAllByText('· low sample')).toHaveLength(1);
  });

  it('shows the empty state when there are no contractors', () => {
    mockedContractors.mockReturnValue(queryResult([]));
    renderPage();

    expect(screen.getByText('No contractors yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows a skeleton while the list is pending', () => {
    mockedContractors.mockReturnValue(queryResult(undefined, { isPending: true }));
    const { container } = renderPage();

    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('submits the create form with the entered values', async () => {
    const mutate = vi.fn();
    mockedCreate.mockReturnValue(mutationResult<CreateResult>(mutate));
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Add contractor' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add contractor' });
    const modal = within(dialog);

    fireEvent.input(modal.getByLabelText(/^Name/), { target: { value: 'Pat Doyle' } });
    fireEvent.input(modal.getByLabelText(/^Trade/), { target: { value: 'Handyman' } });
    fireEvent.input(modal.getByLabelText(/^Rating/), { target: { value: '4.5' } });
    fireEvent.input(modal.getByLabelText(/^Phone/), { target: { value: '555-0100' } });
    fireEvent.input(modal.getByLabelText(/^Website/), { target: { value: 'doylehandyman.com' } });
    fireEvent.click(modal.getByRole('button', { name: 'Add contractor' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      name: 'Pat Doyle',
      trade: 'Handyman',
      rating: 4.5,
      phone: '555-0100',
      website: 'doylehandyman.com',
    });
  });

  it('prefills the edit form and sends explicit nulls for cleared fields', async () => {
    const mutate = vi.fn();
    mockedUpdate.mockReturnValue(mutationResult<UpdateResult>(mutate));
    renderPage();

    // jsdom reports a narrow viewport, so RowActions renders the mobile "⋯"
    // menu: open it, then pick Edit from the bottom sheet.
    fireEvent.click(
      within(rowOf('Mario Rossi')).getByRole('button', { name: 'Actions for Mario Rossi' }),
    );
    const sheet = await screen.findByRole('dialog', { name: 'Actions for Mario Rossi' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit contractor' });
    const modal = within(dialog);

    expect(modal.getByLabelText(/^Name/)).toHaveValue('Mario Rossi');
    expect(modal.getByLabelText(/^Trade/)).toHaveValue('Plumbing');
    expect(modal.getByLabelText(/^Rating/)).toHaveValue(4.9);
    expect(modal.getByLabelText(/^Phone/)).toHaveValue('555-0100');
    expect(modal.getByLabelText(/^Email/)).toHaveValue('mario@rossi.example');
    expect(modal.getByLabelText(/^Website/)).toHaveValue('rossiplumbing.com');

    // Blanking an optional field on edit clears it (explicit null in the PATCH).
    fireEvent.input(modal.getByLabelText(/^Phone/), { target: { value: '' } });
    fireEvent.input(modal.getByLabelText(/^Website/), { target: { value: '' } });
    fireEvent.input(modal.getByLabelText(/^Rating/), { target: { value: '4.8' } });
    fireEvent.click(modal.getByRole('button', { name: 'Save changes' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      id: 'c1',
      name: 'Mario Rossi',
      trade: 'Plumbing',
      rating: 4.8,
      phone: null,
      email: 'mario@rossi.example',
      website: null,
      notes: null,
    });
  });

  it('blocks submission with visible errors when required fields are missing', async () => {
    const mutate = vi.fn();
    mockedCreate.mockReturnValue(mutationResult<CreateResult>(mutate));
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Add contractor' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add contractor' });
    const modal = within(dialog);

    // Whitespace passes the native `required` attribute (which jsdom enforces,
    // swallowing the submit for truly empty fields) but fails the shared-schema
    // validation, so the visible per-field errors render.
    fireEvent.input(modal.getByLabelText(/^Name/), { target: { value: '   ' } });
    fireEvent.input(modal.getByLabelText(/^Trade/), { target: { value: '   ' } });
    fireEvent.click(modal.getByRole('button', { name: 'Add contractor' }));

    expect(mutate).not.toHaveBeenCalled();
    expect(await modal.findByText('Enter the contractor’s name.')).toBeInTheDocument();
    expect(modal.getByText('Enter their trade.')).toBeInTheDocument();
  });
});
