import { CreatePropertyValuationInputSchema } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../lib/authz';
import { parseBody } from '../plugins/zod-validation';
import * as valuationService from '../services/valuation.service';

export async function valuationsRoutes(app: FastifyInstance): Promise<void> {
  const needsProperties = { preHandler: requirePermission('properties') };

  app.get<{ Params: { id: string } }>('/properties/:id/valuations', async (req) =>
    valuationService.listForProperty(req.accountId, req.params.id),
  );

  app.post<{ Params: { id: string } }>(
    '/properties/:id/valuations',
    needsProperties,
    async (req, reply) => {
      const input = parseBody(CreatePropertyValuationInputSchema, req.body);
      const valuation = await valuationService.create(req.accountId, req.params.id, input);
      return reply.code(201).send(valuation);
    },
  );

  app.delete<{ Params: { id: string } }>('/valuations/:id', needsProperties, async (req, reply) => {
    await valuationService.remove(req.accountId, req.params.id);
    return reply.code(204).send();
  });
}
