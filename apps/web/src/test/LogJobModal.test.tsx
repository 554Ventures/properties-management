// LogJobModal: manually logging a contractor job creates a real expense
// transaction server-side. Submitting valid fields calls the mutation with a
// cents-converted amount; a 'created' response toasts + closes; a
// 'possible_duplicate' response switches the modal into the duplicate-review
// step (advisory only — mirrors the review queue's rent-match suggestion);
// "Log anyway" resubmits the same fields with confirmDuplicate: true, and
// "Cancel" from that step returns to the editable form without further calls.
import type { ContractorJobRow, LogContractorJobResponse, PropertyWithStats } from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as queries from '../api/queries';
import { LogJobModal } from '../components/forms/LogJobModal';
import { ToastProvider, ToastViewport } from '../components/ui/Toast';

vi.mock('../api/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/queries')>();
  return {
    ...actual,
    useLogContractorJob: vi.fn(),
    useProperties: vi.fn(),
  };
});

const properties: PropertyWithStats[] = [
  {
    id: 'p1',
    accountId: 'a1',
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
    unitCount: 1,
    occupiedCount: 1,
    monthlyRentCents: 125000,
    statusLabel: 'Full',
  },
];

const duplicateRows: ContractorJobRow[] = [
  {
    id: 't1',
    date: '2026-07-01T00:00:00.000Z',
    description: 'Fixed leaking pipe under kitchen sink',
    amountCents: 18500,
    propertyLabel: 'Maple Duplex',
  },
];

function propertiesResult(): ReturnType<typeof queries.useProperties> {
  return {
    data: properties,
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof queries.useProperties>;
}

const mockedLogJob = vi.mocked(queries.useLogContractorJob);
const mockedProperties = vi.mocked(queries.useProperties);

function renderModal(onClose = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <LogJobModal open onClose={onClose} contractorId="c1" contractorName="Mario Rossi" />
        <ToastViewport />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onClose };
}

function fillForm() {
  fireEvent.input(screen.getByLabelText(/^Description/), {
    target: { value: 'Fixed leaking pipe under kitchen sink' },
  });
  fireEvent.input(screen.getByLabelText(/^Amount/), { target: { value: '185.00' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedProperties.mockReturnValue(propertiesResult());
});

describe('LogJobModal', () => {
  it('submits the validated, cents-converted input', () => {
    const mutate = vi.fn();
    mockedLogJob.mockReturnValue({ mutate, isPending: false } as unknown as ReturnType<
      typeof queries.useLogContractorJob
    >);
    renderModal();

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Log job' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    const [input] = mutate.mock.calls[0] as [Record<string, unknown>];
    expect(input.contractorId).toBe('c1');
    expect(input.description).toBe('Fixed leaking pipe under kitchen sink');
    expect(input.amountCents).toBe(18500);
    expect(input.propertyId).toBeUndefined();
  });

  it('toasts success and closes on a created response', () => {
    const mutate = vi.fn(
      (
        _input: unknown,
        opts?: { onSuccess?: (res: LogContractorJobResponse) => void },
      ) =>
        opts?.onSuccess?.({
          status: 'created',
          job: {
            id: 't9',
            date: '2026-07-09T00:00:00.000Z',
            description: 'Fixed leaking pipe under kitchen sink',
            amountCents: 18500,
            propertyLabel: null,
          },
        }),
    );
    mockedLogJob.mockReturnValue({ mutate, isPending: false } as unknown as ReturnType<
      typeof queries.useLogContractorJob
    >);
    const { onClose } = renderModal();

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Log job' }));

    expect(screen.getByText('Job logged.')).toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the candidate list and switches to the duplicate-review step on a possible_duplicate response', () => {
    const mutate = vi.fn(
      (
        _input: unknown,
        opts?: { onSuccess?: (res: LogContractorJobResponse) => void },
      ) => opts?.onSuccess?.({ status: 'possible_duplicate', duplicates: duplicateRows }),
    );
    mockedLogJob.mockReturnValue({ mutate, isPending: false } as unknown as ReturnType<
      typeof queries.useLogContractorJob
    >);
    renderModal();

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Log job' }));

    expect(
      screen.getByText(/looks similar to 1 existing expense for Mario Rossi/),
    ).toBeInTheDocument();
    expect(screen.getByText('Fixed leaking pipe under kitchen sink')).toBeInTheDocument();
    expect(screen.getByText('$185.00')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log job' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log anyway' })).toBeInTheDocument();
    // The focused "Log job" button unmounts on this step swap; Modal's own
    // focus trap only runs on open, so without re-focusing ourselves, focus
    // would drop to <body> and a keyboard user could tab out of the modal.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('resubmits with confirmDuplicate: true and the same fields on "Log anyway"', () => {
    const mutate = vi.fn(
      (
        input: { confirmDuplicate?: boolean },
        opts?: { onSuccess?: (res: LogContractorJobResponse) => void },
      ) => {
        if (!input.confirmDuplicate) {
          opts?.onSuccess?.({ status: 'possible_duplicate', duplicates: duplicateRows });
        } else {
          opts?.onSuccess?.({
            status: 'created',
            job: {
              id: 't9',
              date: '2026-07-09T00:00:00.000Z',
              description: 'Fixed leaking pipe under kitchen sink',
              amountCents: 18500,
              propertyLabel: null,
            },
          });
        }
      },
    );
    mockedLogJob.mockReturnValue({ mutate, isPending: false } as unknown as ReturnType<
      typeof queries.useLogContractorJob
    >);
    const { onClose } = renderModal();

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Log job' }));
    fireEvent.click(screen.getByRole('button', { name: 'Log anyway' }));

    expect(mutate).toHaveBeenCalledTimes(2);
    const [secondInput] = mutate.mock.calls[1] as [Record<string, unknown>];
    expect(secondInput.confirmDuplicate).toBe(true);
    expect(secondInput.description).toBe('Fixed leaking pipe under kitchen sink');
    expect(secondInput.amountCents).toBe(18500);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('returns to the editable form on Cancel from the duplicate-review step without further calls', () => {
    const mutate = vi.fn(
      (
        _input: unknown,
        opts?: { onSuccess?: (res: LogContractorJobResponse) => void },
      ) => opts?.onSuccess?.({ status: 'possible_duplicate', duplicates: duplicateRows }),
    );
    mockedLogJob.mockReturnValue({ mutate, isPending: false } as unknown as ReturnType<
      typeof queries.useLogContractorJob
    >);
    renderModal();

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Log job' }));
    expect(screen.getByRole('button', { name: 'Log anyway' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Log job' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Description/)).toHaveValue(
      'Fixed leaking pipe under kitchen sink',
    );
    expect(screen.getByLabelText(/^Amount/)).toHaveValue(185);
    // Focus returns into the form step, not <body>, on the reverse swap too.
    expect(document.activeElement).toBe(screen.getByLabelText(/^Date/));
  });
});
