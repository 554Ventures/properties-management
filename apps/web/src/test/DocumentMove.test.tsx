// "Move to…" row action on the Documents page: the modal offers Transaction/
// Property/Tenant targets; picking a transaction via search and confirming
// PATCHes /documents/:id with { entityType, entityId } (mirrors the fetch-
// stubbing pattern in Documents.test.tsx).
import type {
  DocumentListResponse,
  PropertyWithStats,
  Transaction,
  TransactionListResponse,
  TenantListRow,
} from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, ToastViewport } from '../components/ui/Toast';
import { DocumentsPage } from '../pages/DocumentsPage';

const documentsResponse: DocumentListResponse = {
  documents: [
    {
      id: 'd1',
      accountId: 'acc1',
      entityType: 'lease',
      entityId: 'l1',
      type: 'lease',
      name: 'Signed lease 2026.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 245760,
      createdAt: '2026-06-01T00:00:00.000Z',
      entityLabel: 'Unit A · 12 Maple St',
      propertyId: 'p1',
      tenantId: null,
    },
  ],
  total: 1,
};

const properties: PropertyWithStats[] = [
  {
    id: 'p1',
    accountId: 'acc1',
    nickname: null,
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

const tenants: TenantListRow[] = [
  {
    id: 't1',
    fullName: 'J. Rivera',
    email: null,
    phone: null,
    unitId: 'u1',
    unitLabel: 'Unit A',
    propertyId: 'p1',
    propertyLabel: '12 Maple St',
    rentCents: 125000,
    leaseEndDate: '2026-12-31T00:00:00.000Z',
    status: 'current',
  },
];

function transaction(overrides: Partial<Transaction> & Pick<Transaction, 'id'>): Transaction {
  return {
    accountId: 'acc1',
    propertyId: 'p1',
    unitId: null,
    categoryId: 'c1',
    date: '2026-07-01T00:00:00.000Z',
    amountCents: 10000,
    type: 'expense',
    description: 'Transaction',
    vendor: null,
    source: 'manual',
    status: 'confirmed',
    classification: null,
    aiSuggestedCategoryId: null,
    aiConfidence: null,
    receiptUrl: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const allTransactions: Transaction[] = [
  transaction({
    id: 'txn-rent',
    description: 'July rent',
    vendor: null,
    type: 'income',
    amountCents: 125000,
    date: '2026-07-01T00:00:00.000Z',
  }),
  transaction({
    id: 'txn-roof',
    description: 'Roof repair',
    vendor: 'Ace Roofing',
    type: 'expense',
    amountCents: 45000,
    date: '2026-07-20T00:00:00.000Z',
  }),
];

/** PATCH capture + a live transactions search filtered by `q` (description or
 *  vendor), mirroring the server's documented search behavior. */
function stubFetch() {
  const patches: Array<{ path: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://example.test');
      const path = url.pathname;

      if (path === '/api/v1/documents/d1' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patches.push({ path, body });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ...documentsResponse.documents[0],
              entityType: body.entityType,
              entityId: body.entityId,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }

      if (path === '/api/v1/transactions') {
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const items = q
          ? allTransactions.filter(
              (t) =>
                t.description.toLowerCase().includes(q) ||
                (t.vendor ?? '').toLowerCase().includes(q),
            )
          : allTransactions;
        const response: TransactionListResponse = { items, nextCursor: null, total: items.length };
        return Promise.resolve(
          new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }

      const fixtures: Record<string, unknown> = {
        '/api/v1/documents': documentsResponse,
        '/api/v1/properties': properties,
        '/api/v1/tenants': tenants,
      };
      const body = fixtures[path];
      return Promise.resolve(
        new Response(
          JSON.stringify(body ?? { error: { code: 'not_found', message: `No fixture for ${path}` } }),
          { status: body === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }),
  );
  return patches;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/documents']}>
          <Routes>
            <Route
              path="/documents"
              element={
                <main>
                  <DocumentsPage />
                </main>
              }
            />
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

// jsdom reports every media query as non-matching (see test/setup.ts), so
// RowActions renders its mobile "⋯" sheet rather than inline buttons — open
// that first, then choose "Move to…" from it.
async function openMoveModal() {
  await screen.findByRole('button', { name: 'Signed lease 2026.pdf (download)' });
  fireEvent.click(
    screen.getByRole('button', { name: 'Actions for Signed lease 2026.pdf' }),
  );
  const sheet = await screen.findByRole('dialog', { name: 'Actions for Signed lease 2026.pdf' });
  fireEvent.click(within(sheet).getByRole('button', { name: 'Move to…' }));
  return screen.findByRole('dialog', { name: 'Move document' });
}

describe('Move document modal', () => {
  it('moves a document to a transaction picked via search', async () => {
    const patches = stubFetch();
    renderPage();
    const dialog = await openMoveModal();
    const modal = within(dialog);

    // Defaults to Property (the doc's current entityType, 'lease', falls back
    // to Property); switching to Transaction reveals the search + radio list.
    expect(modal.getByRole('radio', { name: 'Property' })).toBeChecked();
    fireEvent.click(modal.getByRole('radio', { name: 'Transaction' }));

    // Before typing, the default (most-recent) list is shown.
    await modal.findByRole('radio', { name: /July rent/ });
    expect(modal.getByRole('radio', { name: /Roof repair/ })).toBeInTheDocument();

    fireEvent.change(modal.getByLabelText('Search transactions'), {
      target: { value: 'roof' },
    });

    await waitFor(() =>
      expect(modal.queryByRole('radio', { name: /July rent/ })).not.toBeInTheDocument(),
    );
    const roofOption = await modal.findByRole('radio', { name: /Roof repair/ });
    fireEvent.click(roofOption);

    fireEvent.click(modal.getByRole('button', { name: 'Move' }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      path: '/api/v1/documents/d1',
      body: { entityType: 'transaction', entityId: 'txn-roof' },
    });

    expect(
      await screen.findByText('Signed lease 2026.pdf moved to a different transaction.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Move document' })).not.toBeInTheDocument();
  });

  it('requires choosing a transaction before confirming', async () => {
    stubFetch();
    renderPage();
    const dialog = await openMoveModal();
    const modal = within(dialog);

    fireEvent.click(modal.getByRole('radio', { name: 'Transaction' }));
    await modal.findByRole('radio', { name: /July rent/ });
    fireEvent.click(modal.getByRole('button', { name: 'Move' }));

    expect(
      await modal.findByText('Choose a transaction to move this document to.'),
    ).toBeInTheDocument();
  });

  it('open move modal has no axe violations', async () => {
    stubFetch();
    renderPage();
    const dialog = await openMoveModal();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Transaction' }));
    await within(dialog).findByRole('radio', { name: /July rent/ });

    const results = await axe.run(dialog, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  }, 20_000);
});
