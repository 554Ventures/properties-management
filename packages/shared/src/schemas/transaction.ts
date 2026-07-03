import { z } from 'zod';
import {
  TransactionSourceSchema,
  TransactionStatusSchema,
  TransactionTypeSchema,
} from '../enums';

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

// POST /transactions/:id/confirm
export const ConfirmTransactionInputSchema = z.object({
  categoryId: z.string().optional(), // override; omitted = accept the AI suggestion
});

// GET /transactions query filters — also reused verbatim by the MCP
// `list_transactions` tool (ARCHITECTURE §7).
export const TransactionListQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  propertyId: z.string().optional(),
  type: TransactionTypeSchema.optional(),
  status: TransactionStatusSchema.optional(),
  categoryId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const TransactionListResponseSchema = z.object({
  items: z.array(TransactionSchema),
  nextCursor: z.string().nullable(),
});

// GET /transactions/review — pending_review items with their suggestion
// resolved to a display name.
export const ReviewQueueItemSchema = TransactionSchema.extend({
  aiSuggestedCategoryName: z.string().nullable(),
});

export const ReviewQueueResponseSchema = z.object({
  items: z.array(ReviewQueueItemSchema),
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

// POST /transactions/import — mock Plaid pull into the review queue.
export const ImportTransactionsResponseSchema = z.object({
  imported: z.number().int(),
});
