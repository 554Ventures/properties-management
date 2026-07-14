// Interaction tests for the Phase-2 lease flows: co-tenant add/remove (incl. a
// backend guard trip surfacing the server error) and renewal acceptance.
import type {
  Lease,
  LeaseDetailResponse,
  RenewalDraftResponse,
  TenantDetailResponse,
  TenantListRow,
} from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeaseTenantsModal } from '../components/forms/LeaseTenantsModal';
import { ToastProvider, ToastViewport } from '../components/ui/Toast';
import { TenantDetail } from '../pages/TenantDetail';

// --- fixtures --------------------------------------------------------------

const primaryTenant = {
  id: 't1',
  accountId: 'acc1',
  fullName: 'Alex Primary',
  email: null,
  phone: null,
  notes: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  archivedAt: null,
  isPrimary: true,
  shareCents: null,
};

const otherTenantRow: TenantListRow = {
  id: 't2',
  fullName: 'Blair Other',
  email: null,
  phone: null,
  unitId: null,
  unitLabel: null,
  propertyId: null,
  propertyLabel: null,
  rentCents: null,
  leaseEndDate: null,
  status: 'current',
};

const baseLease: Lease = {
  id: 'l1',
  unitId: 'u1',
  rentCents: 125000,
  dueDay: 1,
  startDate: '2025-08-01T12:00:00.000Z',
  endDate: '2026-07-31T12:00:00.000Z',
  status: 'active',
  esignEnvelopeId: null,
  esignStatus: null,
  createdAt: '2025-08-01T12:00:00.000Z',
};

const leaseDetail: LeaseDetailResponse = {
  lease: {
    ...baseLease,
    unitLabel: 'Unit A',
    propertyId: 'p1',
    propertyLabel: '12 Maple St',
    tenants: [primaryTenant],
  },
  rentPayments: [],
};

interface RouteFixture {
  method: string;
  path: string;
  body: unknown;
  status?: number;
}

