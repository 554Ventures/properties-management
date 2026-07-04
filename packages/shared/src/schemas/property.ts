import { z } from 'zod';
import { TransactionTypeSchema } from '../enums';
import { InsightSchema } from './insight';
import { LeaseSchema } from './lease';
import { TenantSchema } from './tenant';
import { CreateUnitInputSchema, UnitSchema } from './unit';

export const PropertySchema = z.object({
  id: z.string(),
  accountId: z.string(),
  nickname: z.string().nullable(),
  addressLine1: z.string(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
  acquisitionDate: z.string().datetime().nullable(),
  acquisitionCostCents: z.number().int().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});

// POST /properties
export const CreatePropertyInputSchema = z.object({
  nickname: z.string().optional(),
  addressLine1: z.string().min(1),
  city: z.string().min(1),
  state: z.string().min(1),
  zip: z.string().min(1),
  acquisitionDate: z.string().datetime().optional(),
  acquisitionCostCents: z.number().int().min(0).optional(),
  notes: z.string().optional(),
  units: z.array(CreateUnitInputSchema).min(1),
});

// PATCH /properties/:id (units are managed via the unit endpoints)
export const UpdatePropertyInputSchema = CreatePropertyInputSchema.omit({ units: true }).partial();

// GET /properties — property + derived stats.
export const PropertyWithStatsSchema = PropertySchema.extend({
  unitCount: z.number().int(),
  occupiedCount: z.number().int(),
  monthlyRentCents: z.number().int(),
  statusLabel: z.string(), // e.g. "Full" / "1 vacant" / "1 late"
});

export const PropertyListResponseSchema = z.array(PropertyWithStatsSchema);

export const PnlTotalsSchema = z.object({
  incomeCents: z.number().int(),
  expenseCents: z.number().int(),
  netCents: z.number().int(),
});

export const PnlSummarySchema = z.object({
  mtd: PnlTotalsSchema,
  ytd: PnlTotalsSchema,
});

// GET /properties/:id/pnl?from&to — income/expense by category + net.
export const PnlCategoryLineSchema = z.object({
  categoryId: z.string().nullable(), // null = uncategorized
  categoryName: z.string(),
  type: TransactionTypeSchema,
  totalCents: z.number().int(),
});

export const PropertyPnlResponseSchema = z.object({
  propertyId: z.string(),
  from: z.string().datetime(),
  to: z.string().datetime(),
  incomeCents: z.number().int(),
  expenseCents: z.number().int(),
  netCents: z.number().int(),
  lines: z.array(PnlCategoryLineSchema),
});

export const LeaseWithTenantsSchema = LeaseSchema.extend({
  tenants: z.array(TenantSchema),
});

// Occupancy derived: occupied iff an active lease exists.
export const PropertyDetailUnitSchema = UnitSchema.extend({
  status: z.enum(['occupied', 'vacant']),
  currentLease: LeaseWithTenantsSchema.nullable(),
});

// GET /properties/:id
export const PropertyDetailResponseSchema = z.object({
  property: PropertySchema,
  units: z.array(PropertyDetailUnitSchema),
  pnl: PnlSummarySchema,
  insights: z.array(InsightSchema),
});
