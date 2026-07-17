import { z } from 'zod';
import { RentPaymentMethodSchema, RentPaymentStatusSchema } from '../enums';

/** Rent period, "YYYY-MM". */
export const PeriodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected "YYYY-MM"');

/**
 * Derived display status per ARCHITECTURE §4: stored RentPaymentStatus plus
 * "late" (unpaid past dueDate + graceDays) and "partial" (0 < paidCents <
 * amountCents; stored status stays 'due' until fully covered). Always rendered
 * with text, never color alone.
 */
export const RentStatusSchema = z.enum(['due', 'processing', 'paid', 'failed', 'late', 'partial']);

export const RentPaymentSchema = z.object({
  id: z.string(),
  leaseId: z.string(),
  period: PeriodSchema,
  dueDate: z.string().datetime(),
  amountCents: z.number().int(),
  paidCents: z.number().int(), // running total received (sum of deposits)
  // Late fee applied to this charge (WS7); 0 = none. Total owed is
  // amountCents + lateFeeCents; remaining = that minus paidCents.
  lateFeeCents: z.number().int().nonnegative(),
  method: RentPaymentMethodSchema.nullable(), // null until paid
  status: RentPaymentStatusSchema,
  paidAt: z.string().datetime().nullable(),
  externalRef: z.string().nullable(), // mock Stripe id
  transactionId: z.string().nullable(), // legacy single-payment link; deposits are the source of truth
  remindedAt: z.string().datetime().nullable(),
});

// One received payment toward a charge (many deposits sum toward one
// RentPayment) — surfaced on tracker rows so partial progress is inspectable
// and individual deposits can be unlinked.
export const RentDepositSchema = z.object({
  id: z.string(),
  transactionId: z.string(),
  amountCents: z.number().int().positive(),
  tenantId: z.string().nullable(), // which co-tenant paid, when known
  method: RentPaymentMethodSchema.nullable(),
  paidAt: z.string().datetime(),
});

// Payment-history row (TenantDetailResponse.paymentHistory).
export const RentPaymentRowSchema = z.object({
  id: z.string(),
  period: PeriodSchema,
  dueDate: z.string().datetime(),
  amountCents: z.number().int(),
  paidCents: z.number().int(),
  lateFeeCents: z.number().int().nonnegative(), // late fee applied to this charge (WS7); 0 = none
  status: RentStatusSchema,
  daysLate: z.number().int().min(1).optional(), // present when past grace (late or partial-but-late)
  method: RentPaymentMethodSchema.nullable(),
  paidAt: z.string().datetime().nullable(), // set only once the charge is FULLY covered
  // Most recent deposit's date, regardless of whether the charge is fully
  // covered — the display date for a partial payment, since paidAt stays null
  // until the charge is fully paid. Null when no deposits exist yet.
  lastDepositAt: z.string().datetime().nullable(),
});

// Per-co-tenant slice of a tracker row (plan §C): expected share (stored, or
// an even split when unspecified), what deposits attribute to this tenant,
// and whether their share is settled. Single-tenant units get one entry.
export const RentTenantShareSchema = z.object({
  tenantId: z.string(),
  tenantName: z.string(),
  isPrimary: z.boolean(),
  shareCents: z.number().int().nonnegative(), // effective share (stored or even split)
  shareSpecified: z.boolean(), // false = even-split fallback
  paidCents: z.number().int(), // sum of deposits attributed to this tenant
  settled: z.boolean(), // paidCents ≥ shareCents
});

