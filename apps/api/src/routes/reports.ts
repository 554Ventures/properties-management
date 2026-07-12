import {
  EmailReportInputSchema,
  GenerateReportInputSchema,
  ReportTypeSchema,
} from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../lib/authz';
import { coerceNumbers, parseBody, parseQuery } from '../plugins/zod-validation';
import * as reportService from '../services/report.service';

const ReportListQuerySchema = z.object({
  type: ReportTypeSchema.optional(),
  taxYear: z.number().int().optional(),
});

const ExportQuerySchema = z.object({ format: z.enum(['pdf', 'csv']) });

export async function reportsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/reports/library', async () => reportService.listLibrary());

  app.get('/reports', async (req) => {
    const q = parseQuery(
      ReportListQuerySchema,
      coerceNumbers(req.query as Record<string, unknown>, ['taxYear']),
    );
    return reportService.listGenerated(req.accountId, q);
  });

  app.post('/reports/generate', { preHandler: requirePermission('reports') }, async (req, reply) => {
    const input = parseBody(GenerateReportInputSchema, req.body);
    const report = await reportService.generate(req.accountId, input);
    return reply.code(201).send(report);
  });

  app.get<{ Params: { id: string } }>('/reports/:id', async (req) =>
    reportService.getById(req.accountId, req.params.id),
  );

  app.get<{ Params: { id: string } }>('/reports/:id/export', async (req, reply) => {
    const q = parseQuery(ExportQuerySchema, req.query);
    if (q.format === 'csv') {
      const { filename, csv } = await reportService.exportCsv(req.accountId, req.params.id);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(csv);
    }
    const { filename, buffer } = await reportService.exportPdf(req.accountId, req.params.id);
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(buffer);
  });

  app.post<{ Params: { id: string } }>(
    '/reports/:id/email',
    { preHandler: requirePermission('reports') },
    async (req, reply) => {
      const input = parseBody(EmailReportInputSchema, req.body);
      await reportService.emailToAccountant(req.accountId, req.params.id, input.to);
      return reply.code(202).send();
    },
  );
}
