import { buildApp } from './app';
import { addMonthsToPeriod, currentPeriod, monthStart } from './lib/dates';
import { prisma } from './lib/prisma';
import { getDemoAccountId } from './plugins/auth';
import * as insightService from './services/insight.service';

const port = Number(process.env.PORT ?? 3001);

const app = await buildApp({ logger: true });

try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Scheduled monthly review (ARCHITECTURE §4): daily check — once a new month
// has begun, snapshot a monthly_review Report for the previous month if none
// exists yet. Disabled via HEARTH_DISABLE_SCHEDULER (tests).
if (!process.env.HEARTH_DISABLE_SCHEDULER) {
  const checkMonthlyReview = async (): Promise<void> => {
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
    } catch (err) {
      app.log.error(err, 'monthly review check failed');
    }
  };
  void checkMonthlyReview();
  setInterval(checkMonthlyReview, 24 * 60 * 60 * 1000).unref();
}
