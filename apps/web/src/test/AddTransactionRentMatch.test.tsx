// AddTransaction rent-match prompt: a saved income whose create response
// carries a rentMatch opens the explicit "mark rent paid" offer (never
// auto-applied); accepting confirms with the rentPaymentId, declining (or a
// match-less save) goes straight to the ledger.
import { fireEvent, render, screen } from '@testing-library/react';
import type { CreateTransactionResponse, RentMatchSuggestion } from '@hearth/shared';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as queries from '../api/queries';
import { ToastProvider } from '../components/ui/Toast';
import { AddTransaction } from '../pages/AddTransaction';

vi.mock('../api/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/queries')>();
  return {
    ...actual,
    useCategories: vi.fn(),
    useProperties: vi.fn(),
    useCreateTransaction: vi.fn(),
    useConfirmTransaction: vi.fn(),
    useScanReceipt: vi.fn(),
    useUploadDocument: vi.fn(),
  };
});

const rentMatch: RentMatchSuggestion = {
  rentPaymentId: 'rp1',
  leaseId: 'l1',
  tenantName: 'T. Okafor',
  propertyId: 'p1',
  propertyLabel: '48 Maple St',
  unitId: 'u1',
  unitLabel: 'Main',
  period: '2026-07',
  dueDate: '2026-07-01T00:00:00.000Z',
  amountCents: 115000,
  confidence: 0.9,
};

function savedTxn(match: RentMatchSuggestion | null): CreateTransactionResponse {
  return {
    id: 't1',
    accountId: 'a1',
    propertyId: null,
    unitId: null,
    categoryId: null,
    date: '2026-07-03T12:00:00.000Z',
    amountCents: 115000,
    type: 'income',
    description: 'Check from Okafor',
    vendor: null,
    source: 'manual',
    status: 'confirmed',
    aiSuggestedCategoryId: null,
    aiConfidence: null,
    receiptUrl: null,
    createdAt: '2026-07-03T12:00:00.000Z',
    updatedAt: '2026-07-03T12:00:00.000Z',
    rentMatch: match,
  };
}

const createMutate = vi.fn();
const confirmMutate = vi.fn();

function mockMutation<T>(mutate: typeof createMutate): T {
  return { mutate, isPending: false } as unknown as T;
}

function renderPage() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/money/add']}>
        <Routes>
          <Route path="/money/add" element={<AddTransaction />} />
          <Route path="/money" element={<p>Money ledger page</p>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

function saveIncome() {
  fireEvent.click(screen.getByRole('radio', { name: 'income' }));
  fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '1150' } });
  fireEvent.change(screen.getByLabelText(/Description/), { target: { value: 'Check from Okafor' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save transaction' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queries.useCategories).mockReturnValue({ data: [] } as unknown as ReturnType<typeof queries.useCategories>);
  vi.mocked(queries.useProperties).mockReturnValue({ data: [] } as unknown as ReturnType<typeof queries.useProperties>);
  vi.mocked(queries.useScanReceipt).mockReturnValue(
    mockMutation<ReturnType<typeof queries.useScanReceipt>>(vi.fn()),
  );
  vi.mocked(queries.useUploadDocument).mockReturnValue(
    mockMutation<ReturnType<typeof queries.useUploadDocument>>(vi.fn()),
  );
  vi.mocked(queries.useCreateTransaction).mockReturnValue(
    mockMutation<ReturnType<typeof queries.useCreateTransaction>>(createMutate),
  );
  vi.mocked(queries.useConfirmTransaction).mockReturnValue(
    mockMutation<ReturnType<typeof queries.useConfirmTransaction>>(confirmMutate),
  );
});

describe('AddTransaction rent-match prompt', () => {
  it('offers the match after saving and confirms with the rentPaymentId on accept', () => {
    createMutate.mockImplementation((_input, opts) => opts?.onSuccess?.(savedTxn(rentMatch)));
    confirmMutate.mockImplementation((_input, opts) => opts?.onSuccess?.(savedTxn(null)));
    renderPage();
    saveIncome();

    // The offer is explicit and AI-marked; nothing was applied yet.
    expect(screen.getByRole('dialog', { name: 'Is this a rent payment?' })).toBeInTheDocument();
    expect(screen.getByText(/T\. Okafor/)).toBeInTheDocument();
    expect(confirmMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Mark rent paid' }));
    expect(confirmMutate).toHaveBeenCalledWith(
      { id: 't1', rentPaymentId: 'rp1' },
      expect.anything(),
    );
    expect(screen.getByText('Money ledger page')).toBeInTheDocument();
  });

  it('declining leaves the transaction as-is and navigates to the ledger', () => {
    createMutate.mockImplementation((_input, opts) => opts?.onSuccess?.(savedTxn(rentMatch)));
    renderPage();
    saveIncome();

    fireEvent.click(screen.getByRole('button', { name: 'No, keep as-is' }));
    expect(confirmMutate).not.toHaveBeenCalled();
    expect(screen.getByText('Money ledger page')).toBeInTheDocument();
  });

  it('navigates straight to the ledger when the save has no rent match', () => {
    createMutate.mockImplementation((_input, opts) => opts?.onSuccess?.(savedTxn(null)));
    renderPage();
    saveIncome();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Money ledger page')).toBeInTheDocument();
  });
});
