// Daily scheduled jobs (ARCHITECTURE §4), per account (deployment plan §4.3):
// once a new month has begun, snapshot a monthly_review Report for the
// previous month if none exists yet; once a new Mon-based week has begun,
// snapshot a weekly_brief Report for the last completed week; then refresh
// insights so new-month rules (dedupeKeys carry the period) fire without
// reseeding. Called by the in-process scheduler (server.ts) and the
// cron-triggered internal endpoint (routes/internal.ts). One account's
// failure never blocks the others. Scheduler notifications route through
// notification.service per-recipient prefs (F2).
import type { Report } from '@hearth/shared';
import { Prisma } from '@prisma/client';
import { addMonthsToPeriod, currentPeriodInTz, monthStartInTz } from '../lib/dates';
import { ImportRateLimitedError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { processScheduledDeletions } from './account.service';
import * as insightService from './insight.service';
import { notifyCategory } from './notification.service';
import { generateWeeklyBriefReport, lastCompletedWeekStartInTz } from './report.service';
import { importFromBank } from './transaction.service';

export interface DailyJobsResult {
  accountsProcessed: number;
  monthlyReviewsCreated: number;
  weeklyBriefsCreated: number;
  insightsCreated: number;
  bankTransactionsImported: number;
  accountsDeleted: number;
  errors: Array<{ accountId: string; message: string }>;
}

// Losing the (accountId, type, periodStart) partial unique on Report (migration
// report_period_unique) means a concurrent run already created this period's
// snapshot — the loser must skip its count and, critically, the notification.
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

// In-process singleflight: when the scaled-to-zero container wakes on the CF
// cron request, the boot tick (server.ts) and the /internal/run-daily-jobs
// handler call runDailyJobs at the same moment. Sharing one run prevents
// duplicate briefs/reviews and duplicate notifications (prod runs a single
// container, so in-process serialization suffices; the unique index below is
// the cross-process backstop).
let inFlight: Promise<DailyJobsResult> | null = null;

export function runDailyJobs(): Promise<DailyJobsResult> {
  if (!inFlight) {
    inFlight = doRunDailyJobs().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function doRunDailyJobs(): Promise<DailyJobsResult> {
  // Deletions first: an account past its grace period shouldn't get a fresh
  // monthly review/insight refresh moments before being hard-deleted.
  const deletions = await processScheduledDeletions();
  // Timezone loaded per account so each review's target month is computed on
  // that landlord's local calendar (WS4).
  const accounts = await prisma.account.findMany({ select: { id: true, timezone: true } });
  const result: DailyJobsResult = {
    accountsProcessed: accounts.length,
    monthlyReviewsCreated: 0,
    weeklyBriefsCreated: 0,
    insightsCreated: 0,
    bankTransactionsImported: 0,
    accountsDeleted: deletions.deleted,
    errors: [...deletions.errors],
  };
  const now = new Date();
  for (const { id: accountId, timezone } of accounts) {
    // "Last month" per this account's local calendar (WS4).
    const period = addMonthsToPeriod(currentPeriodInTz(timezone), -1);
    // Nightly bank-feed sync, before the insight refresh below so rows that
    // land tonight surface in tonight's review-queue insight. Gated on a
    // connected Integration row: mock Plaid needs no row to import, and
    // without the gate every pure-demo account would accrete mock rows
    // nightly. A cooldown skip (manual import earlier today) is expected;
    // any other sync failure is recorded but never blocks the account's
    // monthly review or insights.
    try {
      const bankFeed = await prisma.integration.findFirst({
        where: { accountId, type: { in: ['plaid', 'stripe_fc'] }, status: 'connected' },
      });
      if (bankFeed) {
        const counts = await importFromBank(accountId);
        result.bankTransactionsImported += counts.imported;
      }
    } catch (err) {
      if (!(err instanceof ImportRateLimitedError)) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ accountId, message: `bank sync: ${message}` });
        // Sync-health telemetry (WS5): bump the failure count + stamp the last
        // error on this account's connected bank feeds. A later successful sync
        // resets all three (transaction.service per-provider stamp). Surfaces
        // the bank_sync_failing insight (>= 3) + the Settings "last sync failed"
        // line. A cooldown skip is not a failure and is excluded above.
        await prisma.integration.updateMany({
          where: { accountId, type: { in: ['plaid', 'stripe_fc'] }, status: 'connected' },
          data: {
            syncFailureCount: { increment: 1 },
            lastSyncError: message,
            lastSyncErrorAt: new Date(),
          },
        });
      }
    }
    try {
      const existing = await prisma.report.findFirst({
        where: { accountId, type: 'monthly_review', periodStart: monthStartInTz(period, timezone) },
      });
      if (!existing) {
        let review: Report | null = null;
        try {
          review = await insightService.generateMonthlyReview(accountId, period);
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
        if (review) {
          result.monthlyReviewsCreated += 1;
          const row = await prisma.report.findUnique({ where: { id: review.id } });
          let bottomLine = '';
          try {
            bottomLine = String(JSON.parse(row?.dataJson ?? '{}').bottomLine ?? '');
          } catch {
            // A snapshot that doesn't parse just gets the generic email body.
          }
          await notifyCategory(accountId, 'monthly_review', {
            push: {
              title: 'Your monthly review is ready',
              body: review.title,
              deepLink: `/reports/${review.id}`,
            },
            email: {
              subject: review.title,
              // No deep links in email (no public-base-URL env var exists).
              body: `${bottomLine ? `${bottomLine}\n\n` : ''}Open 554 Properties → Reports for the full review.`,
            },
          });
        }
      }
      const newInsights = await insightService.generateInsights(accountId);
      result.insightsCreated += newInsights.length;
      // Notify only fresh warnings (late rent, expense spike) — info/positive
      // would be noise. dedupeKey guarantees an insight is "new" at most once,
      // so repeats can't re-notify. Delivery honors per-recipient prefs (F2).
      for (const insight of newInsights.filter((i) => i.severity === 'warning')) {
        await notifyCategory(accountId, 'warning_insights', {
          push: {
            title: insight.title,
            body: insight.body,
            deepLink: insight.actionTarget ?? '/',
          },
        });
      }
      // Weekly brief (W1): idempotent on periodStart. Catch-up-safe — a run
      // skipped for a few days self-heals on the next daily run, but only the
      // MOST RECENT completed Mon–Sun week is ever generated (no historical
      // backfill by design).
      const lastWeekStart = lastCompletedWeekStartInTz(now, timezone);
      const existingBrief = await prisma.report.findFirst({
        where: { accountId, type: 'weekly_brief', periodStart: lastWeekStart },
      });
      if (!existingBrief) {
        let brief: Report | null = null;
        try {
          brief = await generateWeeklyBriefReport(accountId, lastWeekStart);
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
        if (brief) {
          result.weeklyBriefsCreated += 1;
          const briefRow = await prisma.report.findUnique({ where: { id: brief.id } });
          let headline = brief.title;
          let emailBody = 'Open 554 Properties → Reports for the full brief.';
          try {
            const data = JSON.parse(briefRow?.dataJson ?? '{}') as {
              headline?: string;
              summary?: string;
              items?: Array<{ text?: string }>;
            };
            if (data.headline) headline = data.headline;
            const itemLines = (data.items ?? [])
              .map((i) => (i.text ? `• ${i.text}` : null))
              .filter(Boolean)
              .join('\n');
            emailBody = `${data.headline ?? ''}\n\n${data.summary ?? ''}\n\n${itemLines}\n\nOpen 554 Properties → Reports for the full brief.`.trim();
          } catch {
            // Fall back to the generic body.
          }
          await notifyCategory(accountId, 'weekly_brief', {
            push: {
              title: 'Your weekly brief is ready',
              body: headline,
              deepLink: `/reports/${brief.id}`,
            },
            email: { subject: brief.title, body: emailBody },
          });
        }
      }
    } catch (err) {
      result.errors.push({
        accountId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
