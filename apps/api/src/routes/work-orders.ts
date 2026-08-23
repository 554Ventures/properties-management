// Maintenance work orders (PRD §5.10, PLAN-MAINTENANCE §5). Reads are open to
// any member (property-hub triage needs them); writes are gated on
// 'properties' — the same grant the contractor directory uses ("maintenance
// is part of property operations"). Cost linking itself rides
// POST/PATCH /transactions and /transactions/:id/confirm under the existing
// 'money' guard — there is deliberately no POST /work-orders/:id/expense,
// which would be a second money-write path outside that guard.
import { CreateWorkOrderInputSchema, UpdateWorkOrderInputSchema, WorkOrderFilterSchema } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../lib/authz';
import { coerceBooleans, parseBody, parseQuery } from '../plugins/zod-validation';
import * as workOrderService from '../services/work-order.service';

export async function workOrdersRoutes(app: FastifyInstance): Promise<void> {
  const needsProperties = { preHandler: requirePermission('properties') };

  app.get('/work-orders', async (req) => {
    const filter = parseQuery(
      WorkOrderFilterSchema,
      coerceBooleans(req.query as Record<string, unknown>, ['openOnly', 'includeArchived']),
    );
    return workOrderService.list(req.accountId, filter);
  });

  app.post('/work-orders', needsProperties, async (req, reply) => {
    const input = parseBody(CreateWorkOrderInputSchema, req.body);
    const workOrder = await workOrderService.create(req.accountId, input);
    return reply.code(201).send(workOrder);
  });

  // Static before parameterized.
  app.get<{ Params: { id: string } }>('/work-orders/:id', async (req) =>
    workOrderService.getDetail(req.accountId, req.params.id),
  );

  app.patch<{ Params: { id: string } }>('/work-orders/:id', needsProperties, async (req) => {
    const input = parseBody(UpdateWorkOrderInputSchema, req.body);
    return workOrderService.update(req.accountId, req.params.id, input);
  });

  app.delete<{ Params: { id: string } }>('/work-orders/:id', needsProperties, async (req, reply) => {
    await workOrderService.remove(req.accountId, req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/work-orders/:id/restore', needsProperties, async (req) =>
    workOrderService.restore(req.accountId, req.params.id),
  );
}
