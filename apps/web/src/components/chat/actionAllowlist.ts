// Allowlist for AI-proposed action_card actions (§9.3 hardening). api_call
// buttons execute an AI-supplied method+path through the normal REST client,
// so in real-AI mode a prompt-injected model could hide an arbitrary write
// (e.g. POST /reports/:id/email {to: attacker}) behind a benign label. Only
// the write routes the assistant legitimately proposes may execute; anything
// else renders as a disabled button with a visible note — never a silent
// drop, and never executed. Deliberately excluded: /reports/:id/email (an
// exfiltration channel), anything under /settings, and all PATCH / DELETE.

/** One path segment (cuid or similar id) — never crosses a `/`. */
const ID = '[A-Za-z0-9_-]+';

const ALLOWED_API_CALLS: ReadonlyArray<{ method: string; pathPattern: RegExp }> = [
  { method: 'POST', pathPattern: /^\/rent\/reminders$/ },
  { method: 'POST', pathPattern: /^\/rent\/payments$/ },
  { method: 'POST', pathPattern: /^\/transactions$/ },
  { method: 'POST', pathPattern: new RegExp(`^/transactions/${ID}/confirm$`) },
  { method: 'POST', pathPattern: /^\/reports\/generate$/ },
  { method: 'POST', pathPattern: new RegExp(`^/insights/${ID}/dismiss$`) },
];

/** True when an api_call action may execute. Patterns match the path without
 *  its query string; the query (if any) is still sent on execution. */
export function isAllowedApiCall(method: string, path: string): boolean {
  const pathOnly = path.split('?')[0] ?? path;
  return ALLOWED_API_CALLS.some(
    (entry) => entry.method === method && entry.pathPattern.test(pathOnly),
  );
}

/** navigate actions must stay in-app: an absolute path, never `//host` or a full URL. */
export function isAllowedNavigate(to: string): boolean {
  return to.startsWith('/') && !to.startsWith('//');
}