function makeFetch(routes: RouteFixture[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    const method = (init?.method ?? 'GET').toUpperCase();
    const match = routes.find((r) => r.path === url && r.method === method);
    if (!match) {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: url } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(match.body === undefined ? null : JSON.stringify(match.body), {
      status: match.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function renderWithProviders(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        {ui}
        <ToastViewport />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('co-tenant management', () => {
  it('surfaces the backend guard error when removing the last tenant', async () => {
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/leases/l1', body: leaseDetail },
      { method: 'GET', path: '/api/v1/tenants', body: [otherTenantRow] },
      {
        method: 'DELETE',
        path: '/api/v1/leases/l1/tenants/t1',
        status: 409,
        body: {
          error: { code: 'conflict', message: 'A lease must have at least one tenant.' },
        },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<LeaseTenantsModal open leaseId="l1" onClose={() => {}} />);

    const primaryRow = (await screen.findByText('Alex Primary')).closest('li') as HTMLElement;
    fireEvent.click(within(primaryRow).getByRole('button', { name: 'Remove' }));

    // The server's guard message is surfaced inline (it also appears in the
    // toast, so scope the assertion to the inline alert to stay unambiguous).
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A lease must have at least one tenant.',
    );
  });

  it('adds a co-tenant from the picker', async () => {
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/leases/l1', body: leaseDetail },
      { method: 'GET', path: '/api/v1/tenants', body: [otherTenantRow] },
      { method: 'POST', path: '/api/v1/leases/l1/tenants', body: { ...leaseDetail.lease } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<LeaseTenantsModal open leaseId="l1" onClose={() => {}} />);

    await screen.findByText('Alex Primary');
    fireEvent.change(screen.getByLabelText('Add a tenant'), { target: { value: 't2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u, i]) =>
            String(u) === '/api/v1/leases/l1/tenants' &&
            (i as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true),
    );
    expect(await screen.findByText('Tenant added to the lease.')).toBeInTheDocument();
  });
});

describe('renewal acceptance', () => {
  const tenantDetail: TenantDetailResponse = {
    tenant: primaryTenant,
    leases: [
      {
        ...baseLease,
        unitLabel: 'Unit A',
        propertyId: 'p1',
        propertyLabel: '12 Maple St',
      },
    ],
    paymentHistory: [],
    documents: [],
  };

  const draft: RenewalDraftResponse = {
    leaseId: 'l1',
    currentRentCents: 125000,
    suggestedRentCents: 132000,
    marketRentCents: 135000,
    proposedStartDate: '2026-08-01T12:00:00.000Z',
    proposedEndDate: '2027-07-31T12:00:00.000Z',
    dueDay: 1,
  };

  it('accepts a renewal and posts the accepted terms to /renewal', async () => {
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/tenants/t1', body: tenantDetail },
      { method: 'POST', path: '/api/v1/leases/l1/renewal-draft', body: draft },
      { method: 'POST', path: '/api/v1/leases/l1/renewal', body: { ...baseLease, id: 'l2' } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(
      <MemoryRouter initialEntries={['/tenants/t1']}>
        <Routes>
          <Route path="/tenants/:id" element={<TenantDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Draft renewal' }));
    fireEvent.click(await screen.findByRole('button', { name: /Accept & create renewal/ }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) =>
          String(u) === '/api/v1/leases/l1/renewal' &&
          (i as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeDefined();
      // The editable form round-trips dates through the date inputs, so the
      // accepted terms come back normalized to UTC midnight.
      expect(call?.[1]?.body).toBe(
        JSON.stringify({
          rentCents: 132000,
          dueDay: 1,
          startDate: '2026-08-01T00:00:00.000Z',
          endDate: '2027-07-31T00:00:00.000Z',
        }),
      );
    });
    expect(
      await screen.findByText('Renewal accepted — the new lease is now active.'),
    ).toBeInTheDocument();
  });

  it('renewal terms are editable — accepting posts the adjusted rent and due day', async () => {
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/tenants/t1', body: tenantDetail },
      { method: 'POST', path: '/api/v1/leases/l1/renewal-draft', body: draft },
      { method: 'POST', path: '/api/v1/leases/l1/renewal', body: { ...baseLease, id: 'l2' } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(
      <MemoryRouter initialEntries={['/tenants/t1']}>
        <Routes>
          <Route path="/tenants/:id" element={<TenantDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Draft renewal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Renewal proposal' });
    fireEvent.input(within(dialog).getByLabelText(/Monthly rent/), {
      target: { value: '1350' },
    });
    fireEvent.input(within(dialog).getByLabelText(/Rent due day/), { target: { value: '5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Accept & create renewal/ }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) =>
          String(u) === '/api/v1/leases/l1/renewal' &&
          (i as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeDefined();
      expect(call?.[1]?.body).toBe(
        JSON.stringify({
          rentCents: 135000,
          dueDay: 5,
          startDate: '2026-08-01T00:00:00.000Z',
          endDate: '2027-07-31T00:00:00.000Z',
        }),
      );
    });
  });

  it('accepting with an attached agreement uploads it against the new lease', async () => {
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/tenants/t1', body: tenantDetail },
      { method: 'POST', path: '/api/v1/leases/l1/renewal-draft', body: draft },
      { method: 'POST', path: '/api/v1/leases/l1/renewal', body: { ...baseLease, id: 'l2' } },
      {
        method: 'POST',
        path: '/api/v1/documents',
        body: { id: 'd1', name: 'renewal.pdf' },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(
      <MemoryRouter initialEntries={['/tenants/t1']}>
        <Routes>
          <Route path="/tenants/:id" element={<TenantDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Draft renewal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Renewal proposal' });
    const file = new File(['pdf-bytes'], 'renewal.pdf', { type: 'application/pdf' });
    fireEvent.change(within(dialog).getByLabelText(/Signed agreement/), {
      target: { files: [file] },
    });
    expect(within(dialog).getByText('renewal.pdf', { exact: false })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /Accept & create renewal/ }));

    await waitFor(() => {
      const docCall = fetchMock.mock.calls.find(
        ([u, i]) =>
          String(u) === '/api/v1/documents' && (i as RequestInit | undefined)?.method === 'POST',
      );
      expect(docCall).toBeDefined();
      const body = docCall?.[1]?.body as FormData;
      expect(body.get('entityType')).toBe('lease');
      expect(body.get('entityId')).toBe('l2'); // the NEW lease, not the source
      expect(body.get('type')).toBe('lease');
      expect((body.get('file') as File).name).toBe('renewal.pdf');
    });
    expect(
      await screen.findByText('Renewal accepted — new lease active, agreement attached.'),
    ).toBeInTheDocument();
  });

  it('renewal rejects an invalid edit (zero rent) without posting', async () => {
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/tenants/t1', body: tenantDetail },
      { method: 'POST', path: '/api/v1/leases/l1/renewal-draft', body: draft },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(
      <MemoryRouter initialEntries={['/tenants/t1']}>
        <Routes>
          <Route path="/tenants/:id" element={<TenantDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Draft renewal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Renewal proposal' });
    fireEvent.input(within(dialog).getByLabelText(/Monthly rent/), { target: { value: '0' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Accept & create renewal/ }));

    expect(
      await within(dialog).findByText('Enter a monthly rent greater than zero.'),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([u, i]) =>
          String(u) === '/api/v1/leases/l1/renewal' &&
          (i as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(false);
  });
});
