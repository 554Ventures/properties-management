// Money ledger attachment indicator: a row whose transaction carries a
// documentCount shows the paperclip + count with sr-only "attachments" text
// (icon + text, never color/icon alone); rows without documents show nothing.
import type { Transaction } from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui/Toast';
import { Money } from '../pages/Money';

const baseTransaction: Transaction = {
  id: 'tx-plain',
  accountId: 'acc1',
  propertyId: null,
  unitId: null,
  categoryId: null,
  date: '2026-07-02T00:00:00.000Z',
  amountCents: 64000,
  type: 'expense',
  description: 'City utilities',
  vendor: 'City Power & Water',
  source: 'manual',
  status: 'confirmed',
  classification: null,
  aiSuggestedCategoryId: null,
  aiConfidence: null,
  receiptUrl: null,
  createdAt: '2026-07-02T00:00:00.000Z',
  updatedAt: '2026-07-02T00:00:00.000Z',
};

const withDocuments: Transaction = {
  ...baseTransaction,
  id: 'tx-docs',
  description: 'Water heater replacement',
  documentCount: 2,
};

function stubFetch(fixtures: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
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
}

function Providers({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/money']}>
          <main>{children}</main>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Money attachment indicator', () => {
  it('shows the paperclip count with accessible text only on rows that have documents', async () => {
    stubFetch({
      '/api/v1/transactions': { items: [withDocuments, baseTransaction], nextCursor: null, total: 2 },
      '/api/v1/transactions/review': { items: [], nextCursor: null, total: 0 },
      '/api/v1/categories': [],
      '/api/v1/properties': [],
      '/api/v1/integrations': [],
      '/api/v1/insights': [],
    });
    render(
      <Providers>
        <Routes>
          <Route path="/money" element={<Money />} />
        </Routes>
      </Providers>,
    );

    const docRow = (await screen.findByText('Water heater replacement')).closest('tr')!;
    expect(within(docRow).getByText('· 2')).toBeInTheDocument();
    expect(within(docRow).getByText('attachments')).toBeInTheDocument();

    const plainRow = screen.getByText('City utilities').closest('tr')!;
    expect(within(plainRow).queryByText(/attachment/)).not.toBeInTheDocument();
  });
});
