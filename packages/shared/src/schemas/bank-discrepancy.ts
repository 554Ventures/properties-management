import { z } from 'zod';
import { TransactionTypeSchema, TransactionStatusSchema } from '../enums';
import { PeriodSchema } from './rent';

// Which bank feed raised the change. String column validated by this enum (no
// Prisma enum — @hearth/shared stays the source of truth).
export const BankSyncProviderSchema = z.enum(['plaid', 'stripe_fc']);

// What the bank did to a row you'd already confirmed/dismissed: restated its
// fields ('modified') or voided it entirely ('removed').
export const BankDiscrepancyKindSchema = z.enum(['modified', 'removed']);

// Lifecycle: 'pending' until the landlord accepts the bank's version (applied
// through the guarded update/remove path) or dismisses it (keeps their own).
export const BankDiscrepancyStatusSchema = z.enum(['pending', 'accepted', 'dismissed']);

// The restated bank values for a 'modified' change — exactly the fields the
// sync pipeline receives from the Plaid/Stripe FC adapter (a mapped bank row).
// Null/absent for a 'removed' change, which carries no new row data.
export const BankDiscrepancyDataSchema = z.object({
  date: z.string().datetime(),
  amountCents: z.number().int().positive(),
  type: TransactionTypeSchema,
  description: z.string(),
  vendor: z.string().nullable(),
});

// A pending bank-sync discrepancy plus a summary of the local ledger row it
// targets, so the review surface can render the before/after diff without a
// second fetch. rentPaymentId/depositId/rentPeriod are present only when the
// local row backs a rent deposit — they power the guided "unlink then accept"
// flow (accept goes through the same guarded remove/update as the ledger, so a
// rent-linked row 400s until its deposit is unlinked on the Rent page).
export const BankDiscrepancyRowSchema = z.object({
  id: z.string(),
  provider: BankSyncProviderSchema,
  kind: BankDiscrepancyKindSchema,
  externalId: z.string(),
  bankData: BankDiscrepancyDataSchema.nullable(),
  createdAt: z.string().datetime(),
  // The local ledger row the bank change targets. Null when it has since been
  // deleted (SetNull) — the discrepancy is then only dismissable.
  transaction: z
    .object({
      id: z.string(),
      description: z.string(),
      vendor: z.string().nullable(),
      amountCents: z.number().int().positive(),
      date: z.string().datetime(),
      type: TransactionTypeSchema,
      status: TransactionStatusSchema,
      categoryName: z.string().nullable(),
    })
    .nullable(),
  // Guided unlink context — present only when the local row backs a rent
  // deposit. depositId feeds DELETE /rent/payments/:rentPaymentId/deposits/:depositId.
  rentPaymentId: z.string().optional(),
  depositId: z.string().optional(),
  rentPeriod: PeriodSchema.optional(),
});

// GET /transactions/bank-discrepancies — pending rows only.
export const BankDiscrepancyListResponseSchema = z.object({
  items: z.array(BankDiscrepancyRowSchema),
});

// POST /transactions/bank-discrepancies/:id/accept | /dismiss — the resolved
// discrepancy (the list refetches for the fresh pending set). Accept applies
// the restated values via the guarded path; a rent-linked row 400s and stays
// pending.
export const BankDiscrepancyResolutionSchema = z.object({
  id: z.string(),
  status: BankDiscrepancyStatusSchema,
  resolvedAt: z.string().datetime().nullable(),
});
