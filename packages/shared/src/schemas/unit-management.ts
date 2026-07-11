import { z } from 'zod';
import { LeaseWithTenantsSchema, PnlSummarySchema } from './property';
import { RentPaymentRowSchema } from './rent';
import { UnitSchema } from './unit';

// GET /units/:id — full unit detail. Lives here (not in unit.ts) to avoid a
// circular import: property.ts already imports unit.ts, so unit.ts must never
// import property.ts back. currentLease/leases reuse LeaseWithTenantsSchema
// (Lease + tenants only — property/unit context is already at the top level),
// the same convention PropertyDetailUnitSchema uses. No `insights` field:
// Insight has no unit scope (portfolio | property | tenant only), a real data
// gap rather than a wiring gap.
export const UnitDetailResponseSchema = z.object({
  unit: UnitSchema,
  propertyId: z.string(),
  propertyLabel: z.string(),
  status: z.enum(['occupied', 'vacant']),
  currentLease: LeaseWithTenantsSchema.nullable(),
  leases: z.array(LeaseWithTenantsSchema), // full history, newest startDate first
  rentPayments: z.array(RentPaymentRowSchema), // across all of the unit's leases, newest dueDate first
  pnl: PnlSummarySchema,
});
