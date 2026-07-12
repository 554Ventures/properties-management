import { CreateUnitInputSchema, UpdateUnitInputSchema } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../lib/authz';
import { parseBody } from '../plugins/zod-validation';
import * as unitService from '../services/unit.service';

export async function unitsRoutes(app: FastifyInstance): Promise<void> {
  // Units are part of property management → same 'properties' grant.
  const needsProperties = { preHandler: requirePermission('properties') };

  app.post<{ Params: { id: string } }>(
    '/properties/:id/units',
    needsProperties,
    async (req, reply) => {
      const input = parseBody(CreateUnitInputSchema, req.body);
      const unit = await unitService.create(req.accountId, req.params.id, input);
      return reply.code(201).send(unit);
    },
  );

  app.get<{ Params: { id: string } }>('/units/:id', async (req) =>
    unitService.getDetail(req.accountId, req.params.id),
  );

  app.patch<{ Params: { id: string } }>('/units/:id', needsProperties, async (req) => {
    const input = parseBody(UpdateUnitInputSchema, req.body);
    return unitService.update(req.accountId, req.params.id, input);
  });

  app.delete<{ Params: { id: string } }>('/units/:id', needsProperties, async (req, reply) => {
    await unitService.remove(req.accountId, req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/units/:id/restore', needsProperties, async (req) =>
    unitService.restore(req.accountId, req.params.id),
  );
}
