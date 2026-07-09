import { buildApp } from './app';
import { assertProductionConfig } from './lib/boot-guards';
import { runDailyJobs } from './services/jobs.service';

try {
  assertProductionConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

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

// Daily scheduled jobs (ARCHITECTURE §4, jobs.service.ts), disabled via
// HEARTH_DISABLE_SCHEDULER (tests). In deployments where the process may
// scale to zero, an external cron calls POST /api/v1/internal/run-daily-jobs
// instead (deployment plan §3) — both paths run the same service function,
// which is idempotent per account and day.
if (!process.env.HEARTH_DISABLE_SCHEDULER) {
  const tick = async (): Promise<void> => {
    try {
      const result = await runDailyJobs();
      if (result.monthlyReviewsCreated > 0) {
        app.log.info(`generated ${result.monthlyReviewsCreated} monthly review(s)`);
      }
      if (result.insightsCreated > 0) {
        app.log.info(`generated ${result.insightsCreated} new insight(s)`);
      }
      for (const e of result.errors) {
        app.log.error({ accountId: e.accountId }, `daily jobs failed for account: ${e.message}`);
      }
    } catch (err) {
      app.log.error(err, 'daily scheduled jobs failed');
    }
  };
  void tick();
  setInterval(tick, 24 * 60 * 60 * 1000).unref();
}
