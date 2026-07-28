// Transaction edit modal — "+ New category…" in the category picker (beta
// feedback): selecting it opens an inline name field, Add POSTs /categories
// with the picker's current type (expense here), and the created category is
// selected in place once the list refetches. Cancel restores the picker.
import type { Category, Transaction } from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TransactionEditModal } from '../components/forms/TransactionEditModal';
import { ToastProvider, ToastViewport } from '../components/ui/Toast';

// The embedded attachments card has its own tests; keep this one focused.
vi.mock('../components/documents/DocumentsCard', () => ({
  DocumentsCard: () => null,
}));

const transaction: Transaction = {
  id: 'tx1',
  accountId: 'acc1',
  propertyId: null,
  unitId: null,
  categoryId: 'c1',
  date: '2026-07-02T00:00:00.000Z',
  amountCents: 64000,
  type: 'expense',
  description: 'Yard work',
  vendor: 'GreenThumb',
  source: 'manual',
  status: 'confirmed',
  classification: null,
  aiSuggestedCategoryId: null,
  aiConfidence: null,
  receiptUrl: null,
  createdAt: '2026-07-02T00:00:00.000Z',
  updatedAt: '2026-07-02T00:00:00.000Z',
};

function category(overrides: Partial<Category> & Pick<Category, 'id' | 'name' | 'type'>): Category {
  return { accountId: null, irsScheduleELine: null, isSystem: true, ...overrides };
}

// A row already split across two expense categories — Repairs + Utilities
// summing to its $640.00 total (`categoryId: null` is how the parent row
// looks once splits ARE its categorization).
const splitTransaction: Transaction = {
  ...transaction,
  id: 'tx-split',
  categoryId: null,
  splits: [
    { id: 's1', categoryId: 'c1', amountCents: 40000 },
    { id: 's3', categoryId: 'c3', amountCents: 24000 },
  ],
};

// Splits are confirmed-only server-side — the toggle hides for anything else.
const pendingTransaction: Transaction = {
  ...transaction,
  id: 'tx-pending',
  status: 'pending_review',
};

/** Fetch stub with a live categories list: POST /categories appends + returns
 *  the created row, so the invalidation-driven refetch sees it. PATCH
 *  /transactions/:id echoes the transaction back and records the body so
 *  save-mapping tests can assert on it. */
