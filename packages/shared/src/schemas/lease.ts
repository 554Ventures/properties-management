import { z } from 'zod';
import { EsignStatusSchema, LeaseStatusSchema } from '../enums';

export const LeaseSchema = z.object({
  id: z.string(),
  unitId: z.string(),
  rentCents: z.number().int(),
  dueDay: z.number().int().min(1).max(31),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  status: LeaseStatusSchema,
  esignEnvelopeId: z.string().nullable(),
  esignStatus: EsignStatusSchema.nullable(),
  createdAt: z.string().datetime(),
});

// GET /leases?status
export const LeaseListResponseSchema = z.array(LeaseSchema);

// POST /leases
export const CreateLeaseInputSchema = z.object({
  unitId: z.string(),
  tenantIds: z.array(z.string()).min(1),
  rentCents: z.number().int().positive(),
  dueDay: z.number().int().min(1).max(31).default(1),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
});

// PATCH /leases/:id
export const UpdateLeaseInputSchema = z.object({
  rentCents: z.number().int().positive().optional(),
  dueDay: z.number().int().min(1).max(31).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  status: LeaseStatusSchema.optional(),
});

// POST /leases/:id/renewal-draft — proposal only; sending is a separate step.
export const RenewalDraftResponseSchema = z.object({
  leaseId: z.string(),
  currentRentCents: z.number().int(),
  suggestedRentCents: z.number().int(), // market-rent heuristic
  marketRentCents: z.number().int().nullable(),
  proposedStartDate: z.string().datetime(),
  proposedEndDate: z.string().datetime(),
  dueDay: z.number().int().min(1).max(31),
});

// POST /leases/:id/esign — mock Docusign envelope.
export const EsignEnvelopeResponseSchema = z.object({
  leaseId: z.string(),
  envelopeId: z.string(),
  status: EsignStatusSchema,
  sentAt: z.string().datetime(),
});
