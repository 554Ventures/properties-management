import { z } from 'zod';
import { LeaseSchema } from './lease';
import { RentPaymentRowSchema } from './rent';

export const TenantSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  fullName: z.string(),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});

// Derived per ARCHITECTURE §4: late if any unpaid rent past due; else
// renew_soon if lease ends within 60 days; else current.
export const TenantStatusSchema = z.enum(['current', 'renew_soon', 'late']);

// POST /tenants
export const CreateTenantInputSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  notes: z.string().optional(),
});

// PATCH /tenants/:id
export const UpdateTenantInputSchema = CreateTenantInputSchema.partial();

// GET /tenants — row: tenant, unit/property, rentCents, leaseEndDate, status.
// Lease-derived fields are null when the tenant has no active lease.
export const TenantListRowSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  unitId: z.string().nullable(),
  unitLabel: z.string().nullable(),
  propertyId: z.string().nullable(),
  propertyLabel: z.string().nullable(),
  rentCents: z.number().int().nullable(),
  leaseEndDate: z.string().datetime().nullable(),
  status: TenantStatusSchema,
});

export const TenantListResponseSchema = z.array(TenantListRowSchema);

export const TenantDocumentSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  createdAt: z.string().datetime(),
});

// Lease with unit/property display context for the tenant detail page.
export const TenantLeaseSchema = LeaseSchema.extend({
  unitLabel: z.string(),
  propertyId: z.string(),
  propertyLabel: z.string(),
});

// GET /tenants/:id
export const TenantDetailResponseSchema = z.object({
  tenant: TenantSchema,
  leases: z.array(TenantLeaseSchema),
  paymentHistory: z.array(RentPaymentRowSchema),
  documents: z.array(TenantDocumentSchema),
});
