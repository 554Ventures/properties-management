// Internal automation endpoints (deployment plan §3): in production a
// Cloudflare Cron Trigger calls these instead of relying on the in-process
// setInterval, so daily jobs survive scale-to-zero. Authenticated by the
// CRON_SECRET shared secret (X-Cron-Secret header), not a user JWT — the auth
// plugin deliberately skips /internal/*. Disabled (404-equivalent 401) when
// CRON_SECRET is unset. Not part of the public @hearth/shared contract.
import type { FastifyInstance } from 'fastify';
import { HttpError } from '../lib/errors';
import { runDailyJobs } from '../services/jobs.service';

export async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.post('/internal/run-daily-jobs', async (req) => {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers['x-cron-secret'] !== secret) {
      throw new HttpError(401, 'unauthorized', 'Missing or invalid cron secret');
    }
    const result = await runDailyJobs();
    for (const e of result.errors) {
      req.log.error({ accountId: e.accountId }, `daily jobs failed for account: ${e.message}`);
    }
    return result;
  });
}
