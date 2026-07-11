import { z } from 'zod';
import { InsightScopeSchema, InsightSeveritySchema, InsightStatusSchema } from '../enums';
import { ApiCallActionSchema, NavigateActionSchema } from './chat-blocks';

// Structured, executable insight action — same action vocabulary as chat
// action cards, so the web app gates api_call actions through the one
// allowlist. Additive: legacy actionLabel/actionTarget stay for old rows and
// for push-notification deep links (actionTarget is always a route).
export const InsightActionSchema = z.object({
  label: z.string(),
  action: z.discriminatedUnion('kind', [ApiCallActionSchema, NavigateActionSchema]),
});

export const InsightSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  scope: InsightScopeSchema,
  type: z.string(), // rule id, e.g. "late_rent", "expense_spike", "renewal_window", "underperforming_property"
  severity: InsightSeveritySchema,
  title: z.string(),
  body: z.string(),
  actionLabel: z.string().nullable(),
  actionTarget: z.string().nullable(), // frontend route (also the push deep link)
  // Optional AND nullable so pre-existing payloads and persisted rows parse.
  action: InsightActionSchema.nullable().optional(),
  propertyId: z.string().nullable(),
  tenantId: z.string().nullable(),
  leaseId: z.string().nullable(),
  dedupeKey: z.string(),
  status: InsightStatusSchema,
  createdAt: z.string().datetime(),
});

// GET /insights
export const InsightListResponseSchema = z.array(InsightSchema);
