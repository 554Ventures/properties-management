// Property valuations — the asset side of real equity (PLAN-REAL-EQUITY §2).
// Append-only history; the figure in use is always "latest as of a date",
// derived rather than stored. Every value is owner-entered (the PRD excludes
// external estimate integrations), so surfaces must say so.
import { z } from 'zod';
import { ValuationSourceSchema } from '../enums';

export const PropertyValuationSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  propertyId: z.string(),
  valueCents: z.number().int(),
  asOfDate: z.string().datetime(),
  source: ValuationSourceSchema,
  notes: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type PropertyValuation = z.infer<typeof PropertyValuationSchema>;

// POST /properties/:id/valuations
export const CreatePropertyValuationInputSchema = z.object({
  valueCents: z.number().int().min(0),
  asOfDate: z.string().datetime(),
  source: ValuationSourceSchema,
  notes: z.string().optional(),
});
export type CreatePropertyValuationInput = z.infer<typeof CreatePropertyValuationInputSchema>;
