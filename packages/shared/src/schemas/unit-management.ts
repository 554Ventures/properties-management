import { z } from 'zod';
import { LeaseWithTenantsSchema, PnlSummarySchema, PropertyDetailUnitSchema } from './property';
import { RentPaymentRowSchema } from './rent';

// GET /units/:id — full unit detail. Lives here (not in unit.ts) to avoid a
// circular import: property.ts already imports unit.ts, so unit.ts must never
// import property.ts back. `unit` is the full PropertyDetailUnitSchema — the
// same enriched shape the property detail returns (rent snapshot, pendingLease,
// leaseCount) — so the two surfaces agree field-for-field. currentLease/leases
// reuse LeaseWithTenantsSchema (Lease + tenants only; property/unit context is
// already at the top level). No `insights` field: Insight has no unit scope
// (portfolio | property | tenant only), a real data gap rather than a wiring gap.
export const UnitDetailResponseSchema = z.object({
  unit: PropertyDetailUnitSchema,
  propertyId: z.string(),
  propertyLabel: z.string(),
  // Back-compat: these duplicate unit.status / unit.currentLease; kept while
  // clients migrate to reading occupancy and the current lease off `unit`.
  status: z.enum(['occupied', 'vacant']),
  currentLease: LeaseWithTenantsSchema.nullable(),
  leases: z.array(LeaseWithTenantsSchema), // full history, newest startDate first
  rentPayments: z.array(RentPaymentRowSchema), // across all of the unit's leases, newest dueDate first
  pnl: PnlSummarySchema,
});
