import { z } from 'zod';
import { LeaseSchema } from './lease';
import { RentPaymentRowSchema } from './rent';
import { TenantOnLeaseSchema } from './tenant';

// Lease with unit/property display context + embedded tenants. Lives here (not
// in lease.ts) to avoid the tenant.ts → lease.ts circular import: lease.ts must
// never import tenant.ts.
export const LeaseWithContextSchema = LeaseSchema.extend({
  unitLabel: z.string(),
  propertyId: z.string(),
  propertyLabel: z.string(),
  tenants: z.array(TenantOnLeaseSchema),
});

// GET /leases/:id
export const LeaseDetailResponseSchema = z.object({
  lease: LeaseWithContextSchema,
  rentPayments: z.array(RentPaymentRowSchema),
});

// POST /leases/:id/tenants
export const AddLeaseTenantInputSchema = z.object({
  tenantId: z.string(),
  isPrimary: z.boolean().optional(),
  shareCents: z.number().int().nonnegative().optional(), // expected portion of the rent
});

// PATCH /leases/:id/tenants/:tenantId — set/clear a co-tenant's expected
// share (null clears back to the even-split display fallback). Shares that
// don't sum to the rent are a soft warning in the UI, never a hard block.
export const UpdateLeaseTenantShareInputSchema = z.object({
  shareCents: z.number().int().nonnegative().nullable(),
});

// POST /leases/:id/renewal
export const AcceptRenewalInputSchema = z.object({
  rentCents: z.number().int().positive(),
  dueDay: z.number().int().min(1).max(31),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  tenantIds: z.array(z.string()).min(1).optional(),
});
