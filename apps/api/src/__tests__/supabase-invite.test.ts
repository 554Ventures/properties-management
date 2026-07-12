// inviteSupabaseUserByEmail (docs/WHATS_NEXT.md §4): sends Supabase's built-in
// invitation email via the Admin REST API, best-effort. No network in the
// suite — fetch is stubbed. Verifies the configured/unconfigured/already-
// registered branches and that it targets the /auth/v1/invite endpoint with
// the service-role credentials.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inviteSupabaseUserByEmail } from '../integrations/real/supabase-admin';

const fetchSpy = vi.fn();

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
  process.env.SUPABASE_URL = 'https://proj.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_INVITE_REDIRECT_URL;
});

describe('inviteSupabaseUserByEmail', () => {
  it('posts to /auth/v1/invite with service-role credentials and returns "sent" on 200', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ id: 'u1' }), { status: 200 }));

    const result = await inviteSupabaseUserByEmail('teammate@example.com');

    expect(result).toBe('sent');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://proj.supabase.co/auth/v1/invite');
    expect(init.method).toBe('POST');
    expect(init.headers.apikey).toBe('service-role-key');
    expect(init.headers.Authorization).toBe('Bearer service-role-key');
    expect(JSON.parse(init.body)).toEqual({ email: 'teammate@example.com' });
  });

  it('appends redirect_to when SUPABASE_INVITE_REDIRECT_URL is set', async () => {
    process.env.SUPABASE_INVITE_REDIRECT_URL = 'https://app.554properties.com';
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));

    await inviteSupabaseUserByEmail('teammate@example.com');

    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://proj.supabase.co/auth/v1/invite?redirect_to=https%3A%2F%2Fapp.554properties.com',
    );
  });

  it('treats an already-registered address (422) as non-fatal', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ msg: 'A user with this email address has already been registered' }), {
        status: 422,
      }),
    );

    const result = await inviteSupabaseUserByEmail('existing@example.com');
    expect(result).toBe('already_registered');
  });

  it('skips silently (no fetch) when Supabase admin is unconfigured — demo mode', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const result = await inviteSupabaseUserByEmail('teammate@example.com');
    expect(result).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws on an unexpected failure so the caller can log it', async () => {
    fetchSpy.mockResolvedValue(new Response('boom', { status: 500 }));

    await expect(inviteSupabaseUserByEmail('teammate@example.com')).rejects.toThrow(/invite email failed/);
  });
});
