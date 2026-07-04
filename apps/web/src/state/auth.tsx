// Auth session state (deployment plan §4.1). In demo mode (no Supabase env)
// this is inert: session stays null, `enabled` is false, and AuthGate renders
// the app directly — the offline demo and the test suite never see a login
// screen. In auth mode, AuthGate holds the app behind Login until supabase-js
// reports a session.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { authEnabled, supabase } from '../lib/supabase';
import { Login } from '../pages/Login';

interface AuthContextValue {
  /** False in demo mode — no login flow exists. */
  enabled: boolean;
  session: Session | null;
  /** True while the initial getSession() is in flight (auth mode only). */
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  enabled: false,
  session: null,
  loading: false,
  signOut: async () => {},
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(authEnabled);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      enabled: authEnabled,
      session,
      loading,
      signOut: async () => {
        await supabase?.auth.signOut();
      },
    }),
    [session, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { enabled, session, loading } = useAuth();
  if (!enabled) return <>{children}</>;
  if (loading) return null; // brief; avoids a login flash while the stored session loads
  if (!session) return <Login />;
  return <>{children}</>;
}
