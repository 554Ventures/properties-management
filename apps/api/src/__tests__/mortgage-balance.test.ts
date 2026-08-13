// Mortgage balance derivation (PLAN-REAL-EQUITY §3). Pure math, no DB: the
// half-open interval `(balanceAsOfDate, asOf]` is the whole contract, and the
// boundaries are where this can silently go wrong — a payment counted twice or
// dropped shifts a balance-sheet liability by a real amount.
//
// Phase 1 never supplies payments (no `Transaction.principalCents` column yet),
// so these tests are what keeps the Phase 2 semantics honest before Phase 2
// has anything to feed it.
import { describe, expect, it } from 'vitest';
import { deriveMortgageBalanceCents } from '../lib/mortgage-balance';

const d = (iso: string) => new Date(iso);
const checkpoint = { balanceCents: 18_200_000, balanceAsOfDate: d('2026-01-31T00:00:00Z') };

describe('deriveMortgageBalanceCents', () => {
  it('returns the checkpoint when nothing has been paid against it', () => {
    // Phase 1's only real case.
    expect(deriveMortgageBalanceCents(checkpoint, [], d('2026-08-10T00:00:00Z'))).toBe(18_200_000);
    expect(deriveMortgageBalanceCents(checkpoint, [], checkpoint.balanceAsOfDate)).toBe(18_200_000);
  });

  it('subtracts principal paid after the checkpoint, up to and including asOf', () => {
    const payments = [
      { date: d('2026-02-05T00:00:00Z'), principalCents: 80_000 },
      { date: d('2026-03-05T00:00:00Z'), principalCents: 81_000 },
    ];
    expect(deriveMortgageBalanceCents(checkpoint, payments, d('2026-03-05T00:00:00Z'))).toBe(
      18_200_000 - 161_000,
    );
  });

  it('ignores payments dated after asOf', () => {
    const payments = [
      { date: d('2026-02-05T00:00:00Z'), principalCents: 80_000 },
      { date: d('2026-09-05T00:00:00Z'), principalCents: 82_000 },
    ];
    expect(deriveMortgageBalanceCents(checkpoint, payments, d('2026-08-10T00:00:00Z'))).toBe(
      18_200_000 - 80_000,
    );
  });

  it('excludes a payment dated exactly on the checkpoint — the statement already reflects it', () => {
    const payments = [{ date: checkpoint.balanceAsOfDate, principalCents: 80_000 }];
    expect(deriveMortgageBalanceCents(checkpoint, payments, d('2026-08-10T00:00:00Z'))).toBe(
      18_200_000,
    );
  });

  it('adds principal back when reporting a date before the checkpoint', () => {
    // A filed prior period must not inherit today's lower balance.
    const payments = [
      { date: d('2025-12-05T00:00:00Z'), principalCents: 79_000 },
      { date: d('2026-01-05T00:00:00Z'), principalCents: 79_500 },
      { date: d('2026-02-05T00:00:00Z'), principalCents: 80_000 },
    ];
    expect(deriveMortgageBalanceCents(checkpoint, payments, d('2025-12-31T00:00:00Z'))).toBe(
      18_200_000 + 79_500,
    );
  });

  it('handles a principal-only payment (the whole debit reduces the loan)', () => {
    const payments = [{ date: d('2026-02-05T00:00:00Z'), principalCents: 240_000 }];
    expect(deriveMortgageBalanceCents(checkpoint, payments, d('2026-08-10T00:00:00Z'))).toBe(
      18_200_000 - 240_000,
    );
  });
});
