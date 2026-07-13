import { z } from 'zod';
import {
  TransactionClassificationSchema,
  TransactionSourceSchema,
  TransactionStatusSchema,
  TransactionTypeSchema,
} from '../enums';
import { PeriodSchema } from './rent';

export const TransactionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  propertyId: z.string().nullable(),
  unitId: z.string().nullable(),
  categoryId: z.string().nullable(),
  date: z.string().datetime(),
  amountCents: z.number().int().positive(), // always positive; sign comes from `type`
  type: TransactionTypeSchema,
  description: z.string(),
  vendor: z.string().nullable(),
  source: TransactionSourceSchema,
  status: TransactionStatusSchema,
  classification: TransactionClassificationSchema.nullable(), // null = ordinary income/expense
  aiSuggestedCategoryId: z.string().nullable(),
  aiConfidence: z.number().min(0).max(1).nullable(),
  receiptUrl: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  // True when this row backs a rent deposit (or legacy RentPayment link) —
  // the ledger shows an "applied to rent" marker and explains why amount/
  // date/type edits and deletion are restricted. Populated by GET
  // /transactions only; optional so other producers stay unchanged.
  rentLinked: z.boolean().optional(),
});

// POST /transactions — if categoryId is omitted the response carries
// aiSuggestedCategoryId + aiConfidence for the "AI guess" chip; save is
// always explicit.
export const CreateTransactionInputSchema = z.object({
  date: z.string().datetime(),
  amountCents: z.number().int().positive(),
  type: TransactionTypeSchema,
  description: z.string().min(1),
  propertyId: z.string().optional(),
  unitId: z.string().optional(),
  categoryId: z.string().optional(),
  vendor: z.string().optional(),
  receiptUrl: z.string().optional(),
  classification: TransactionClassificationSchema.optional(),
});

// PATCH /transactions/:id — `classification: null` clears back to ordinary.
export const UpdateTransactionInputSchema = CreateTransactionInputSchema.partial().extend({
  classification: TransactionClassificationSchema.nullable().optional(),
});

// POST /transactions/:id/confirm — rentPaymentId links the (income) transaction
// to that expected rent payment and marks it paid; property/unit then come from
// the lease and any propertyId/unitId here are ignored.
export const ConfirmTransactionInputSchema = z.object({
  categoryId: z.string().optional(), // override; omitted = accept the AI suggestion
  rentPaymentId: z.string().optional(),
  propertyId: z.string().optional(),
  unitId: z.string().optional(),
  classification: TransactionClassificationSchema.optional(), // review time is the natural moment to say "this is a transfer"
});

// Ledger sort fields (whitelist — maps to DB columns server-side).
export const TransactionSortFieldSchema = z.enum(['date', 'amountCents', 'description', 'status']);

export const SortDirectionSchema = z.enum(['asc', 'desc']);

