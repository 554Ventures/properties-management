import { z } from 'zod';
import { InsightActionSchema } from './insight';
import { ReportSchema } from './report';

// One actionable line of the weekly brief. Same action vocabulary as insight
// cards, so the web app gates api_call actions through the one allowlist —
// the server only ever emits already-allowlisted paths (built from its own
// candidate list, never model-authored).
export const WeeklyBriefItemSchema = z.object({
  text: z.string(),
  action: InsightActionSchema.nullable(),
});
export type WeeklyBriefItem = z.infer<typeof WeeklyBriefItemSchema>;

// Report.dataJson shape for type 'weekly_brief' (extra snapshot keys like the
// generic `table` may ride along in storage; this is the rendered contract).
export const WeeklyBriefDataSchema = z.object({
  weekStart: z.string().datetime(),
  weekEnd: z.string().datetime(), // exclusive
  weekLabel: z.string(), // e.g. "Jul 13 – Jul 19, 2026"
  headline: z.string(),
  summary: z.string(), // 1-3 short plain-text paragraphs, \n\n separated
  items: z.array(WeeklyBriefItemSchema).min(1).max(4),
  stats: z.object({
    rentCollectedCents: z.number().int(),
    rentOutstandingCents: z.number().int(),
    lateCount: z.number().int(),
    newTransactionCount: z.number().int(),
    pendingReviewCount: z.number().int(),
    leasesEndingSoonCount: z.number().int(),
  }),
});
export type WeeklyBriefData = z.infer<typeof WeeklyBriefDataSchema>;

// GET /reports/weekly-brief/latest — null body when no brief exists yet.
export const WeeklyBriefLatestResponseSchema = z
  .object({ report: ReportSchema, brief: WeeklyBriefDataSchema })
  .nullable();
export type WeeklyBriefLatestResponse = z.infer<typeof WeeklyBriefLatestResponseSchema>;
