// Recurring transaction templates (PLAN-REAL-EQUITY §2, Phase 2b). A template
// is a standing instruction, never a ledger row: the daily jobs loop drafts the
// most recent due occurrence into the review queue as `pending_review` with
// source `recurring`, and the user confirms it. Nothing is ever auto-confirmed,
// because a template asserts what you *expect* to be charged — the bank says
// what you actually were.
//
// A mortgage template additionally stamps the principal carve-out onto the row
// it drafts, so the breakdown is pre-filled from what the user already told us
// once rather than retyped monthly. It is still their number, never computed
// (decision D4).
import { z } from 'zod';
import { RecurrenceCadenceSchema, TransactionTypeSchema } from '../enums';

/**
 * A calendar date with no time and no zone — `2026-09-01`.
 *
 * Every date in this file is one of these, `anchorDate` included. That is not
 * incidental: "due on the 1st" is a statement about the landlord's calendar,
 * not about an instant. Carrying an anchor as a datetime means the client picks
 * a day, serializes it as UTC midnight, and the server reads it back in the
 * account's timezone as the *previous* day — so a template the user set to the
 * 1st silently recurs on the 31st, in the wrong month, with the day then
 * wandering 30/31 as clamping applies. The zone belongs at the edges (the
 * server anchors to local midnight when it dates a drafted row), never in the
 * schedule itself.
 */
export const CalendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date');

export const RecurringTemplateSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  description: z.string(),
  vendor: z.string().nullable(),
  propertyId: z.string().nullable(),
  unitId: z.string().nullable(),
  categoryId: z.string().nullable(),
  type: TransactionTypeSchema,
  amountCents: z.number().int(),
  cadence: RecurrenceCadenceSchema,
  /** First occurrence, as a calendar date; later ones add the cadence. */
  anchorDate: CalendarDateSchema,
  mortgageId: z.string().nullable(),
  principalCents: z.number().int().nullable(),
  // Both of these are CALENDAR DATES, not instants, and the regex says so
  // rather than leaving it to a comment: an occurrence is "the 1st" on the
  // landlord's own calendar, and anything that parses one as a UTC datetime
  // renders the day before for every viewer west of UTC.
  /** `YYYY-MM-DD` of the last occurrence drafted — the idempotency marker. */
  lastDraftedOccurrence: CalendarDateSchema.nullable(),
  /** Derived: the next occurrence on or after today, in the account's timezone.
   *  Null for a paused template — it promises nothing. */
  nextOccurrence: CalendarDateSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** Archived = paused. Restoring never backfills the occurrences it missed. */
  archivedAt: z.string().datetime().nullable(),
});
export type RecurringTemplate = z.infer<typeof RecurringTemplateSchema>;

// POST /recurring-templates
export const CreateRecurringTemplateInputSchema = z.object({
  description: z.string().min(1),
  vendor: z.string().optional(),
  propertyId: z.string().optional(),
  unitId: z.string().optional(),
  categoryId: z.string().optional(),
  type: TransactionTypeSchema,
  amountCents: z.number().int().positive(),
  cadence: RecurrenceCadenceSchema,
  anchorDate: CalendarDateSchema,
  // Mortgage breakdown carried onto every drafted row. The service enforces the
  // same rules the ledger does: principal needs a mortgage, needs an expense,
  // and can't exceed the amount.
  mortgageId: z.string().optional(),
  principalCents: z.number().int().min(0).optional(),
});
export type CreateRecurringTemplateInput = z.infer<typeof CreateRecurringTemplateInputSchema>;

/**
 * PATCH /recurring-templates/:id — every field optional, same rules, plus an
 * explicit way to REMOVE the optional ones.
 *
 * `.partial()` alone cannot express "clear this": omitting a key and clearing it
 * are the same request once `JSON.stringify` drops `undefined`, so detaching a
 * mortgage or moving a template back to portfolio-level would report success and
 * change nothing — and a mortgage that stays attached keeps stamping principal
 * onto every drafted row. `null` means remove.
 */
export const UpdateRecurringTemplateInputSchema = CreateRecurringTemplateInputSchema.partial().extend({
  vendor: z.string().nullable().optional(),
  propertyId: z.string().nullable().optional(),
  unitId: z.string().nullable().optional(),
  categoryId: z.string().nullable().optional(),
  mortgageId: z.string().nullable().optional(),
  principalCents: z.number().int().min(0).nullable().optional(),
});
export type UpdateRecurringTemplateInput = z.infer<typeof UpdateRecurringTemplateInputSchema>;

// GET /recurring-templates
export const RecurringTemplateListResponseSchema = z.array(RecurringTemplateSchema);
export type RecurringTemplateListResponse = z.infer<typeof RecurringTemplateListResponseSchema>;
