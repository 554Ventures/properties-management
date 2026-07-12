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
  lastSyncedAt: z.string().datetime().nullable(), // plaid: last transaction import
  createdAt: z.string().datetime(),
});

// GET /integrations
export const IntegrationListResponseSchema = z.array(IntegrationSchema);

// POST /integrations/plaid/link-token
export const LinkTokenResponseSchema = z.object({
  linkToken: z.string(),
  mock: z.boolean(),
});

// POST /integrations/plaid/exchange
export const ExchangePublicTokenInputSchema = z.object({
  publicToken: z.string(),
});

// POST /integrations/stripe_fc/session — the publishable key rides along so
// the web bundle needs no Stripe build-time env; `mock` mirrors Plaid's
// LinkTokenResponse and tells the client to skip the Stripe.js modal.
export const StripeFcSessionResponseSchema = z.object({
  clientSecret: z.string(),
  sessionId: z.string(),
  publishableKey: z.string(),
  mock: z.boolean(),
});

// POST /integrations/stripe_fc/complete
export const StripeFcCompleteInputSchema = z.object({
  sessionId: z.string(),
});
