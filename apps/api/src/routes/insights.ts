import { InsightScopeSchema, InsightStatusSchema } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addMonthsToPeriod, currentPeriod } from '../lib/dates';
import { parseQuery } from '../plugins/zod-validation';
import * as insightService from '../services/insight.service';
import * as reportService from '../services/report.service';

const InsightListQuerySchema = z.object({
  status: InsightStatusSchema.optional(),
  scope: InsightScopeSchema.optional(),
});

export async function insightsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/insights', async (req) => {
    const q = parseQuery(InsightListQuerySchema, req.query);
    return insightService.list(req.accountId, q);
  });

  // Static segment routes before /:id.
  app.get('/insights/monthly-reviews', async (req) =>
    reportService.listGenerated(req.accountId, { type: 'monthly_review' }),
  );

  app.get<{ Params: { id: string } }>('/insights/monthly-reviews/:id', async (req) =>
    reportService.getById(req.accountId, req.params.id),
  );

  // Dev/demo trigger for the scheduled job — reviews the last full month.
  app.post('/insights/monthly-reviews/generate', async (req, reply) => {
    const period = addMonthsToPeriod(currentPeriod(), -1);
    const report = await insightService.generateMonthlyReview(req.accountId, period);
    return reply.code(201).send(report);
  });

  app.post<{ Params: { id: string } }>('/insights/:id/dismiss', async (req) =>
    insightService.dismiss(req.accountId, req.params.id),
  );
}
