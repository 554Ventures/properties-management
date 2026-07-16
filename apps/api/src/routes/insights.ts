import { InsightScopeSchema, InsightStatusSchema } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
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

  // Dev/demo trigger for the scheduled job — reviews the last full month
  // (resolved on the account's timezone inside the service, WS4).
  app.post('/insights/monthly-reviews/generate', async (req, reply) => {
    const report = await insightService.generateMonthlyReview(req.accountId);
    return reply.code(201).send(report);
  });

  app.post<{ Params: { id: string } }>('/insights/:id/dismiss', async (req) =>
    insightService.dismiss(req.accountId, req.params.id),
  );

  // The user executed the insight's suggested action (audited server-side as
  // ai_suggested_user_confirmed — see insight.service.markActioned).
  app.post<{ Params: { id: string } }>('/insights/:id/actioned', async (req) =>
    insightService.markActioned(req.accountId, req.params.id),
  );
}
