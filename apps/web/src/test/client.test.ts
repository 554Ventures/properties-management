// Unit tests for the single fetch wrapper: error envelope → ApiClientError.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiClientError, toQuery } from '../api/client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('api client', () => {
  it('throws ApiClientError with the contract error shape on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: 'validation_error',
              message: 'Amount is required',
              fields: { amountCents: 'Required' },
            },
          },
          400,
        ),
      ),
    );

    const error = await api.get('/transactions').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    const apiError = error as ApiClientError;
    expect(apiError.status).toBe(400);
    expect(apiError.code).toBe('validation_error');
    expect(apiError.message).toBe('Amount is required');
    expect(apiError.fields).toEqual({ amountCents: 'Required' });
  });

  it('falls back to a generic error when the body is not the envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gateway exploded', { status: 502 })),
    );

    const error = await api.get('/healthz').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    const apiError = error as ApiClientError;
    expect(apiError.status).toBe(502);
    expect(apiError.code).toBe('unknown_error');
    expect(apiError.message).toContain('502');
  });

  it('returns parsed JSON on success and undefined on 204', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.get<{ ok: boolean }>('/healthz')).resolves.toEqual({ ok: true });
    await expect(api.delete('/properties/p1')).resolves.toBeUndefined();

    // Everything is routed under the versioned base path.
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/healthz');
  });

  it('sends JSON bodies with the right content type', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ id: 't1' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.post('/transactions', { amountCents: 100 });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ amountCents: 100 }));
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
  });

  it('attaches Authorization when VITE_DEV_BEARER_TOKEN is set (and omits it otherwise)', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ ok: true }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.get('/healthz');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBeNull();

    vi.stubEnv('VITE_DEV_BEARER_TOKEN', 'dev-token');
    await api.get('/healthz');
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer dev-token',
    );
  });
});

describe('toQuery', () => {
  it('skips undefined and empty values', () => {
    expect(toQuery({ months: 6, propertyId: undefined, type: '' })).toBe('?months=6');
    expect(toQuery({})).toBe('');
  });
});
