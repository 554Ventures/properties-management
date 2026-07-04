// Per-route request/response schema hub (ARCHITECTURE §3). Every schema named
// in the API contract is exported from here, grouped by resource.
import { z } from 'zod';

// Error envelope for every non-2xx response: { error: { code, message, fields? } }
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.record(z.string()).optional(),
  }),
});

// Settings / account
export * from './account';

// Properties (incl. PnL shapes, PropertyWithStats, detail composites)
export * from './property';

// Units
export * from './unit';

// Tenants
export * from './tenant';

// Leases (incl. renewal draft + e-sign)
export * from './lease';

// Lease management composites (detail, tenant add, renewal accept)
export * from './lease-management';

// Transactions (incl. review queue, receipt scan, bank import)
export * from './transaction';

// Categories
export * from './category';

// Rent (tracker, payments, payment links, reminders)
export * from './rent';

// Reports (library, generate, detail, email)
export * from './report';

// Insights
export * from './insight';

// Dashboard (KPIs, cashflow series, activity, daily insight)
export * from './dashboard';

// Integrations
export * from './integration';

// Chat content blocks + sessions/messages + SSE protocol
export * from './chat-blocks';
export * from './chat';
