// Classification semantics for money aggregates (TRUSTWORTHY_TRANSACTIONS_PLAN
// §D1). One place decides what counts: `transfer` and `owner_contribution`
// never count toward P&L/KPIs (moving your own money is neither income nor
// expense); `refund` (always an income-type row) counts as a NEGATIVE expense,
// netting against the category it refunds. Ordinary rows (classification null)
// count as their type. The general ledger and the transactions list still show
// every row — classification only changes aggregation, never visibility.
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
}): PnlBucket | null {
  if (t.classification === 'transfer' || t.classification === 'owner_contribution') return null;
  if (t.classification === 'refund') return { bucket: 'expense', amountCents: -t.amountCents };
  return { bucket: t.type === 'income' ? 'income' : 'expense', amountCents: t.amountCents };
}

/** Effective totals from a `groupBy(['type', 'classification', ...])` result. */
export function pnlSums(
  grouped: Array<{
    type: string;
    classification: string | null;
    _sum: { amountCents: number | null };
  }>,
): { incomeCents: number; expenseCents: number; netCents: number } {
  let incomeCents = 0;
  let expenseCents = 0;
  for (const g of grouped) {
    const b = pnlBucket({ ...g, amountCents: g._sum.amountCents ?? 0 });
    if (!b) continue;
    if (b.bucket === 'income') incomeCents += b.amountCents;
    else expenseCents += b.amountCents;
  }
  return { incomeCents, expenseCents, netCents: incomeCents - expenseCents };
}
