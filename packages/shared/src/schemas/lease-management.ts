import { z } from 'zod';
import { LeaseSchema } from './lease';
import { RentPaymentRowSchema } from './rent';
import { TenantSchema } from './tenant';

// Lease with unit/property display context + embedded tenants. Lives here (not
// in lease.ts) to avoid the tenant.ts → lease.ts circular import: lease.ts must
// never import tenant.ts.
export const LeaseWithContextSchema = LeaseSchema.extend({
  unitLabel: z.string(),
  propertyId: z.string(),
  propertyLabel: z.string(),
  tenants: z.array(TenantSchema),
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
});

// POST /leases/:id/renewal
export const AcceptRenewalInputSchema = z.object({
  rentCents: z.number().int().positive(),
  dueDay: z.number().int().min(1).max(31),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  tenantIds: z.array(z.string()).min(1).optional(),
});
