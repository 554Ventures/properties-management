import { z } from 'zod';
import { IntegrationStatusSchema, IntegrationTypeSchema } from '../enums';

export const IntegrationSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  type: IntegrationTypeSchema,
  name: z.string(),
  status: IntegrationStatusSchema,
  externalRef: z.string().nullable(),
  scopes: z.array(z.string()), // parsed from scopesJson
  createdAt: z.string().datetime(),
});

// GET /integrations
export const IntegrationListResponseSchema = z.array(IntegrationSchema);
