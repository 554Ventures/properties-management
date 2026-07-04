// Unit tests for the Phase-2 CRUD mutation hooks: assert HTTP method + path +
// body and which query keys each success invalidates. Fetch is stubbed; a
// shared QueryClient is spied on for invalidation assertions.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  useAddLeaseTenant,
  useArchiveProperty,
  useArchiveTenant,
  useArchiveUnit,
  useCreateLease,
  useCreateRenewal,
  useCreateTenant,
  useCreateUnit,
  useRemoveLeaseTenant,
  useRestoreProperty,
  useRestoreUnit,
  useTerminateLease,
  useUpdateLease,
  useUpdateProperty,
  useUpdateTenant,
  useUpdateUnit,
} from '../api/queries';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Stubs global fetch with a two-arg mock so mock.calls carry [url, init]. */
function stubFetch(makeResponse: () => Response) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => makeResponse());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const keys: string[] = [];
  vi.spyOn(qc, 'invalidateQueries').mockImplementation((filters) => {
    keys.push(JSON.stringify((filters as { queryKey?: unknown } | undefined)?.queryKey));
    return Promise.resolve();
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, keys, wrapper };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('property mutations', () => {
  it('useUpdateProperty PATCHes and invalidates properties + detail + dashboard', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: 'p1' }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useUpdateProperty(), { wrapper });
    result.current.mutate({ id: 'p1', nickname: 'New name' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/properties/p1');
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ nickname: 'New name' }));

    expect(keys).toContain(JSON.stringify(['properties']));
    expect(keys).toContain(JSON.stringify(['properties', 'p1']));
    expect(keys).toContain(JSON.stringify(['dashboard']));
  });

  it('useArchiveProperty DELETEs the property', async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 204 }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useArchiveProperty(), { wrapper });
    result.current.mutate('p1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/properties/p1');
    expect(init?.method).toBe('DELETE');
    expect(keys).toContain(JSON.stringify(['properties', 'p1']));
  });

  it('useRestoreProperty POSTs to /restore', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: 'p1' }));
    const { wrapper } = setup();

    const { result } = renderHook(() => useRestoreProperty(), { wrapper });
    result.current.mutate('p1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/properties/p1/restore');
    expect(init?.method).toBe('POST');
  });
});

describe('unit mutations', () => {
  it('useCreateUnit POSTs to the property units path and strips propertyId from the body', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: 'u1' }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useCreateUnit(), { wrapper });
    result.current.mutate({ propertyId: 'p1', label: 'Unit A' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/properties/p1/units');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ label: 'Unit A' }));
    expect(keys).toContain(JSON.stringify(['properties', 'p1']));
  });

  it('useUpdateUnit PATCHes /units/:id (propertyId only used for invalidation)', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: 'u1' }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useUpdateUnit(), { wrapper });
    result.current.mutate({ id: 'u1', propertyId: 'p1', label: 'Unit B' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/units/u1');
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ label: 'Unit B' }));
    expect(keys).toContain(JSON.stringify(['properties', 'p1']));
  });

  it('useArchiveUnit / useRestoreUnit hit the right paths', async () => {
    const archiveFetch = stubFetch(() => new Response(null, { status: 204 }));
    const a = setup();
    const { result: archive } = renderHook(() => useArchiveUnit(), { wrapper: a.wrapper });
    archive.current.mutate({ id: 'u1', propertyId: 'p1' });
    await waitFor(() => expect(archive.current.isSuccess).toBe(true));
    expect(archiveFetch.mock.calls[0]![0]).toBe('/api/v1/units/u1');
    expect(archiveFetch.mock.calls[0]![1]?.method).toBe('DELETE');

    const restoreFetch = stubFetch(() => jsonResponse({ id: 'u1' }));
    const r = setup();
    const { result: restore } = renderHook(() => useRestoreUnit(), { wrapper: r.wrapper });
    restore.current.mutate({ id: 'u1', propertyId: 'p1' });
    await waitFor(() => expect(restore.current.isSuccess).toBe(true));
    expect(restoreFetch.mock.calls[0]![0]).toBe('/api/v1/units/u1/restore');
    expect(restoreFetch.mock.calls[0]![1]?.method).toBe('POST');
  });
});

