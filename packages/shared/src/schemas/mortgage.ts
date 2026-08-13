// Mortgages — the liability side of a property (PLAN-REAL-EQUITY §2).
// Multiple per property is legal (seconds/HELOCs exist).
//
// `balanceCents` + `balanceAsOfDate` are a *statement checkpoint*, not a
// running total: the current balance is derived (ARCHITECTURE §4
// derive-don't-store) as the checkpoint minus principal paid since that date.
// Phase 1 has no principal-bearing rows, so `currentBalanceCents` equals the
// checkpoint; Phase 2's `Transaction.principalCents` makes it move without any
// contract change.
import { z } from 'zod';

export const MortgageSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  propertyId: z.string(),
  lender: z.string(),
  /** Statement checkpoint balance — what the lender said on `balanceAsOfDate`. */
  balanceCents: z.number().int(),
  balanceAsOfDate: z.string().datetime(),
  /** Derived: checkpoint − confirmed principal paid after the checkpoint date. */
  currentBalanceCents: z.number().int(),
  originalPrincipalCents: z.number().int().nullable(),
  startDate: z.string().datetime().nullable(),
  /** Thousandths of a percent — 6.375% = 6375. Display-only in v1. */
  interestRateMilliPct: z.number().int().nullable(),
  escrowNote: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});
export type Mortgage = z.infer<typeof MortgageSchema>;

// POST /properties/:id/mortgages
export const CreateMortgageInputSchema = z.object({
  lender: z.string().min(1),
  balanceCents: z.number().int().min(0),
  balanceAsOfDate: z.string().datetime(),
  originalPrincipalCents: z.number().int().min(0).optional(),
  startDate: z.string().datetime().optional(),
  // 0–100% expressed in milli-percent; wider than any real rate, tight enough
  // to catch a caller passing basis points or a raw percentage.
  interestRateMilliPct: z.number().int().min(0).max(100_000).optional(),
  escrowNote: z.string().optional(),
  notes: z.string().optional(),
});
export type CreateMortgageInput = z.infer<typeof CreateMortgageInputSchema>;

// The editable fields, without the pairing rule. Exported as a plain object
// schema so callers that need to compose (an AI tool adding `mortgageId`, say)
// can `.extend()` it: refining first would yield a ZodEffects, and intersecting
// that produces an `allOf` JSON Schema with no top-level `properties` — which
// the Anthropic tool API rejects outright. The pairing rule is enforced in
// `mortgage.service.update` for every adapter regardless of which shape a
// caller validated with.
export const UpdateMortgageFieldsSchema = CreateMortgageInputSchema.partial();

// PATCH /mortgages/:id — also the re-checkpoint path. A new balance is only
// meaningful with the date it was true on, so the two move together.
export const UpdateMortgageInputSchema = UpdateMortgageFieldsSchema.refine(
  (v) => (v.balanceCents === undefined) === (v.balanceAsOfDate === undefined),
  {
    message:
      'balanceCents and balanceAsOfDate must be updated together — a balance is only meaningful as of a date.',
    path: ['balanceAsOfDate'],
  },
);
export type UpdateMortgageInput = z.infer<typeof UpdateMortgageInputSchema>;
