// Privacy Policy / ToS consent capture (docs/SECURITY_PRIVACY_AUDIT.md §B5).
// Bump this when the policy documents change materially — it's recorded
// server-side alongside the acceptance timestamp so there's a record of
// *which* version a user agreed to.
export const CURRENT_POLICY_VERSION = '2026-07-11';

const PENDING_CONSENT_KEY = 'hearth_pending_policy_consent_version';

// In-memory fallback for environments where localStorage throws or is
// unavailable (private browsing, some test environments, strict privacy
// modes) — best-effort only: it won't survive a real page reload, but the
// common case (signUp() returns a session immediately) never needs to.
let memoryFallback: string | null = null;

function getStorage(): Storage | null {
  try {
    // Accessing the getter itself can throw (e.g. jsdom's opaque-origin
    // SecurityError) even before any method call — the check has to happen
    // inside the try.
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

// Supabase can require email confirmation before a session exists, and
// OAuth is a full-page redirect — in both cases there's no authenticated
// request available at the moment the user checks the box and submits.
// Stash the version and record it server-side as soon as a session actually
// appears (AuthProvider calls recordPendingConsentIfAny on every session
// change), then clear it so it's only ever recorded once.
export function markConsentPending(version: string = CURRENT_POLICY_VERSION): void {
  const storage = getStorage();
  if (!storage) {
    memoryFallback = version;
    return;
  }
  try {
    storage.setItem(PENDING_CONSENT_KEY, version);
  } catch {
    memoryFallback = version;
  }
}

export function peekPendingConsentVersion(): string | null {
  const storage = getStorage();
  if (!storage) return memoryFallback;
  try {
    return storage.getItem(PENDING_CONSENT_KEY) ?? memoryFallback;
  } catch {
    return memoryFallback;
  }
}

/** Only cleared after the server call actually succeeds, so a network
 *  failure retries on the next session change / page load rather than
 *  silently losing the consent record. */
export function clearPendingConsentVersion(): void {
  memoryFallback = null;
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(PENDING_CONSENT_KEY);
  } catch {
    // Ignore — nothing to clean up if storage isn't available.
  }
}

/** Test-only: clears both the storage key and the in-memory fallback so
 *  tests don't leak state into each other. */
export function resetConsentStateForTests(): void {
  clearPendingConsentVersion();
}
