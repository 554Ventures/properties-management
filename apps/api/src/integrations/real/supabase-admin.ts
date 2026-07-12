// Supabase Auth admin operations (plain fetch — no SDK dependency, mirrors
// real-storage.ts's approach). Used by account hard-deletion
// (docs/SECURITY_PRIVACY_AUDIT.md §B2) to remove the actual auth identity, and
// by team invites (docs/WHATS_NEXT.md §4) to send Supabase's built-in
// invitation email.
//
// Best-effort and a no-op when Supabase mode isn't configured (demo mode has
// no real Supabase Auth) — local DB writes must never be blocked by this.

/**
 * Deletes a Supabase Auth user by id. No-ops (returns false) when
 * SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY aren't both configured. Treats a 404
 * (already gone) as success. Throws on any other failure so the caller can
 * decide whether to proceed with local deletion anyway.
 */
export async function deleteSupabaseAuthUser(supabaseUserId: string): Promise<boolean> {
  const baseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceRoleKey) return false;

  const url = `${baseUrl.replace(/\/$/, '')}/auth/v1/admin/users/${encodeURIComponent(supabaseUserId)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `[supabase-admin] failed to delete auth user ${supabaseUserId}: ${res.status} ${await res.text()}`,
    );
  }
  return true;
}

export type InviteEmailResult =
  | 'sent' // Supabase accepted the invite and emailed the address
  | 'skipped' // Supabase admin not configured (demo/dev) — no email attempted
  | 'already_registered'; // the address already has a Supabase user; they just log in

/**
 * Sends Supabase's built-in invitation email (`POST /auth/v1/invite`) so a
 * teammate gets a magic link instead of having to be told out-of-band to sign
 * up. No-ops (returns 'skipped') when SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
 * aren't both set. An already-registered address is not an error — the pending
 * Invite row still matches when they log in, so we report it and move on. The
 * redirect target defaults to the project's dashboard Site URL; override with
 * SUPABASE_INVITE_REDIRECT_URL. Throws on any other failure so the caller can
 * log it (invites stay valid regardless — joining is driven by the DB row).
 */
export async function inviteSupabaseUserByEmail(email: string): Promise<InviteEmailResult> {
  const baseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceRoleKey) return 'skipped';

  const redirectTo = process.env.SUPABASE_INVITE_REDIRECT_URL;
  const url =
    `${baseUrl.replace(/\/$/, '')}/auth/v1/invite` +
    (redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email }),
  });
  if (res.ok) return 'sent';
  const text = await res.text();
  // 422 with an "already registered" / email_exists body → they have an account.
  if (res.status === 422 && /registered|exists/i.test(text)) return 'already_registered';
  throw new Error(`[supabase-admin] invite email failed for ${email}: ${res.status} ${text}`);
}
