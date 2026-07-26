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

/** Fetch stub with a live categories list: POST /categories appends + returns
 *  the created row, so the invalidation-driven refetch sees it. */
function stubFetch() {
  const categories: Category[] = [
    category({ id: 'c1', name: 'Repairs', type: 'expense' }),
    category({ id: 'c2', name: 'Rent', type: 'income' }),
  ];
  const posts: Array<Record<string, unknown>> = [];
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
  return posts;
}

function renderModal() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <TransactionEditModal open onClose={vi.fn()} transaction={transaction} />
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
    const posts = stubFetch();
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
    const posts = stubFetch();
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
