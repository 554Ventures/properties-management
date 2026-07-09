// Single typed fetch wrapper — every API call in the app flows through here.
// Base path per ARCHITECTURE §3; errors follow the `{ error: { code, message,
// fields? } }` envelope (ApiErrorSchema in @hearth/shared).
import type { ApiError } from '@hearth/shared';
import { getAccessToken } from '../lib/supabase';

const BASE_URL = '/api/v1';

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;

  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  // Supabase session token in auth mode, VITE_DEV_BEARER_TOKEN in demo mode
  // (lib/supabase.ts). Read per request so refreshed sessions are picked up.
  const token = await getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body !== undefined && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  } catch {
    throw new ApiClientError(
      0,
      'network_error',
      'Could not reach the 554 Properties API. Check your connection and try again.',
    );
  }

  if (!res.ok) {
    let code = 'unknown_error';
    let message = `Request failed (${res.status})`;
    let fields: Record<string, string> | undefined;
    try {
      const body = (await res.json()) as Partial<ApiError>;
      if (body && typeof body === 'object' && body.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
        fields = body.error.fields;
      }
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new ApiClientError(res.status, code, message, fields);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  postForm: <T>(path: string, form: FormData) =>
    request<T>(path, { method: 'POST', body: form }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (path: string) => request<void>(path, { method: 'DELETE' }),
};

/** URL for direct-download endpoints (report CSV/PDF exports). */
export function apiUrl(path: string): string {
  return `${BASE_URL}${path}`;
}

/** Filename from a content-disposition header: RFC 5987 filename*= wins. */
function filenameFromDisposition(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (utf8 !== undefined) {
    try {
      return decodeURIComponent(utf8);
    } catch {
      // Malformed encoding — fall through to the plain filename.
    }
  }
  return /filename="([^"]*)"/i.exec(disposition)?.[1] || undefined;
}

/**
 * Downloads a file endpoint with the auth header attached — plain `<a href>`
 * anchors can't carry the bearer token, so they 401 in Supabase auth mode.
 * Fetches the bytes, then hands them to the browser as a named download.
 */
export async function downloadFile(path: string, fallbackName = 'download'): Promise<void> {
  const headers = new Headers({ Accept: '*/*' });
  const token = await getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, { headers });
  } catch {
    throw new ApiClientError(
      0,
      'network_error',
      'Could not reach the 554 Properties API. Check your connection and try again.',
    );
  }
  if (!res.ok) {
    let code = 'unknown_error';
    let message = `Download failed (${res.status})`;
    try {
      const body = (await res.json()) as Partial<ApiError>;
      if (body?.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
      }
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new ApiClientError(res.status, code, message);
  }

  const blob = await res.blob();
  const name = filenameFromDisposition(res.headers.get('content-disposition')) ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Builds a query string, skipping undefined/empty values. */
export function toQuery(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') q.set(key, String(value));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}
