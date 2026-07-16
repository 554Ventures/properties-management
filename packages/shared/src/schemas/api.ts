// Per-route request/response schema hub (ARCHITECTURE §3). Every schema named
// in the API contract is exported from here, grouped by resource.
import { z } from 'zod';

// Error envelope for every non-2xx response: { error: { code, message, fields?, detail? } }
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.record(z.string()).optional(),
    detail: z.record(z.string()).optional(), // structured context, e.g. import_rate_limited's nextAllowedAt
  }),
});

// Settings / account
export * from './account';

// Team / multi-user account (members, invites, per-member permissions)
export * from './team';

// Privacy Policy / ToS consent capture
export * from './consent';

// Properties (incl. PnL shapes, PropertyWithStats, detail composites)
export * from './property';

// Units
export * from './unit';

// Unit management composites (detail: lease history, payments, P&L)
export * from './unit-management';

// Tenants
export * from './tenant';

// Leases (incl. renewal draft + e-sign)
export * from './lease';

// Lease management composites (detail, tenant add, renewal accept)
export * from './lease-management';

// Contractors (maintenance directory; list rows carry derived usage stats)
export * from './contractor';

// Transactions (incl. review queue, receipt scan, bank import)
export * from './transaction';

// Bank-sync discrepancies (post-confirm bank corrections surface + sync health)
export * from './bank-discrepancy';

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

// Push notification devices (mobile shell)
export * from './device';

// Onboarding (getting-started checklist for new accounts)
export * from './onboarding';

// Documents (uploaded files attached to entities)
export * from './document';

// Chat content blocks + sessions/messages + SSE protocol
export * from './chat-blocks';
export * from './chat';
