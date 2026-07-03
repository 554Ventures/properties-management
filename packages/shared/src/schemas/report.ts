import { z } from 'zod';
import { ReportTypeSchema } from '../enums';

// Archive shape — dataJson is intentionally excluded from list responses.
export const ReportSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  type: ReportTypeSchema,
  title: z.string(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  taxYear: z.number().int().nullable(),
  propertyId: z.string().nullable(), // null = portfolio
  generatedAt: z.string().datetime(),
});

// GET /reports?type&taxYear
export const ReportListResponseSchema = z.array(ReportSchema);

// GET /reports/:id — with parsed dataJson snapshot (shape varies by type).
export const ReportDetailResponseSchema = ReportSchema.extend({
  data: z.unknown(),
});

// Resolved decision #5: some report types get real computed data, the rest
// get structurally-correct simplified outputs.
export const ReportMaturitySchema = z.enum(['full', 'simplified']);

export const ReportFilterSchema = z.enum(['taxYear', 'dateRange', 'property']);

// GET /reports/library
export const ReportTypeInfoSchema = z.object({
  type: ReportTypeSchema,
  name: z.string(),
  description: z.string(),
  maturity: ReportMaturitySchema,
  supportedFilters: z.array(ReportFilterSchema),
});

export const ReportLibraryResponseSchema = z.array(ReportTypeInfoSchema);

// POST /reports/generate — type + (taxYear | from/to) + optional propertyId.
export const GenerateReportInputSchema = z.object({
  type: ReportTypeSchema,
  taxYear: z.number().int().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  propertyId: z.string().optional(),
});

// POST /reports/:id/email — mock email, responds 202.
export const EmailReportInputSchema = z.object({
  to: z.string().email(),
});
