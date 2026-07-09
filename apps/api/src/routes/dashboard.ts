import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { coerceNumbers, parseQuery } from '../plugins/zod-validation';
import * as dashboardService from '../services/dashboard.service';
import * as insightService from '../services/insight.service';

const SeriesQuerySchema = z.object({ months: z.number().int().min(1).max(24).optional() });
const ActivityQuerySchema = z.object({ limit: z.number().int().min(1).max(50).optional() });

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dashboard/kpis', async (req) => dashboardService.getKpis(req.accountId));

  app.get('/dashboard/cashflow-series', async (req) => {
    const q = parseQuery(
      SeriesQuerySchema,
      coerceNumbers(req.query as Record<string, unknown>, ['months']),
    );
    return dashboardService.getIncomeExpenseSeries(req.accountId, q.months ?? 6);
  });

  app.get('/dashboard/expense-breakdown', async (req) =>
    dashboardService.getExpenseBreakdown(req.accountId),
  );

  app.get('/dashboard/noi-by-property', async (req) =>
    dashboardService.getNoiByProperty(req.accountId),
  );

  app.get('/dashboard/activity', async (req) => {
    const q = parseQuery(
      ActivityQuerySchema,
      coerceNumbers(req.query as Record<string, unknown>, ['limit']),
    );
    return dashboardService.getActivity(req.accountId, q.limit ?? 10);
  });

  app.get('/dashboard/insight', async (req, reply) => {
    const insight = await insightService.getDashboardInsight(req.accountId);
    // reply.send(null) — be explicit so Fastify serializes JSON null.
    return reply.send(insight ?? null);
  });
}