// GET /transactions query filters — also reused verbatim by the MCP
// `list_transactions` tool (ARCHITECTURE §7). Supports two pagination modes:
// `cursor` (infinite scroll) or `offset` (numbered pages); pass one, not both.
export const TransactionListQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  propertyId: z.string().optional(),
  type: TransactionTypeSchema.optional(),
  status: TransactionStatusSchema.optional(),
  categoryId: z.string().optional(),
  q: z.string().optional(), // case-insensitive match on description or vendor
  sort: TransactionSortFieldSchema.optional(), // default: date desc
  dir: SortDirectionSchema.optional(),
  cursor: z.string().optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const TransactionListResponseSchema = z.object({
  items: z.array(TransactionSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int(), // items matching the filter across all pages
});

// Heuristic rent match computed at review time (never stored, never
// auto-applied): an income bank transaction that looks like a lease's open
// expected rent — exactly the charge's *remaining* balance (full amount, or
// the shortfall of a partial), dated within a window of the due date.
export const RentMatchSuggestionSchema = z.object({
  rentPaymentId: z.string(),
  leaseId: z.string(),
  tenantName: z.string(),
  propertyId: z.string(),
  propertyLabel: z.string(),
  unitId: z.string(),
  unitLabel: z.string(),
  period: PeriodSchema,
  dueDate: z.string().datetime(),
  amountCents: z.number().int().positive(), // the full charge
  paidCents: z.number().int(), // already received; the match completes the difference
  confidence: z.number().min(0).max(1),
});

// POST /transactions response — the created row plus, for a confirmed income
// entry, the same heuristic rent match the review queue computes: manual rent
// logging otherwise bypasses the tracker entirely, leaving the unit "due" and
// inviting a second (double-counted) ledger row when it's later marked paid.
// Linking stays an explicit user action via POST /transactions/:id/confirm.
export const CreateTransactionResponseSchema = TransactionSchema.extend({
  rentMatch: RentMatchSuggestionSchema.nullable(),
});

// A confirmed transaction this pending item may duplicate (plan §D2): same
// type, exact amount, dated within ±3 days, vendors agreeing or absent on one
// side. Never auto-merged — rendered as a warning; the resolution is Dismiss
// (keep the confirmed row) or confirm anyway. rentPeriod set when the match
// backs a recorded rent payment ("the deposit behind rent you logged
// manually").
export const DuplicateSuggestionSchema = z.object({
  transactionId: z.string(),
  description: z.string(),
  date: z.string().datetime(),
  source: TransactionSourceSchema,
  rentPeriod: PeriodSchema.optional(),
});

// GET /transactions/review — pending_review items with their suggestion
// resolved to a display name.
export const ReviewQueueItemSchema = TransactionSchema.extend({
  aiSuggestedCategoryName: z.string().nullable(),
  rentMatch: RentMatchSuggestionSchema.nullable(),
  // Where the AI category suggestion came from. 'learned' = the account's own
  // vendor→category memory (a past correction) — the UI labels these so the
  // learning is visible. Omitted when unknown; derived fresh at read time.
  suggestionSource: z.enum(['learned', 'keyword', 'fallback']).optional(),
  possibleDuplicate: DuplicateSuggestionSchema.optional(),
});

// Review-queue filters — also the body of the bulk confirm-all/dismiss-all
// endpoints, so a bulk action applies to exactly the filtered set the user is
// looking at (all pages of it, not just the loaded one).
export const ReviewQueueFilterSchema = z.object({
  q: z.string().optional(), // case-insensitive match on description or vendor
  propertyId: z.string().optional(),
  type: TransactionTypeSchema.optional(),
  source: TransactionSourceSchema.optional(),
});

export const ReviewQueueQuerySchema = ReviewQueueFilterSchema.extend({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const ReviewQueueResponseSchema = z.object({
  items: z.array(ReviewQueueItemSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int(), // items matching the filter across all pages
});

// POST /transactions/review/confirm-all — confirms every filtered item with
// its AI-suggested category; items with no suggestion, below the bulk
// confidence threshold, with a rent match, or flagged as possible duplicates
// are skipped (those stay explicit per-item decisions).
export const ConfirmAllReviewResponseSchema = z.object({
  confirmed: z.number().int(),
  skipped: z.number().int(),
});

// POST /transactions/review/dismiss-all
export const DismissAllReviewResponseSchema = z.object({
  dismissed: z.number().int(),
});

// POST /transactions/receipt — pre-fills the form, never saves.
export const ReceiptScanResponseSchema = z.object({
  vendor: z.string().nullable(),
  amountCents: z.number().int().positive().nullable(),
  date: z.string().datetime().nullable(),
  suggestedCategoryId: z.string().nullable(),
  suggestedPropertyId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

// POST /transactions/import — Plaid pull into the review queue.
export const ImportTransactionsResponseSchema = z.object({
  imported: z.number().int(), // new pending_review rows created
  skipped: z.number().int(), // redelivered ids already present (incl. insert races)
  updated: z.number().int(), // Plaid `modified` applied to still-pending rows
  removed: z.number().int(), // Plaid `removed` deleted from still-pending rows
});
