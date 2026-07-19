-- Scheduler-generated report types (weekly_brief, monthly_review) must be
-- unique per (accountId, type, periodStart): concurrent runDailyJobs runs
-- (boot tick + CF cron waking a scaled-to-zero container) could otherwise both
-- pass the check-then-create and snapshot the same period twice, double-firing
-- notifications. Ordinary report types stay freely re-generatable for the same
-- period (each generation is a new snapshot), hence a PARTIAL unique index —
-- not expressible in schema.prisma; documented on the Report model.

-- Dedupe pre-existing duplicates first (prod may already carry duplicate
-- monthly_review rows from past concurrent runs) — keep the newest row.
DELETE FROM "Report" older
USING "Report" newer
WHERE older."type" IN ('weekly_brief', 'monthly_review')
  AND newer."accountId" = older."accountId"
  AND newer."type" = older."type"
  AND newer."periodStart" = older."periodStart"
  AND (
    newer."generatedAt" > older."generatedAt"
    OR (newer."generatedAt" = older."generatedAt" AND newer."id" > older."id")
  );

-- CreateIndex (partial unique)
CREATE UNIQUE INDEX "Report_scheduler_period_key"
  ON "Report"("accountId", "type", "periodStart")
  WHERE "type" IN ('weekly_brief', 'monthly_review');
