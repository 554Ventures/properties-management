import { z } from 'zod';
import { EsignStatusSchema, LeaseStatusSchema } from '../enums';

export const LeaseSchema = z.object({
  id: z.string(),
  unitId: z.string(),
  rentCents: z.number().int(),
  dueDay: z.number().int().min(1).max(31),
  // Per-lease late-fee override (WS7). null = use the account default;
  // 0 = explicitly no late fee for this lease.
  lateFeeCents: z.number().int().nonnegative().nullable(),
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
  // Optional per-lease late-fee override (WS7): omitted → account default;
  // 0 → explicitly none for this lease; positive → this fee overrides the default.
  lateFeeCents: z.number().int().nonnegative().nullable().optional(),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
});

// PATCH /leases/:id
export const UpdateLeaseInputSchema = z.object({
  rentCents: z.number().int().positive().optional(),
  dueDay: z.number().int().min(1).max(31).optional(),
  // omitted → unchanged; null → clear back to the account default; positive/0 → set.
  lateFeeCents: z.number().int().nonnegative().nullable().optional(),
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
