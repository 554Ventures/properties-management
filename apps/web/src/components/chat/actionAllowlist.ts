// Allowlist for AI-proposed actions (§9.3 hardening): chat action_card
// buttons AND insight-card structured actions (components/ai/InsightCard)
// both gate through here. api_call buttons execute a server-supplied
// method+path through the normal REST client, so in real-AI mode a
// prompt-injected model could hide an arbitrary write (e.g. POST
// /reports/:id/email {to: attacker}) behind a benign label. Only the write
// routes the assistant legitimately proposes may execute; anything else
// renders as a disabled button with a visible note — never a silent drop,
// and never executed.
//
// Adding/editing core records (properties, tenants, leases, contractors,
// transactions) is explicitly supported: the assistant fills in the body and
// the USER clicks to save, so each PATCH below edits data within the user's
// own account — a visible, reversible, click-gated change, not an
// exfiltration channel.
// Still deliberately excluded: /reports/:id/email (data leaves the account),
// anything under /settings (security-sensitive config), every DELETE (we
// never let the assistant destroy records), lease termination (it ends a
// tenancy and the UI offers no undo), and any PATCH not listed here.

/** One path segment (cuid or similar id) — never crosses a `/`. */
const ID = '[A-Za-z0-9_-]+';

const ALLOWED_API_CALLS: ReadonlyArray<{ method: string; pathPattern: RegExp }> = [
  { method: 'POST', pathPattern: /^\/rent\/reminders$/ },
  { method: 'POST', pathPattern: /^\/rent\/payments$/ },
  // Apply a late fee (WS7): click-gated, reversible from the Rent tracker's
  // waive action. Waiving itself stays excluded (it's a DELETE).
  { method: 'POST', pathPattern: new RegExp(`^/rent/payments/${ID}/late-fee$`) },
  { method: 'POST', pathPattern: /^\/transactions$/ },
  { method: 'PATCH', pathPattern: new RegExp(`^/transactions/${ID}$`) },
  { method: 'POST', pathPattern: new RegExp(`^/transactions/${ID}/confirm$`) },
  { method: 'POST', pathPattern: /^\/properties$/ },
  { method: 'PATCH', pathPattern: new RegExp(`^/properties/${ID}$`) },
  { method: 'POST', pathPattern: new RegExp(`^/properties/${ID}/units$`) },
  { method: 'PATCH', pathPattern: new RegExp(`^/units/${ID}$`) },
  // Mortgages + valuations (PLAN-REAL-EQUITY §4): same click-gated record-edit
  // rationale as properties/units above. No DELETEs and no archive/restore —
  // matching the archive/restore exclusion precedent for every other record.
  { method: 'POST', pathPattern: new RegExp(`^/properties/${ID}/mortgages$`) },
  { method: 'PATCH', pathPattern: new RegExp(`^/mortgages/${ID}$`) },
  { method: 'POST', pathPattern: new RegExp(`^/properties/${ID}/valuations$`) },
  { method: 'POST', pathPattern: /^\/tenants$/ },
  { method: 'PATCH', pathPattern: new RegExp(`^/tenants/${ID}$`) },
  { method: 'POST', pathPattern: /^\/contractors$/ },
  { method: 'PATCH', pathPattern: new RegExp(`^/contractors/${ID}$`) },
  { method: 'POST', pathPattern: /^\/reports\/generate$/ },
  { method: 'POST', pathPattern: new RegExp(`^/insights/${ID}/dismiss$`) },
  // Leases. Same rationale as the record edits above — click-gated changes to
  // the user's own data — plus the assistant now has matching tools, so chat
  // and the MCP connector stop diverging. Renewal is included because
  // draft_lease_renewal could already propose terms it had no way to enact.
  // Terminating a lease is deliberately NOT here: it ends a tenancy and is not
  // undoable from the UI, so it stays a decision the user makes on the lease
  // itself. Removing a tenant from a lease is a DELETE and excluded with them.
  { method: 'POST', pathPattern: /^\/leases$/ },
  { method: 'PATCH', pathPattern: new RegExp(`^/leases/${ID}$`) },
  { method: 'POST', pathPattern: new RegExp(`^/leases/${ID}/renewal$`) },
  { method: 'POST', pathPattern: new RegExp(`^/leases/${ID}/tenants$`) },
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