function stubFetch() {
  const categories: Category[] = [
    category({ id: 'c1', name: 'Repairs', type: 'expense' }),
    category({ id: 'c2', name: 'Rent', type: 'income' }),
    category({ id: 'c3', name: 'Utilities', type: 'expense' }),
  ];
  const posts: Array<Record<string, unknown>> = [];
  const patches: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
      if (path === '/api/v1/categories' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { name: string; type: 'income' | 'expense' };
        posts.push(body);
        const created = category({
          id: 'c-new',
          name: body.name,
          type: body.type,
          accountId: 'acc1',
          isSystem: false,
        });
        categories.push(created);
        return Promise.resolve(
          new Response(JSON.stringify(created), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (path.startsWith('/api/v1/transactions/') && init?.method === 'PATCH') {
        patches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Promise.resolve(
          new Response(JSON.stringify(transaction), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      const fixtures: Record<string, unknown> = {
        '/api/v1/categories': categories,
        '/api/v1/properties': [],
      };
      const body = fixtures[path];
      return Promise.resolve(
        new Response(
          JSON.stringify(
            body ?? { error: { code: 'not_found', message: `No fixture for ${path}` } },
          ),
          {
            status: body === undefined ? 404 : 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );
    }),
  );
  return { posts, patches };
}

function renderModal(txn: Transaction = transaction) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <TransactionEditModal open onClose={vi.fn()} transaction={txn} />
        <ToastViewport />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TransactionEditModal new-category flow', () => {
  it('creates a category of the picker type and selects it in place', async () => {
    const { posts } = stubFetch();
    renderModal();

    const select = (await screen.findByLabelText('Category')) as HTMLSelectElement;
    await screen.findByRole('option', { name: 'Repairs' });
    fireEvent.change(select, { target: { value: '__new__' } });

    fireEvent.change(screen.getByLabelText('New category name'), {
      target: { value: 'Landscaping' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    // Type comes from the picker context (expense transaction), not the user.
    expect(posts[0]).toEqual({ name: 'Landscaping', type: 'expense' });

    // Refetched list contains the new category and it is now selected.
    await screen.findByRole('option', { name: 'Landscaping' });
    await waitFor(() => expect(select.value).toBe('c-new'));
    expect(screen.queryByLabelText('New category name')).not.toBeInTheDocument();
    expect(await screen.findByText(/Category “Landscaping” added/)).toBeInTheDocument();
  });

  it('cancel closes the inline form without a request', async () => {
    const { posts } = stubFetch();
    renderModal();

    const select = (await screen.findByLabelText('Category')) as HTMLSelectElement;
    await screen.findByRole('option', { name: 'Repairs' });
    fireEvent.change(select, { target: { value: '__new__' } });
    const nameInput = screen.getByLabelText('New category name');

    // Scope to the inline panel — the modal footer has its own Cancel.
    const panel = nameInput.closest('div')!.parentElement!;
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('New category name')).not.toBeInTheDocument();
    expect(posts).toHaveLength(0);
    // Picker falls back to the transaction's current category.
    expect(select.value).toBe('c1');
  });
});

describe('TransactionEditModal split editor', () => {
  it('hides the split toggle for a non-confirmed row', async () => {
    stubFetch();
    renderModal(pendingTransaction);

    await screen.findByRole('option', { name: 'Repairs' });
    expect(
      screen.queryByRole('button', { name: 'Split across categories' }),
    ).not.toBeInTheDocument();
  });

  it('enabling split mode with two rows summing to the total sends splits and omits categoryId', async () => {
    const { patches } = stubFetch();
    renderModal();

    await screen.findByRole('option', { name: 'Repairs' });
    fireEvent.click(screen.getByRole('button', { name: 'Split across categories' }));

    fireEvent.change(screen.getByLabelText('Split 1 category'), { target: { value: 'c1' } });
    fireEvent.change(screen.getByLabelText('Split 1 amount (USD)'), {
      target: { value: '400.00' },
    });
    fireEvent.change(screen.getByLabelText('Split 2 category'), { target: { value: 'c3' } });
    fireEvent.change(screen.getByLabelText('Split 2 amount (USD)'), {
      target: { value: '240.00' },
    });

    // Fully allocated — no mismatch.
    expect(screen.getByText('$640.00 of $640.00 allocated · $0.00 remaining')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]!.splits).toEqual([
      { categoryId: 'c1', amountCents: 40000 },
      { categoryId: 'c3', amountCents: 24000 },
    ]);
    expect(patches[0]).not.toHaveProperty('categoryId');
  });

  it('a mismatched split sum blocks save and shows the allocation error', async () => {
    const { patches } = stubFetch();
    renderModal();

    await screen.findByRole('option', { name: 'Repairs' });
    fireEvent.click(screen.getByRole('button', { name: 'Split across categories' }));

    fireEvent.change(screen.getByLabelText('Split 1 category'), { target: { value: 'c1' } });
    fireEvent.change(screen.getByLabelText('Split 1 amount (USD)'), {
      target: { value: '100.00' },
    });
    fireEvent.change(screen.getByLabelText('Split 2 category'), { target: { value: 'c3' } });
    fireEvent.change(screen.getByLabelText('Split 2 amount (USD)'), {
      target: { value: '100.00' },
    });

    // $200 allocated against a $640 total — $440 still unaccounted for.
    expect(
      screen.getByText('$200.00 of $640.00 allocated · $440.00 remaining'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByText('Adjust the splits so they add up to the transaction amount.'),
    ).toBeInTheDocument();
    expect(patches).toHaveLength(0);
  });

  it('turning splits off on a previously split row sends splits: null plus the chosen category', async () => {
    const { patches } = stubFetch();
    renderModal(splitTransaction);

    // Splits initialize active from transaction.splits.
    await screen.findByRole('button', { name: 'Remove split — use one category' });
    expect(screen.getByLabelText('Category')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove split — use one category' }));
    const select = (await screen.findByLabelText('Category')) as HTMLSelectElement;
    expect(select).not.toBeDisabled();
    fireEvent.change(select, { target: { value: 'c1' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]!.splits).toBeNull();
    expect(patches[0]!.categoryId).toBe('c1');
  });

  it('blocks save with a Category field error when un-splitting without picking a category', async () => {
    const { patches } = stubFetch();
    renderModal(splitTransaction);

    await screen.findByRole('button', { name: 'Remove split — use one category' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove split — use one category' }));
    const select = (await screen.findByLabelText('Category')) as HTMLSelectElement;
    expect(select).not.toBeDisabled();
    // Left on "Keep current category" — the parent's categoryId is actually
    // null (splits were the categorization), so this would silently save as
    // Uncategorized without the guard.
    expect(select.value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByText('Pick a category for the un-split transaction.'),
    ).toBeInTheDocument();
    expect(patches).toHaveLength(0);

    // Picking a category clears the error and lets save proceed.
    fireEvent.change(select, { target: { value: 'c1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]!.splits).toBeNull();
    expect(patches[0]!.categoryId).toBe('c1');
  });
});
