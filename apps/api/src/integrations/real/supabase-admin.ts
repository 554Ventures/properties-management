// Supabase Auth admin operations (plain fetch — no SDK dependency, mirrors
// real-storage.ts's approach). Used only by account hard-deletion
// (docs/SECURITY_PRIVACY_AUDIT.md §B2) to remove the actual auth identity so
// a deleted account's owner can't simply log back in and get silently
// re-provisioned into a fresh empty account under the same identity.
//
// Best-effort and a no-op when Supabase mode isn't configured (demo mode has
// no real Supabase Auth users to delete) — deleting the local Account/User
// rows must never be blocked by this.

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
