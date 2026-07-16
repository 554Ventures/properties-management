// Daily scheduled jobs (ARCHITECTURE §4), per account (deployment plan §4.3):
// once a new month has begun, snapshot a monthly_review Report for the
// previous month if none exists yet, then refresh insights so new-month rules
// (dedupeKeys carry the period) fire without reseeding. Called by the
// in-process scheduler (server.ts) and the cron-triggered internal endpoint
// (routes/internal.ts). One account's failure never blocks the others.
import { addMonthsToPeriod, currentPeriodInTz, monthStartInTz } from '../lib/dates';
import { ImportRateLimitedError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { processScheduledDeletions } from './account.service';
import * as insightService from './insight.service';
import { notifyAccount } from './push.service';
import { importFromBank } from './transaction.service';

export interface DailyJobsResult {
  accountsProcessed: number;
  monthlyReviewsCreated: number;
  insightsCreated: number;
  bankTransactionsImported: number;
  accountsDeleted: number;
  errors: Array<{ accountId: string; message: string }>;
}

export async function runDailyJobs(): Promise<DailyJobsResult> {
  // Deletions first: an account past its grace period shouldn't get a fresh
  // monthly review/insight refresh moments before being hard-deleted.
  const deletions = await processScheduledDeletions();
  // Timezone loaded per account so each review's target month is computed on
  // that landlord's local calendar (WS4).
  const accounts = await prisma.account.findMany({ select: { id: true, timezone: true } });
  const result: DailyJobsResult = {
    accountsProcessed: accounts.length,
    monthlyReviewsCreated: 0,
    insightsCreated: 0,
    bankTransactionsImported: 0,
    accountsDeleted: deletions.deleted,
    errors: [...deletions.errors],
  };
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
        await insightService.generateMonthlyReview(accountId, period);
        result.monthlyReviewsCreated += 1;
      }
      const newInsights = await insightService.generateInsights(accountId);
      result.insightsCreated += newInsights.length;
      // Push only fresh warnings (late rent, expense spike) to the landlord's
      // devices — info/positive would be noise. dedupeKey guarantees an
      // insight is "new" at most once, so repeats can't re-notify.
      for (const insight of newInsights.filter((i) => i.severity === 'warning')) {
        await notifyAccount(accountId, {
          title: insight.title,
          body: insight.body,
          deepLink: insight.actionTarget ?? '/',
        });
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
