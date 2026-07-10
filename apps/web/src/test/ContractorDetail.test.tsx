// ContractorDetail: renders from a mocked useContractor result (same
// mocked-hook style as Contractors.test.tsx) — header/stats/contact formatting
// holds (scheme-prefixed website link, tel/mailto links, low-sample rating),
// job rows format date/amount with an em-dash for a null property, archived
// contractors show the visible marker instead of Delete, and the delete flow
// archives then navigates back to the list.
import type { ContractorDetailResponse } from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as queries from '../api/queries';
import { ToastProvider } from '../components/ui/Toast';
import { formatDate } from '../lib/format';
import { ContractorDetail } from '../pages/ContractorDetail';

vi.mock('../api/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/queries')>();
  return {
    ...actual,
    useContractor: vi.fn(),
    useCreateContractor: vi.fn(),
    useUpdateContractor: vi.fn(),
    useArchiveContractor: vi.fn(),
  };
});

const contractor = {
  id: 'c1',
  accountId: 'a1',
  name: 'Mario Rossi',
  trade: 'Plumbing',
  rating: 4.9,
  phone: '555-0100',
  email: 'mario@rossi.example',
  website: 'rossiplumbing.com', // bare domain — the link must prefix https://
  notes: 'Fast and tidy.',
  createdAt: '2026-01-05T00:00:00.000Z',
  archivedAt: null as string | null,
};

const detailData: ContractorDetailResponse = {
  contractor,
  jobsCount: 12,
  avgCostCents: 21000,
  lastUsedAt: '2026-06-15T00:00:00.000Z',
  jobs: [
    {
      id: 't1',
      date: '2026-06-15T00:00:00.000Z',
      description: 'Water heater replacement',
      amountCents: 48500,
      propertyLabel: 'Maple Duplex',
    },
    {
      id: 't2',
      date: '2026-05-02T00:00:00.000Z',
      description: 'Leak repair',
      amountCents: 18500,
      propertyLabel: null,
    },
  ],
};

function queryResult(
  data: ContractorDetailResponse | undefined,
  opts: { isPending?: boolean; isError?: boolean } = {},
) {
  return {
    data,
    isPending: opts.isPending ?? false,
    isError: opts.isError ?? false,
    error: opts.isError ? new Error('boom') : null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof queries.useContractor>;
}

/** Idle mutation stub, cast to the hook's own result type at the call site. */
function mutationResult<T>(mutate = vi.fn()): T {
  return { mutate, isPending: false } as unknown as T;
}

type CreateResult = ReturnType<typeof queries.useCreateContractor>;
type UpdateResult = ReturnType<typeof queries.useUpdateContractor>;
type ArchiveResult = ReturnType<typeof queries.useArchiveContractor>;

const mockedContractor = vi.mocked(queries.useContractor);
const mockedCreate = vi.mocked(queries.useCreateContractor);
const mockedUpdate = vi.mocked(queries.useUpdateContractor);
const mockedArchive = vi.mocked(queries.useArchiveContractor);

beforeEach(() => {
  vi.clearAllMocks();
  mockedContractor.mockReturnValue(queryResult(detailData));
  mockedCreate.mockReturnValue(mutationResult<CreateResult>());
  mockedUpdate.mockReturnValue(mutationResult<UpdateResult>());
  mockedArchive.mockReturnValue(mutationResult<ArchiveResult>());
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/maintenance/contractors/c1']}>
          <Routes>
            {/* Pages render inside AppShell's <main> in the app; mirroring that
                here keeps PageHeader's <header> out of the banner landmark. */}
            <Route
              path="/maintenance/contractors/:id"
              element={
                <main>
                  <ContractorDetail />
                </main>
              }
            />
            {/* Marker route so the delete flow's navigation is observable. */}
            <Route path="/maintenance/contractors" element={<main>Contractors list</main>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ContractorDetail', () => {
  it('renders the name, trade, stats, and contact details', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: 'Mario Rossi' })).toBeInTheDocument();
    expect(screen.getByText('Plumbing')).toBeInTheDocument();

    // Stats: jobs count, whole-dollar avg cost, month + year last used.
    expect(screen.getByRole('group', { name: 'Jobs, 12' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Average cost, $210' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Last used, Jun 2026' })).toBeInTheDocument();

    // Rating to one decimal — 12 jobs, so no low-sample marker.
    expect(screen.getByText('4.9')).toBeInTheDocument();
    expect(screen.queryByText('· low sample')).not.toBeInTheDocument();

    expect(screen.getByRole('link', { name: '555-0100' })).toHaveAttribute(
      'href',
      'tel:555-0100',
    );
    expect(screen.getByRole('link', { name: 'mario@rossi.example' })).toHaveAttribute(
      'href',
      'mailto:mario@rossi.example',
    );
    expect(screen.getByText('Fast and tidy.')).toBeInTheDocument();
  });

  it('renders a bare-domain website as an https-prefixed external link showing the raw value', () => {
    renderPage();

    const link = screen.getByRole('link', { name: 'rossiplumbing.com' });
    expect(link).toHaveAttribute('href', 'https://rossiplumbing.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
  });

  it('marks a rating built on fewer than 3 jobs with visible low-sample text', () => {
    mockedContractor.mockReturnValue(queryResult({ ...detailData, jobsCount: 2 }));
    renderPage();

    expect(screen.getByText('· low sample')).toBeInTheDocument();
  });

  it('renders job rows with formatted date and amount, and — for a null property', () => {
    renderPage();

    const table = screen.getByRole('table', {
      name: 'Mario Rossi — job history from matched expenses',
    });
    const row = within(table).getByText('Water heater replacement').closest('tr') as HTMLElement;
    expect(within(row).getByText(formatDate('2026-06-15T00:00:00.000Z'))).toBeInTheDocument();
    expect(within(row).getByText('$485.00')).toBeInTheDocument();
    expect(within(row).getByText('Maple Duplex')).toBeInTheDocument();

    const nullPropertyRow = within(table).getByText('Leak repair').closest('tr') as HTMLElement;
    expect(within(nullPropertyRow).getByText('—')).toBeInTheDocument();
    expect(within(nullPropertyRow).getByText('$185.00')).toBeInTheDocument();
  });

  it('shows the empty job-history explainer when no expenses match', () => {
    mockedContractor.mockReturnValue(
      queryResult({ ...detailData, jobsCount: 0, avgCostCents: null, lastUsedAt: null, jobs: [] }),
    );
    renderPage();

    expect(screen.getByText(/build automatically from confirmed expenses/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows a visible Archived marker instead of the Delete action for an archived contractor', () => {
    mockedContractor.mockReturnValue(
      queryResult({
        ...detailData,
        contractor: { ...contractor, archivedAt: '2026-07-01T00:00:00.000Z' },
      }),
    );
    renderPage();

    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    // Edit stays available either way.
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('archives on confirmed delete and navigates back to the list', async () => {
    const mutate = vi.fn((_id: string, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
    mockedArchive.mockReturnValue(mutationResult<ArchiveResult>(mutate));
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete contractor' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toBe('c1');
    expect(await screen.findByText('Contractors list')).toBeInTheDocument();
  });

  it('prefills the edit modal from the full contractor, including the website', async () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit contractor' });
    const modal = within(dialog);

    expect(modal.getByLabelText(/^Name/)).toHaveValue('Mario Rossi');
    expect(modal.getByLabelText(/^Website/)).toHaveValue('rossiplumbing.com');
    expect(modal.getByLabelText(/^Notes/)).toHaveValue('Fast and tidy.');
  });
});
