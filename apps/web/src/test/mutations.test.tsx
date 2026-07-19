// Unit tests for the Phase-2 CRUD mutation hooks: assert HTTP method + path +
// body and which query keys each success invalidates. Fetch is stubbed; a
// shared QueryClient is spied on for invalidation assertions.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  useAcceptBankDiscrepancy,
  useAddLeaseTenant,
  useApplyLateFee,
  useArchiveProperty,
  useArchiveTenant,
  useArchiveUnit,
  useConfirmAllReview,
  useConfirmTransaction,
  useCreateLease,
  useCreateRenewal,
  useCreateTenant,
  useCreateTransaction,
  useCreateUnit,
  useDeleteTransaction,
  useDismissAllReview,
  useDismissBankDiscrepancy,
  useDismissTransaction,
  useImportTransactions,
  useRestoreTransaction,
  useRecordPayment,
  useRemoveLeaseTenant,
  useRestoreProperty,
  useRestoreUnit,
  useSendReminders,
  useSubmitFeedback,
  useTerminateLease,
  useUnlinkDeposit,
  useUpdateLease,
  useUpdateProperty,
  useUpdateTenant,
  useUpdateTransaction,
  useUpdateUnit,
  useWaiveLateFee,
} from '../api/queries';

/** invalidateFinancials' full key set — every money mutation must sweep all of these
 *  (transactions/dashboard/properties/onboarding stay from the old invalidateLedger;
 *  rent/tenants/insights/units are new so those caches don't go stale after a write). */
const FINANCIAL_KEYS = [
  JSON.stringify(['transactions']),
  JSON.stringify(['dashboard']),
  JSON.stringify(['properties']),
  JSON.stringify(['onboarding']),
  JSON.stringify(['rent']),
  JSON.stringify(['tenants']),
  JSON.stringify(['insights']),
  JSON.stringify(['units']),
];

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
    expect(keys).toContain(JSON.stringify(['units', 'u1']));
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

describe('transaction mutations', () => {
  it('useCreateTransaction POSTs /transactions and invalidates the full financial key set', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: 'tx1' }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useCreateTransaction(), { wrapper });
    result.current.mutate({
      date: '2026-07-01T12:00:00.000Z',
      amountCents: 5000,
      type: 'expense',
      description: 'Plumbing',
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/transactions');
    expect(init?.method).toBe('POST');
    expect(keys).toEqual(expect.arrayContaining(FINANCIAL_KEYS));
  });

  it('useConfirmTransaction with rentPaymentId POSTs /confirm and invalidates the full financial key set (rent/tenants/insights included)', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: 'tx1' }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useConfirmTransaction(), { wrapper });
    result.current.mutate({ id: 'tx1', rentPaymentId: 'rp1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/transactions/tx1/confirm');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ rentPaymentId: 'rp1' }));
    expect(keys).toEqual(expect.arrayContaining(FINANCIAL_KEYS));
  });

  it('useDismissTransaction POSTs /dismiss and invalidates the full financial key set', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: 'tx1' }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useDismissTransaction(), { wrapper });
    result.current.mutate('tx1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/transactions/tx1/dismiss');
    expect(init?.method).toBe('POST');
    expect(keys).toEqual(expect.arrayContaining(FINANCIAL_KEYS));
  });

  it('useConfirmAllReview POSTs /review/confirm-all and invalidates the full financial key set', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ confirmed: 3, skipped: 1 }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useConfirmAllReview(), { wrapper });
    result.current.mutate({ propertyId: 'p1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/transactions/review/confirm-all');
    expect(init?.method).toBe('POST');
    expect(keys).toEqual(expect.arrayContaining(FINANCIAL_KEYS));
  });

  it('useDismissAllReview POSTs /review/dismiss-all and invalidates the full financial key set', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ dismissed: 2 }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useDismissAllReview(), { wrapper });
    result.current.mutate({});
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/transactions/review/dismiss-all');
    expect(init?.method).toBe('POST');
    expect(keys).toEqual(expect.arrayContaining(FINANCIAL_KEYS));
  });

  it('useUpdateTransaction PATCHes /transactions/:id and invalidates the full financial key set', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: 'tx1' }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useUpdateTransaction(), { wrapper });
    result.current.mutate({ id: 'tx1', propertyId: 'p1', unitId: 'u1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/transactions/tx1');
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ propertyId: 'p1', unitId: 'u1' }));
    expect(keys).toEqual(expect.arrayContaining(FINANCIAL_KEYS));
  });

  it('useDeleteTransaction DELETEs /transactions/:id and invalidates the full financial key set', async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 204 }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useDeleteTransaction(), { wrapper });
    result.current.mutate('tx1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/transactions/tx1');
    expect(init?.method).toBe('DELETE');
    expect(keys).toEqual(expect.arrayContaining(FINANCIAL_KEYS));
  });

  it('useRestoreTransaction POSTs /transactions/:id/restore and invalidates the full financial key set', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: 'tx1', status: 'pending_review' }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useRestoreTransaction(), { wrapper });
    result.current.mutate('tx1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/transactions/tx1/restore');
    expect(init?.method).toBe('POST');
    expect(keys).toEqual(expect.arrayContaining(FINANCIAL_KEYS));
  });

  it('useImportTransactions POSTs /transactions/import and invalidates the full financial key set + integrations', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ imported: 2, skipped: 1, updated: 1, removed: 0 }),
    );
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useImportTransactions(), { wrapper });
    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/transactions/import');
    expect(init?.method).toBe('POST');
    expect(keys).toEqual(
      expect.arrayContaining([...FINANCIAL_KEYS, JSON.stringify(['integrations'])]),
    );
  });

  it('useAcceptBankDiscrepancy POSTs /bank-discrepancies/:id/accept and invalidates the full financial key set', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ id: 'bd1', status: 'accepted', resolvedAt: '2026-07-15T00:00:00.000Z' }),
    );
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useAcceptBankDiscrepancy(), { wrapper });
    result.current.mutate('bd1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/transactions/bank-discrepancies/bd1/accept');
    expect(init?.method).toBe('POST');
    // Sweeps the ['transactions'] prefix, which is where useBankDiscrepancies
    // is keyed (['transactions', 'bank-discrepancies']) so the list refetches.
    expect(keys).toEqual(expect.arrayContaining(FINANCIAL_KEYS));
  });

  it('useDismissBankDiscrepancy POSTs /bank-discrepancies/:id/dismiss and invalidates the full financial key set', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ id: 'bd1', status: 'dismissed', resolvedAt: '2026-07-15T00:00:00.000Z' }),
    );
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useDismissBankDiscrepancy(), { wrapper });
    result.current.mutate('bd1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/transactions/bank-discrepancies/bd1/dismiss');
    expect(init?.method).toBe('POST');
    expect(keys).toEqual(expect.arrayContaining(FINANCIAL_KEYS));
  });
});

