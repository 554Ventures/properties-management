// Mortgage balance derivation (PLAN-REAL-EQUITY §3) — the one place that knows
// how a checkpoint plus principal payments becomes a current balance. Pure and
// integer-only so both the property hub and the balance sheet can call it, and
// so Phase 2's `Transaction.principalCents` needs no new math.
//
//   balance(t) = balanceCents − Σ principalCents of CONFIRMED rows for this
//                mortgage dated in (balanceAsOfDate, t]
//
// Signed the other way when `t` precedes the checkpoint: reporting a date
// before the statement means adding back the principal paid in between, so a
// filed prior period doesn't silently inherit today's balance.
//
// Only confirmed rows count — a drafted payment sitting in the review queue
// moves no money and must move no balance.

export interface MortgageCheckpoint {
  balanceCents: number;
  balanceAsOfDate: Date;
}

/** A confirmed principal-bearing payment against one mortgage. */
export interface PrincipalPayment {
  date: Date;
  principalCents: number;
}

/**
 * Balance as of `asOf` (inclusive). In Phase 1 no transaction can carry
 * principal yet, so callers pass an empty list and get the checkpoint back —
 * deliberately: the formula ships once, and Phase 2 only starts feeding it rows.
 */
export function deriveMortgageBalanceCents(
  checkpoint: MortgageCheckpoint,
  payments: readonly PrincipalPayment[],
  asOf: Date,
): number {
  const checkpointMs = checkpoint.balanceAsOfDate.getTime();
  const asOfMs = asOf.getTime();

  if (asOfMs >= checkpointMs) {
    const paid = payments.reduce(
      (sum, p) => (p.date.getTime() > checkpointMs && p.date.getTime() <= asOfMs ? sum + p.principalCents : sum),
      0,
    );
    return checkpoint.balanceCents - paid;
  }

  // asOf is before the checkpoint: add back principal paid in (asOf, checkpoint].
  const paidSince = payments.reduce(
    (sum, p) => (p.date.getTime() > asOfMs && p.date.getTime() <= checkpointMs ? sum + p.principalCents : sum),
    0,
  );
  return checkpoint.balanceCents + paidSince;
}
