// DocumentsPage: rows render from a mocked GET /documents response, the upload
// modal opens with labeled fields, and both the page and the open modal pass
// axe (merge-blocking a11y bar per ARCHITECTURE §8).
import type { DocumentListResponse, PropertyWithStats, TenantListRow } from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui/Toast';
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
    {
      id: 'd2',
      accountId: 'acc1',
      entityType: 'tenant',
      entityId: 't1',
      type: 'insurance',
      name: 'Renters insurance.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 98304,
      createdAt: '2026-07-01T00:00:00.000Z',
      entityLabel: 'J. Rivera',
      propertyId: null,
      tenantId: 't1',
    },
  ],
  total: 2,
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

const fixtures: Record<string, unknown> = {
  '/api/v1/documents': documentsResponse,
  '/api/v1/properties': properties,
  '/api/v1/tenants': tenants,
};

function fixtureFetch(input: RequestInfo | URL): Promise<Response> {
  const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
  const body = fixtures[path];
  return Promise.resolve(
    new Response(
      JSON.stringify(body ?? { error: { code: 'not_found', message: `No fixture for ${path}` } }),
      {
        status: body === undefined ? 404 : 200,
        headers: { 'Content-Type': 'application/json' },
      },
    ),
  );
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/documents']}>
          <Routes>
            {/* Pages render inside AppShell's <main> in the app; mirroring that
                here keeps PageHeader's <header> out of the banner landmark. */}
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
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DocumentsPage', () => {
  it('renders document rows from the list response', async () => {
    vi.stubGlobal('fetch', vi.fn(fixtureFetch));
    renderPage();

    // Name cells are fetch-based download buttons (an anchor can't carry the
    // bearer token, so downloads go through downloadFile).
    const lease = await screen.findByRole('button', { name: 'Signed lease 2026.pdf (download)' });
    expect(lease).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Renters insurance.pdf (download)' }),
    ).toBeInTheDocument();

    // Linked-to cells route by entity: tenant docs → tenant page, others → property.
    expect(screen.getByRole('link', { name: 'Unit A · 12 Maple St' })).toHaveAttribute(
      'href',
      '/properties/p1',
    );
    expect(screen.getByRole('link', { name: 'J. Rivera' })).toHaveAttribute('href', '/tenants/t1');

    // Type label and human-readable size render as text in the row.
    const row = screen
      .getByRole('button', { name: 'Renters insurance.pdf (download)' })
      .closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('Insurance')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('96 KB')).toBeInTheDocument();
    expect(screen.getByText('240 KB')).toBeInTheDocument();
  });

  it('opens the upload modal with labeled fields (target picker mode)', async () => {
    vi.stubGlobal('fetch', vi.fn(fixtureFetch));
    renderPage();
    await screen.findByRole('button', { name: 'Signed lease 2026.pdf (download)' });

    fireEvent.click(screen.getByRole('button', { name: 'Upload document' }));
    const dialog = await screen.findByRole('dialog', { name: 'Upload document' });
    expect(dialog).toBeInTheDocument();

    // File input is labeled and required; picker + type + name fields are labeled.
    const modal = within(dialog);
    expect(modal.getByLabelText(/^File/)).toBeInTheDocument();
    expect(modal.getByRole('radio', { name: 'Property' })).toBeChecked();
    expect(modal.getByRole('radio', { name: 'Tenant' })).not.toBeChecked();
    expect(modal.getByRole('combobox', { name: /^Property/ })).toBeInTheDocument();
    expect(modal.getByRole('combobox', { name: /^Document type/ })).toBeInTheDocument();
    expect(modal.getByLabelText(/^Name/)).toBeInTheDocument();

    // Submitting without a file shows a visible error.
    fireEvent.click(modal.getByRole('button', { name: 'Upload' }));
    expect(await modal.findByText('Choose a file to upload.')).toBeInTheDocument();
  });

  it('page has no axe violations', async () => {
    vi.stubGlobal('fetch', vi.fn(fixtureFetch));
    const { container } = renderPage();
    await screen.findByRole('button', { name: 'Signed lease 2026.pdf (download)' });

    const results = await axe.run(container, {
      rules: {
        // jsdom does not lay out or paint — color-contrast can't be computed.
        'color-contrast': { enabled: false },
      },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  }, 20_000);

  it('open upload modal has no axe violations', async () => {
    vi.stubGlobal('fetch', vi.fn(fixtureFetch));
    renderPage();
    await screen.findByRole('button', { name: 'Signed lease 2026.pdf (download)' });

    fireEvent.click(screen.getByRole('button', { name: 'Upload document' }));
    const dialog = await screen.findByRole('dialog', { name: 'Upload document' });

    const results = await axe.run(dialog, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  }, 20_000);
});
