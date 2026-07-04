// Supabase Auth client (deployment plan §4.1). Auth mode is on only when both
// VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set at build time;
// otherwise the app runs in demo mode — no login screen, optional
// VITE_DEV_BEARER_TOKEN. The anon key is public by design: it only grants the
// auth flow, and every data request still goes through the 554 Properties API.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const supabase: SupabaseClient | null = (() => {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !anonKey) return null;
  return createClient(url, anonKey);
})();

export const authEnabled = supabase !== null;

/**
 * Bearer token for API calls: the Supabase session token in auth mode
 * (supabase-js caches and auto-refreshes it), else the dev token if set.
 */
export async function getAccessToken(): Promise<string | undefined> {
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? undefined;
  }
  return import.meta.env.VITE_DEV_BEARER_TOKEN as string | undefined;
}