describe('tenant mutations', () => {
  it('useCreateTenant POSTs /tenants and invalidates tenants', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: 't1' }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useCreateTenant(), { wrapper });
    result.current.mutate({ fullName: 'Jamie Rivera' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/tenants');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ fullName: 'Jamie Rivera' }));
    expect(keys).toContain(JSON.stringify(['tenants']));
  });

  it('useUpdateTenant PATCHes /tenants/:id and invalidates the detail key', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: 't1' }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useUpdateTenant(), { wrapper });
    result.current.mutate({ id: 't1', phone: '555-0100' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/tenants/t1');
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('PATCH');
    expect(keys).toContain(JSON.stringify(['tenants', 't1']));
  });

  it('useArchiveTenant DELETEs /tenants/:id', async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 204 }));
    const { wrapper } = setup();

    const { result } = renderHook(() => useArchiveTenant(), { wrapper });
    result.current.mutate('t1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/tenants/t1');
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('DELETE');
  });
});

describe('lease mutations', () => {
  it('useCreateLease POSTs /leases and invalidates properties/tenants/rent/dashboard', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: 'l1' }));
    const { keys, wrapper } = setup();

    const input = {
      unitId: 'u1',
      tenantIds: ['t1'],
      rentCents: 125000,
      dueDay: 1,
      startDate: '2026-08-01T12:00:00.000Z',
      endDate: '2027-07-31T12:00:00.000Z',
    };
    const { result } = renderHook(() => useCreateLease(), { wrapper });
    result.current.mutate(input);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/leases');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify(input));
    expect(keys).toEqual(
      expect.arrayContaining([
        JSON.stringify(['properties']),
        JSON.stringify(['tenants']),
        JSON.stringify(['rent']),
        JSON.stringify(['dashboard']),
      ]),
    );
  });

  it('useUpdateLease PATCHes /leases/:id and invalidates the lease detail key', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: 'l1' }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useUpdateLease(), { wrapper });
    result.current.mutate({ id: 'l1', rentCents: 130000 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/leases/l1');
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('PATCH');
    expect(fetchMock.mock.calls[0]![1]?.body).toBe(JSON.stringify({ rentCents: 130000 }));
    expect(keys).toContain(JSON.stringify(['leases', 'l1']));
  });

  it('useTerminateLease POSTs /leases/:id/terminate', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: 'l1' }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useTerminateLease(), { wrapper });
    result.current.mutate('l1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/leases/l1/terminate');
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('POST');
    expect(keys).toContain(JSON.stringify(['leases', 'l1']));
  });

  it('useAddLeaseTenant POSTs /leases/:id/tenants with the tenant body', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: 'l1' }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useAddLeaseTenant(), { wrapper });
    result.current.mutate({ leaseId: 'l1', tenantId: 't2' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/leases/l1/tenants');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ tenantId: 't2' }));
    expect(keys).toContain(JSON.stringify(['leases', 'l1']));
  });

  it('useRemoveLeaseTenant DELETEs /leases/:id/tenants/:tenantId', async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 204 }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useRemoveLeaseTenant(), { wrapper });
    result.current.mutate({ leaseId: 'l1', tenantId: 't2' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/leases/l1/tenants/t2');
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('DELETE');
    expect(keys).toContain(JSON.stringify(['leases', 'l1']));
  });

  it('useCreateRenewal POSTs /leases/:id/renewal with the accepted terms', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: 'l2' }));
    const { keys, wrapper } = setup();

    const terms = {
      leaseId: 'l1',
      rentCents: 132000,
      dueDay: 1,
      startDate: '2027-08-01T12:00:00.000Z',
      endDate: '2028-07-31T12:00:00.000Z',
    };
    const { result } = renderHook(() => useCreateRenewal(), { wrapper });
    result.current.mutate(terms);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/leases/l1/renewal');
    expect(init?.method).toBe('POST');
    const { leaseId: _leaseId, ...body } = terms;
    expect(init?.body).toBe(JSON.stringify(body));
    expect(keys).toContain(JSON.stringify(['leases', 'l1']));
  });
});
