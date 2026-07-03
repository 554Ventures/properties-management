import { CreatePropertyInputSchema, UpdatePropertyInputSchema } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { yearRange } from '../lib/dates';
import { parseBody, parseQuery } from '../plugins/zod-validation';
import * as propertyService from '../services/property.service';

const PnlQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export async function propertiesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/properties', async (req) => propertyService.list(req.accountId));

  app.post('/properties', async (req, reply) => {
    const input = parseBody(CreatePropertyInputSchema, req.body);
    const property = await propertyService.create(req.accountId, input);
    return reply.code(201).send(property);
  });

  app.get<{ Params: { id: string } }>('/properties/:id', async (req) =>
    propertyService.getDetail(req.accountId, req.params.id),
  );

  app.patch<{ Params: { id: string } }>('/properties/:id', async (req) => {
    const input = parseBody(UpdatePropertyInputSchema, req.body);
    return propertyService.update(req.accountId, req.params.id, input);
  });

  app.delete<{ Params: { id: string } }>('/properties/:id', async (req, reply) => {
    await propertyService.remove(req.accountId, req.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/properties/:id/pnl', async (req) => {
    const q = parseQuery(PnlQuerySchema, req.query);
    const currentYear = yearRange(new Date().getUTCFullYear());
    const from = q.from ? new Date(q.from) : currentYear.from;
    const to = q.to ? new Date(q.to) : currentYear.to;
    return propertyService.getPnl(req.accountId, req.params.id, { from, to });
  });
}
