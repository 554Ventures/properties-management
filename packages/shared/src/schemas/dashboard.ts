import { z } from 'zod';
import { InsightSchema } from './insight';

// GET /dashboard/kpis — trend fields are the pct change vs. the same
// day-of-month window of the prior month (ARCHITECTURE §4).
export const DashboardKpisResponseSchema = z.object({
  netCashFlowMtdCents: z.number().int(),
  netCashFlowTrendPct: z.number(),
  rentCollectedPct: z.number(), // 0–100, paidUnits / totalUnits
  rentCollectedTrendPct: z.number(),
  paidUnits: z.number().int(),
  totalUnits: z.number().int(),
  expensesMtdCents: z.number().int(),
  expensesTrendPct: z.number(),
  // Estimate only — UI carries the PRD §13.4 disclaimer.
  taxSetAside: z.object({
    currentCents: z.number().int(),
    targetCents: z.number().int(),
  }),
});

// GET /dashboard/cashflow-series?months=6
export const IncomeExpensePointSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected "YYYY-MM"'),
  incomeCents: z.number().int(),
  expenseCents: z.number().int(),
});

export const IncomeExpenseSeriesResponseSchema = z.array(IncomeExpensePointSchema);

// GET /dashboard/expense-breakdown — this month's confirmed expenses grouped
// by category (decomposes the "Expenses (MTD)" KPI). Slices are sorted
// descending; categories past the top few fold into a single "Other" bucket.
export const ExpenseBreakdownSliceSchema = z.object({
  categoryId: z.string().nullable(), // null = uncategorized, or the folded "Other" bucket
  categoryName: z.string(),
  amountCents: z.number().int(),
});

export const ExpenseBreakdownResponseSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected "YYYY-MM"'),
  totalCents: z.number().int(),
  slices: z.array(ExpenseBreakdownSliceSchema),
});

// GET /dashboard/noi-by-property — this month's operating income per property
// (directly-attributed confirmed income − expense). Portfolio-level (unassigned)
// transactions can't be attributed to one property, so they surface as the
// separate `unassigned` bucket (present only when nonzero) — that way
// sum(properties.noiCents) + unassigned.noiCents reconciles exactly with the
// dashboard KPI net, which has always included them.
// Sorted descending by noiCents.
export const PropertyNoiSchema = z.object({
  propertyId: z.string(),
  label: z.string(), // nickname or addressLine1
  incomeCents: z.number().int(),
  expenseCents: z.number().int(),
  noiCents: z.number().int(),
});

export const UnassignedNoiSchema = z.object({
  incomeCents: z.number().int(),
  expenseCents: z.number().int(),
  noiCents: z.number().int(),
});

export const PropertyNoiResponseSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected "YYYY-MM"'),
  properties: z.array(PropertyNoiSchema),
  unassigned: UnassignedNoiSchema.optional(), // omitted when all-zero
});

// GET /dashboard/activity?limit=10
export const ActivityKindSchema = z.enum([
  'transaction',
  'rent_payment',
  'reminder',
  'report',
  'insight',
]);

export const ActivityItemSchema = z.object({
  id: z.string(),
  kind: ActivityKindSchema,
  text: z.string(),
  at: z.string().datetime(),
  link: z.string().nullable(), // frontend route
});

export const ActivityListResponseSchema = z.array(ActivityItemSchema);

// GET /dashboard/insight — today's single card (highest severity, newest).
export const DashboardInsightResponseSchema = InsightSchema.nullable();
