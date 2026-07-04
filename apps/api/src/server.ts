import { buildApp } from './app';
import { addMonthsToPeriod, currentPeriod, monthStart } from './lib/dates';
import { prisma } from './lib/prisma';
import { getDemoAccountId } from './plugins/auth';
import * as insightService from './services/insight.service';

const port = Number(process.env.PORT ?? 3001);
// Local-only by default; set HOST=0.0.0.0 explicitly to expose the server.
const host = process.env.HOST ?? '127.0.0.1';

const app = await buildApp({ logger: true });

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Daily scheduled jobs (ARCHITECTURE §4), disabled via HEARTH_DISABLE_SCHEDULER
// (tests): once a new month has begun, snapshot a monthly_review Report for the
// previous month if none exists yet; then refresh insights so new-month rules
// (dedupeKeys carry the period) fire without reseeding.
if (!process.env.HEARTH_DISABLE_SCHEDULER) {
  const runDailyJobs = async (): Promise<void> => {
    try {
      const accountId = await getDemoAccountId();
      const period = addMonthsToPeriod(currentPeriod(), -1);
      const existing = await prisma.report.findFirst({
        where: { accountId, type: 'monthly_review', periodStart: monthStart(period) },
      });
      if (!existing) {
        await insightService.generateMonthlyReview(accountId, period);
        app.log.info(`monthly review generated for ${period}`);
      }
      const created = await insightService.generateInsights(accountId);
      if (created.length > 0) app.log.info(`generated ${created.length} new insight(s)`);
    } catch (err) {
      app.log.error(err, 'daily scheduled jobs failed');
    }
  };
  void runDailyJobs();
  setInterval(runDailyJobs, 24 * 60 * 60 * 1000).unref();
}