describe('feedback mutations', () => {
  it('useSubmitFeedback POSTs /feedback and invalidates nothing (no read UI)', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse(
        {
          id: 'fb1',
          accountId: 'acc1',
          userId: 'u1',
          category: 'bug',
          message: 'The rent chart is blank.',
          pagePath: '/rent',
          userAgent: 'vitest',
          createdAt: '2026-07-18T00:00:00.000Z',
        },
        201,
      ),
    );
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useSubmitFeedback(), { wrapper });
    result.current.mutate({ category: 'bug', message: 'The rent chart is blank.', pagePath: '/rent' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/feedback');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(
      JSON.stringify({ category: 'bug', message: 'The rent chart is blank.', pagePath: '/rent' }),
    );
    expect(keys).toEqual([]);
  });
});

describe('rent mutations', () => {
  it('useRecordPayment POSTs /rent/payments and invalidates the full financial key set', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: 'rp1' }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useRecordPayment(), { wrapper });
    result.current.mutate({
      leaseId: 'l1',
      period: '2026-07',
      amountCents: 125000,
      method: 'manual',
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/rent/payments');
    expect(init?.method).toBe('POST');
    expect(keys).toEqual(expect.arrayContaining(FINANCIAL_KEYS));
  });

  it('useUnlinkDeposit DELETEs the deposit link and invalidates the full financial key set', async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 204 }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useUnlinkDeposit(), { wrapper });
    result.current.mutate({ rentPaymentId: 'rp1', depositId: 'tx1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/rent/payments/rp1/deposits/tx1');
    expect(init?.method).toBe('DELETE');
    expect(keys).toEqual(expect.arrayContaining(FINANCIAL_KEYS));
  });

  it('useSendReminders POSTs /rent/reminders and invalidates the full financial key set', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ results: [] }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useSendReminders(), { wrapper });
    result.current.mutate({ rentPaymentIds: ['rp1'] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/rent/reminders');
    expect(init?.method).toBe('POST');
    expect(keys).toEqual(expect.arrayContaining(FINANCIAL_KEYS));
  });

  it('useApplyLateFee POSTs /rent/payments/:id/late-fee with feeCents omitted and invalidates the full financial key set', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: 'rp1', lateFeeCents: 5000 }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useApplyLateFee(), { wrapper });
    result.current.mutate({ id: 'rp1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/rent/payments/rp1/late-fee');
    expect(init?.method).toBe('POST');
    // feeCents omitted — the server resolves the effective policy.
    expect(init?.body).toBe(JSON.stringify({}));
    expect(keys).toEqual(expect.arrayContaining(FINANCIAL_KEYS));
  });

  it('useApplyLateFee sends an explicit feeCents when provided', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: 'rp1', lateFeeCents: 4200 }));
    const { wrapper } = setup();

    const { result } = renderHook(() => useApplyLateFee(), { wrapper });
    result.current.mutate({ id: 'rp1', feeCents: 4200 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.body).toBe(JSON.stringify({ feeCents: 4200 }));
  });

  it('useWaiveLateFee DELETEs /rent/payments/:id/late-fee and invalidates the full financial key set', async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 204 }));
    const { keys, wrapper } = setup();

    const { result } = renderHook(() => useWaiveLateFee(), { wrapper });
    result.current.mutate('rp1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/rent/payments/rp1/late-fee');
    expect(init?.method).toBe('DELETE');
    expect(keys).toEqual(expect.arrayContaining(FINANCIAL_KEYS));
  });
});
