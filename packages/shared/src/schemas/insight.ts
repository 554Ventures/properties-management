import { z } from 'zod';
import { InsightScopeSchema, InsightSeveritySchema, InsightStatusSchema } from '../enums';

export const InsightSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  scope: InsightScopeSchema,
  type: z.string(), // rule id, e.g. "late_rent", "expense_spike", "renewal_window", "underperforming_property"
  severity: InsightSeveritySchema,
  title: z.string(),
  body: z.string(),
  actionLabel: z.string().nullable(),
  actionTarget: z.string().nullable(), // frontend route or API action ref
  propertyId: z.string().nullable(),
  tenantId: z.string().nullable(),
  leaseId: z.string().nullable(),
  dedupeKey: z.string(),
  status: InsightStatusSchema,
  createdAt: z.string().datetime(),
});

// GET /insights
export const InsightListResponseSchema = z.array(InsightSchema);
