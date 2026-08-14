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

/**
 * Per-transaction noise that only a raw bank descriptor carries. Every pattern
 * is anchored on the literal fragment grammar the banks use, so it cannot fire
 * on a merchant name: the ACH entry-class tags ("ComEd PAYMENTS PPD ID:
 * 2360938600" → "ComEd PAYMENTS"), any tagged reference where the separator is
 * actually present, embedded dates, and check numbers. Requiring the `:`/`#`
 * on the reference rule is what keeps "IRS TREAS 310 TAX REF" intact — its
 * "REF" is part of the descriptor, not a label on a varying value.
 *
 * The card-aggregator prefix runs first and is the one rule that preserves
 * text instead of dropping it: in "SQ *BLUE BOTTLE" the star introduces the
 * merchant, the opposite of "AMZN Mktp US*1A2B3C" where it introduces a
 * reference. Left to the generic `*` strip in vendorMemoryKey, "SQ *ACME
 * PLUMBING" and "SQ *BOB PLUMBING" would both key "sq plumbing" — two
 * merchants sharing one memory row, exactly the collapse this must not do.
 */
const DESCRIPTOR_NOISE: RegExp[] = [
  /\b(?:sq|sqc|tst|pypl|paypal|sp|py|ec|dd|gp)\s*\*\s*/gi,
  /\b(?:ppd|ccd|web|tel|arc|ipp)\s+id\b\s*:?\s*\S*/gi,
  /\b(?:id|ref|trace|auth|conf|inv)\s*[:#]\s*\S*/gi,
  /\b(?:ck|chk|check)\s*#?\s*\d+\b/gi,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g,
];

/**
 * Descriptor words that name a payment *mechanism* rather than a merchant. A
 * key built only from these (or only from bare reference numbers — "SQ *4417"
 * reduces to "4417") names nothing: it would pool unrelated merchants into one
 * memory row and then hand the pooled category out at 0.95. A wrong learned
 * category is worse than no learned category, because it rides into a tax
 * return — so such a key is refused outright and the keyword table answers.
 */
const NON_MERCHANT_TOKENS = new Set([
  'ach', 'atm', 'auto', 'autopay', 'bill', 'billpay', 'card', 'cash', 'ccd', 'check',
  'checkcard', 'chk', 'ck', 'credit', 'debit', 'deposit', 'des', 'direct', 'draft', 'eft',
  'electronic', 'epay', 'external', 'from', 'internet', 'mobile', 'online', 'pay', 'payment',
  'payments', 'paypal', 'pmt', 'pos', 'ppd', 'preauth', 'preauthorized', 'purchase', 'pymt',
  'pypl', 'recurring', 'sq', 'sqc', 'tel', 'to', 'transfer', 'tst', 'web', 'withdrawal', 'xfer',
]);

/**
 * Memory key for VendorCategoryMemory rows, derived from `vendor ?? description`.
 * Descriptor-only feeds have no merchant enrichment at all (real-stripe-fc.ts
 * sets `vendor: null`), so keying on the vendor alone meant those accounts
 * never wrote a memory row and never read one: the same ComEd bill was
 * suggested "Supplies" and corrected to "Utilities" every month forever.
 *
 * The balance, deliberately struck on the conservative side: strip only what
 * is provably per-transaction (tagged reference ids, dates, check numbers, and
 * — via vendorMemoryKey — trailing digit runs) and keep every remaining token.
 * Truncating to the first N tokens would match more often, but it would also
 * fold "AMAZON WEB SERVICES" into "AMAZON MKTP" and confidently mislearn a
 * category on money the user reports to the IRS. So this errs specific: a
 * merchant whose descriptor tail varies unpredictably simply never learns, and
 * nothing about today's behaviour changes for it.
 *
 * Almost every existing memory row keeps its key: on merchant-name input
 * (Plaid's merchant_name, a hand-typed vendor) none of the DESCRIPTOR_NOISE
 * patterns can fire, so the key is identical to what vendorMemoryKey produced
 * on its own. Two classes do re-key, and neither is worth a backfill:
 * - a vendor string that is itself a raw descriptor ("SQ *ACME" → "acme"),
 *   whose old key ("sq") was the wrong key anyway;
 * - a vendor that is ALL mechanism words — "PayPal", "Online Payment",
 *   "Direct Deposit" — which the guard below now refuses outright. Note this
 *   applies to vendor-set rows too, not just descriptors: those rows used to
 *   learn one category for every merchant behind the mechanism, which is the
 *   pooling this function exists to prevent. Refusing them is the fix, not a
 *   casualty of it.
 * Either way the stale row is simply never read again; it costs one extra
 * correction and nothing else, so there is no migration and no backfill.
 */
export function categoryMemoryKey(
  vendor: string | null | undefined,
  description?: string | null,
): string {
  const raw = vendor && vendor.trim() ? vendor : (description ?? '');
  let cleaned = raw;
  for (const noise of DESCRIPTOR_NOISE) cleaned = cleaned.replace(noise, ' ');
  const key = vendorMemoryKey(cleaned);
  const namesAMerchant = key
    .split(' ')
    .some((t) => t && !NON_MERCHANT_TOKENS.has(t) && !/^\d+$/.test(t));
  return namesAMerchant ? key : '';
}
