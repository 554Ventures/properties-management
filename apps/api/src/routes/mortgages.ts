import { CreateMortgageInputSchema, UpdateMortgageInputSchema } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../lib/authz';
import { parseBody } from '../plugins/zod-validation';
import * as mortgageService from '../services/mortgage.service';

export async function mortgagesRoutes(app: FastifyInstance): Promise<void> {
  const needsProperties = { preHandler: requirePermission('properties') };

  app.post<{ Params: { id: string } }>(
    '/properties/:id/mortgages',
    needsProperties,
    async (req, reply) => {
      const input = parseBody(CreateMortgageInputSchema, req.body);
      const mortgage = await mortgageService.create(req.accountId, req.params.id, input);
      return reply.code(201).send(mortgage);
    },
  );

  app.patch<{ Params: { id: string } }>('/mortgages/:id', needsProperties, async (req) => {
    const input = parseBody(UpdateMortgageInputSchema, req.body);
    return mortgageService.update(req.accountId, req.params.id, input);
  });

  app.delete<{ Params: { id: string } }>('/mortgages/:id', needsProperties, async (req, reply) => {
    await mortgageService.remove(req.accountId, req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/mortgages/:id/restore', needsProperties, async (req) =>
    mortgageService.restore(req.accountId, req.params.id),
  );
}
