// Daily scheduled jobs (ARCHITECTURE §4), per account (deployment plan §4.3):
// once a new month has begun, snapshot a monthly_review Report for the
// previous month if none exists yet, then refresh insights so new-month rules
// (dedupeKeys carry the period) fire without reseeding. Called by the
// in-process scheduler (server.ts) and the cron-triggered internal endpoint
// (routes/internal.ts). One account's failure never blocks the others.
import { addMonthsToPeriod, currentPeriod, monthStart } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { processScheduledDeletions } from './account.service';
import * as insightService from './insight.service';
import { notifyAccount } from './push.service';

export interface DailyJobsResult {
  accountsProcessed: number;
  monthlyReviewsCreated: number;
  insightsCreated: number;
  accountsDeleted: number;
  errors: Array<{ accountId: string; message: string }>;
}

export async function runDailyJobs(): Promise<DailyJobsResult> {
  const period = addMonthsToPeriod(currentPeriod(), -1);
  // Deletions first: an account past its grace period shouldn't get a fresh
  // monthly review/insight refresh moments before being hard-deleted.
  const deletions = await processScheduledDeletions();
  const accounts = await prisma.account.findMany({ select: { id: true } });
  const result: DailyJobsResult = {
    accountsProcessed: accounts.length,
    monthlyReviewsCreated: 0,
    insightsCreated: 0,
    accountsDeleted: deletions.deleted,
    errors: [...deletions.errors],
  };
  for (const { id: accountId } of accounts) {
    try {
      const existing = await prisma.report.findFirst({
        where: { accountId, type: 'monthly_review', periodStart: monthStart(period) },
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
