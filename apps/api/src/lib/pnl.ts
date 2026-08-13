// Classification semantics for money aggregates (TRUSTWORTHY_TRANSACTIONS_PLAN
// §D1). One place decides what counts: `transfer` and `owner_contribution`
// never count toward P&L/KPIs (moving your own money is neither income nor
// expense); `refund` (always an income-type row) counts as a NEGATIVE expense,
// netting against the category it refunds. Ordinary rows (classification null)
// count as their type. The general ledger and the transactions list still show
// every row — classification only changes aggregation, never visibility.
//
// The principal carve-out (PLAN-REAL-EQUITY §3) lives here for the same reason:
// a mortgage payment is ONE ledger row for the whole bank debit, but the
// `principalCents` slice of it repays a liability instead of buying anything —
// it is not an expense. So an expense row contributes `amountCents −
// (principalCents ?? 0)`, and that carve-out is what decrements the mortgage
// balance (lib/mortgage-balance.ts) instead. A principal-only payment
// (`principalCents === amountCents`) legally contributes $0, like a transfer,
// while still showing its full amount in the ledger. Every caller must feed
// `principalCents` in — it is a required field on these inputs precisely so a
// new aggregate cannot forget it and silently re-inflate the books.
import type { Prisma } from '@prisma/client';

/**
 * Null-safe where-fragment selecting only rows that participate in P&L.
 * (Prisma's `notIn` drops NULL rows — SQL three-valued logic — so this is an
 * explicit OR instead.)
 */
export const countsInPnl: Prisma.TransactionWhereInput = {
  OR: [{ classification: null }, { classification: 'refund' }],
};

/** Expense-side where-fragment: ordinary expense rows only (no transfers). */
export const ordinaryExpense: Prisma.TransactionWhereInput = {
  type: 'expense',
  classification: null,
};

export interface PnlBucket {
  bucket: 'income' | 'expense';
  /** Signed contribution: refunds contribute a negative expense. */
  amountCents: number;
}

/** Per-row P&L contribution for JS reducers; null = row doesn't count. */
export function pnlBucket(t: {
  type: string;
  classification: string | null;
  amountCents: number;
  /** Liability-repayment slice of a mortgage payment — never an expense. */
  principalCents: number | null;
}): PnlBucket | null {
  if (t.classification === 'transfer' || t.classification === 'owner_contribution') return null;
  if (t.classification === 'refund') return { bucket: 'expense', amountCents: -t.amountCents };
  if (t.type === 'income') return { bucket: 'income', amountCents: t.amountCents };
  // Principal repays the mortgage; only the interest/escrow remainder is spend.
  return { bucket: 'expense', amountCents: t.amountCents - (t.principalCents ?? 0) };
}

/** One per-category P&L line derived from a transaction. `C` is whatever the
 *  caller included for the category relation (name, irsScheduleELine, …). */
export interface PnlCategoryLine<C> {
  bucket: 'income' | 'expense';
  categoryId: string | null;
  category: C | null;
  amountCents: number;
}

/**
 * Per-CATEGORY P&L contribution(s) of a transaction — the one place that knows
 * splits exist. An unsplit row yields a single line for its own category; a
 * split row yields one line per split (its money is unchanged, only its
 * categorization is finer). A row that doesn't count in P&L yields none.
 *
 * Totals never go through here (they're per-row: `pnlBucket`/`pnlSums`) —
 * splits sum exactly to the parent's countable money, so both agree by
 * construction: an unsplit row's single line carries `pnlBucket`'s already
 * principal-net amount, and splits on a principal-bearing row sum to
 * `amountCents − principalCents` by the invariant transaction.service enforces.
 * Splits can never carry a classification (transaction.service rejects it), so
 * the refund sign-flip only ever applies to the single-line case.
 */
export function pnlCategoryLines<C>(t: {
  type: string;
  classification: string | null;
  amountCents: number;
  principalCents: number | null;
  categoryId: string | null;
  category?: C | null;
  splits?: Array<{ categoryId: string; amountCents: number; category?: C | null }>;
}): Array<PnlCategoryLine<C>> {
  const b = pnlBucket(t);
  if (!b) return [];
  const splits = t.splits ?? [];
  if (splits.length === 0) {
    return [
      {
        bucket: b.bucket,
        categoryId: t.categoryId,
        category: t.category ?? null,
        amountCents: b.amountCents,
      },
    ];
  }
  return splits.map((s) => ({
    bucket: b.bucket,
    categoryId: s.categoryId,
    category: s.category ?? null,
    amountCents: s.amountCents,
  }));
}

/**
 * Effective totals from a `groupBy(['type', 'classification', ...])` result.
 * The groupBy must `_sum` `principalCents` alongside `amountCents` — the sum of
 * the group's principal is carved out of the sum of its amounts.
 */
export function pnlSums(
  grouped: Array<{
    type: string;
    classification: string | null;
    _sum: { amountCents: number | null; principalCents: number | null };
  }>,
): { incomeCents: number; expenseCents: number; netCents: number } {
  let incomeCents = 0;
  let expenseCents = 0;
  for (const g of grouped) {
    const b = pnlBucket({
      ...g,
      amountCents: g._sum.amountCents ?? 0,
      principalCents: g._sum.principalCents ?? 0,
    });
    if (!b) continue;
    if (b.bucket === 'income') incomeCents += b.amountCents;
    else expenseCents += b.amountCents;
  }
  return { incomeCents, expenseCents, netCents: incomeCents - expenseCents };
}
