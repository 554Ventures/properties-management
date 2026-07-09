import { z } from 'zod';
import {
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
  aiSuggestedCategoryId: z.string().nullable(),
  aiConfidence: z.number().min(0).max(1).nullable(),
  receiptUrl: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
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
});

// PATCH /transactions/:id
export const UpdateTransactionInputSchema = CreateTransactionInputSchema.partial();

// POST /transactions/:id/confirm — rentPaymentId links the (income) transaction
// to that expected rent payment and marks it paid; property/unit then come from
// the lease and any propertyId/unitId here are ignored.
export const ConfirmTransactionInputSchema = z.object({
  categoryId: z.string().optional(), // override; omitted = accept the AI suggestion
  rentPaymentId: z.string().optional(),
  propertyId: z.string().optional(),
  unitId: z.string().optional(),
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
// expected rent — same amount, dated within a window of the due date.
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
  amountCents: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
});

// GET /transactions/review — pending_review items with their suggestion
// resolved to a display name.
export const ReviewQueueItemSchema = TransactionSchema.extend({
  aiSuggestedCategoryName: z.string().nullable(),
  rentMatch: RentMatchSuggestionSchema.nullable(),
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
// its AI-suggested category; items with no suggestion or with a rent match
// are skipped (rent linking stays an explicit per-item action).
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
