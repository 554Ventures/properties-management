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
  status: RentStatusSchema,
  daysLate: z.number().int().min(1).optional(), // present when past grace (late or partial-but-late)
  method: RentPaymentMethodSchema.nullable(),
  paidAt: z.string().datetime().nullable(),
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
  dueDate: z.string().datetime(),
  status: RentStatusSchema,
  daysLate: z.number().int().min(1).optional(), // present when past grace (late or partial-but-late)
  method: RentPaymentMethodSchema.nullable(),
  paidAt: z.string().datetime().nullable(),
  deposits: z.array(RentDepositSchema),
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
  amountCents: z.number().int().positive(),
  method: RentPaymentMethodSchema,
  paidAt: z.string().datetime().optional(), // defaults to now
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
