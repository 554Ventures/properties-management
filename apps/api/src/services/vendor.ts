// Vendor-string normalization, shared by contractor matching and the
// vendor→category memory (TRUSTWORTHY_TRANSACTIONS_PLAN.md §A3).

import { prisma } from '../lib/prisma';

/** Match key for contractor ↔ transaction-vendor joins (ARCHITECTURE §4). */
export function vendorKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The contractor a vendor string links to: exactly one ACTIVE contractor whose
 * name shares the vendorKey — zero or several matches link nothing (ambiguity
 * suppresses, mirroring rent matching). Every write path that sets `vendor`
 * stamps the result on `Transaction.contractorId`; contractor stats then
 * derive from that FK, never by re-matching strings at read time — so a
 * contractor rename or an unrelated vendor edit can't silently rewrite
 * already-linked history (ARCHITECTURE §4).
 */
export async function matchContractorId(
  accountId: string,
  vendor: string | null | undefined,
): Promise<string | null> {
  if (!vendor) return null;
  const key = vendorKey(vendor);
  const contractors = await prisma.contractor.findMany({
    where: { accountId, archivedAt: null },
    select: { id: true, name: true },
  });
  const matches = contractors.filter((c) => vendorKey(c.name) === key);
  return matches.length === 1 ? matches[0]!.id : null;
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