// GET /rent/tracker?period=YYYY-MM
export const RentTrackerRowSchema = z.object({
  rentPaymentId: z.string(),
  leaseId: z.string(),
  tenantId: z.string(),
  tenantName: z.string(),
  unitId: z.string(),
  unitLabel: z.string(),
  propertyId: z.string(),
  propertyLabel: z.string(),
  amountCents: z.number().int(),
  paidCents: z.number().int(), // "$X of $Y" display for partials
  lateFeeCents: z.number().int().nonnegative(), // late fee applied (WS7); 0 = none. total owed = amountCents + lateFeeCents
  dueDate: z.string().datetime(),
  status: RentStatusSchema,
  daysLate: z.number().int().min(1).optional(), // present when past grace (late or partial-but-late)
  method: RentPaymentMethodSchema.nullable(),
  paidAt: z.string().datetime().nullable(), // set only once the charge is FULLY covered
  // Most recent deposit's date (null when no deposits) — see RentPaymentRowSchema.
  lastDepositAt: z.string().datetime().nullable(),
  deposits: z.array(RentDepositSchema),
  tenants: z.array(RentTenantShareSchema),
  // Soft data-quality signal: specified shares don't sum to the charge.
  sharesMismatch: z.boolean(),
});

export const RentTrackerResponseSchema = z.object({
  period: PeriodSchema,
  collectedCents: z.number().int(), // sum of paidCents across all rows (partials included)
  outstandingCents: z.number().int(), // sum of (amountCents − paidCents) where positive
  paidUnits: z.number().int(), // fully paid
  partialUnits: z.number().int(), // 0 < paidCents < amountCents
  totalUnits: z.number().int(),
  rows: z.array(RentTrackerRowSchema),
});

// POST /rent/payments
export const RecordRentPaymentInputSchema = z.object({
  leaseId: z.string(),
  period: PeriodSchema,
  amountCents: z.number().int().positive(), // ≤ the charge's remaining balance
  method: RentPaymentMethodSchema,
  paidAt: z.string().datetime().optional(), // defaults to now
  tenantId: z.string().optional(), // which co-tenant paid (must be on the lease)
});

// GET /rent/unlinked-deposits?period= — Rent-categorized income transactions
// that could apply to a still-open charge but aren't linked as deposits (plan
// §C5): the "silently still late" fix. Broader than the review-queue chip
// (below-remaining partials included); surfaced as a question, never
// auto-applied. Ambiguous candidates (one deposit fitting several charges)
// are suppressed.
export const UnlinkedRentDepositSchema = z.object({
  transactionId: z.string(),
  description: z.string(),
  amountCents: z.number().int().positive(),
  date: z.string().datetime(),
  rentPaymentId: z.string(),
  leaseId: z.string(),
  tenantName: z.string(),
  unitLabel: z.string(),
  propertyLabel: z.string(),
  period: PeriodSchema,
  remainingCents: z.number().int().positive(), // still due on the charge before this deposit
});

export const UnlinkedRentDepositsResponseSchema = z.object({
  items: z.array(UnlinkedRentDepositSchema),
});

// POST /rent/payments/:id/payment-link — mock Stripe link.
export const PaymentLinkResponseSchema = z.object({
  url: z.string(),
});

// POST /rent/reminders
export const SendRemindersInputSchema = z.object({
  rentPaymentIds: z.array(z.string()).min(1),
});

export const SendReminderResultSchema = z.object({
  rentPaymentId: z.string(),
  status: z.enum(['sent', 'skipped']),
  reason: z.string().optional(), // present when skipped
  mailto: z.string().optional(), // present when sent — opens the composed reminder in the user's own mail client
  subject: z.string().optional(), // present when sent — for display before opening the mail client
});

export const SendRemindersResponseSchema = z.object({
  results: z.array(SendReminderResultSchema),
});

// POST /rent/payments/:id/late-fee — apply a late fee to a late charge (WS7).
// Always an explicit human/user-invoked action, never auto-applied. `feeCents`
// omitted falls back to the effective policy: the lease override
// (Lease.lateFeeCents) when set, otherwise the account default
// (Account.defaultLateFeeCents). With no explicit fee and no policy configured
// the request is rejected. DELETE on the same path waives the applied fee.
export const ApplyLateFeeInputSchema = z.object({
  feeCents: z.number().int().positive().optional(),
});
