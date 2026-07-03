import { z } from 'zod';
import { RentPaymentMethodSchema, RentPaymentStatusSchema } from '../enums';

/** Rent period, "YYYY-MM". */
export const PeriodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected "YYYY-MM"');

/**
 * Derived display status per ARCHITECTURE §4: stored RentPaymentStatus plus
 * "late" (due and past dueDate + graceDays). Always rendered with text, never
 * color alone.
 */
export const RentStatusSchema = z.enum(['due', 'processing', 'paid', 'failed', 'late']);

export const RentPaymentSchema = z.object({
  id: z.string(),
  leaseId: z.string(),
  period: PeriodSchema,
  dueDate: z.string().datetime(),
  amountCents: z.number().int(),
  method: RentPaymentMethodSchema.nullable(), // null until paid
  status: RentPaymentStatusSchema,
  paidAt: z.string().datetime().nullable(),
  externalRef: z.string().nullable(), // mock Stripe id
  transactionId: z.string().nullable(), // ledger Transaction created on payment
  remindedAt: z.string().datetime().nullable(),
});

// Payment-history row (TenantDetailResponse.paymentHistory).
export const RentPaymentRowSchema = z.object({
  id: z.string(),
  period: PeriodSchema,
  dueDate: z.string().datetime(),
  amountCents: z.number().int(),
  status: RentStatusSchema,
  daysLate: z.number().int().min(1).optional(), // present iff status = "late"
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
  dueDate: z.string().datetime(),
  status: RentStatusSchema,
  daysLate: z.number().int().min(1).optional(), // present iff status = "late"
  method: RentPaymentMethodSchema.nullable(),
  paidAt: z.string().datetime().nullable(),
});

export const RentTrackerResponseSchema = z.object({
  period: PeriodSchema,
  collectedCents: z.number().int(),
  outstandingCents: z.number().int(),
  paidUnits: z.number().int(),
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
});

export const SendRemindersResponseSchema = z.object({
  results: z.array(SendReminderResultSchema),
});
