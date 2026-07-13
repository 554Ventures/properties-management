// Vendor-string normalization, shared by contractor matching and the
// vendor→category memory (TRUSTWORTHY_TRANSACTIONS_PLAN.md §A3).

/** Match key for contractor ↔ transaction-vendor joins (ARCHITECTURE §4). */
export function vendorKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Memory key for VendorCategoryMemory rows. Bank feeds decorate the same
 * merchant with per-transaction noise ("AMZN Mktp US*1A2B3C" vs "*9Z8Y7X",
 * "HOME DEPOT 4512"), so the plain vendorKey would rarely hit twice on real
 * feed data. Strips *- and #-prefixed reference fragments anywhere, then
 * trailing digit-led reference tokens, keeping at least one token so a purely
 * numeric vendor still gets a stable key. Contractor matching deliberately
 * keeps the plain vendorKey — directory names don't carry this noise, and
 * loosening it would change ARCHITECTURE §4 derivation semantics.
 */
export function vendorMemoryKey(name: string): string {
  const base = vendorKey(name).replace(/[*#]\S*/g, ' ');
  const tokens = base.split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && /^\d[\w-]*$/.test(tokens[tokens.length - 1] as string)) {
    tokens.pop();
  }
  return tokens.join(' ');
}
