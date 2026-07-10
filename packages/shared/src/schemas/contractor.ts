import { z } from 'zod';

export const ContractorSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string(),
  trade: z.string(),
  rating: z.number().min(1).max(5).nullable(),
  phone: z.string().nullable(),
  email: z.string().email().nullable(),
  // Free text — landlords paste bare domains ("riveraplumbing.com"); the UI
  // prefixes a scheme when rendering the link.
  website: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});

// POST /contractors
export const CreateContractorInputSchema = z.object({
  name: z.string().trim().min(1),
  trade: z.string().trim().min(1),
  rating: z.number().min(1).max(5).optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  website: z.string().optional(),
  notes: z.string().optional(),
});

// PATCH /contractors/:id — omitted fields are unchanged; explicit null clears
// an optional field (name/trade can never be cleared, only replaced).
export const UpdateContractorInputSchema = z.object({
  name: z.string().trim().min(1).optional(),
  trade: z.string().trim().min(1).optional(),
  rating: z.number().min(1).max(5).nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  website: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

// GET /contractors — row with usage stats. Derived per ARCHITECTURE §4:
// jobsCount/avgCostCents/lastUsedAt come from confirmed expense transactions
// whose vendor matches the contractor name (case/whitespace-insensitive);
// all three are null-or-zero together when no expense history matches.
export const ContractorListRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  trade: z.string(),
  rating: z.number().min(1).max(5).nullable(),
  phone: z.string().nullable(),
  email: z.string().email().nullable(),
  website: z.string().nullable(),
  notes: z.string().nullable(),
  jobsCount: z.number().int(),
  avgCostCents: z.number().int().nullable(),
  lastUsedAt: z.string().datetime().nullable(),
});

export const ContractorListResponseSchema = z.array(ContractorListRowSchema);

// One matched expense transaction in a contractor's derived job history.
export const ContractorJobRowSchema = z.object({
  id: z.string(),
  date: z.string().datetime(),
  description: z.string(),
  amountCents: z.number().int(),
  propertyLabel: z.string().nullable(),
});

// GET /contractors/:id — stats derive from the same vendor-name match as the
// list rows; jobs is that match ordered newest first.
export const ContractorDetailResponseSchema = z.object({
  contractor: ContractorSchema,
  jobsCount: z.number().int(),
  avgCostCents: z.number().int().nullable(),
  lastUsedAt: z.string().datetime().nullable(),
  jobs: z.array(ContractorJobRowSchema),
});

// POST /contractors/:id/jobs — manually log a job. This creates a real
// confirmed expense transaction (vendor = contractor name), so job history
// stays 100% derived from transactions per ARCHITECTURE §4 — there is no
// separate job ledger. Duplicate detection mirrors the review queue's
// rent-match heuristic (computed at request time, never auto-applied): if a
// confirmed expense already matching this contractor falls within a few days
// of the given date, nothing is created — the candidates come back instead —
// until the caller resubmits with confirmDuplicate: true.
export const LogContractorJobInputSchema = z.object({
  date: z.string().datetime(),
  description: z.string().trim().min(1),
  amountCents: z.number().int().positive(),
  propertyId: z.string().optional(),
  confirmDuplicate: z.boolean().optional(),
});

export const LogContractorJobResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('created'), job: ContractorJobRowSchema }),
  z.object({ status: z.literal('possible_duplicate'), duplicates: z.array(ContractorJobRowSchema) }),
]);
