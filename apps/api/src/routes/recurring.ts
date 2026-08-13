import {
  CreateRecurringTemplateInputSchema,
  UpdateRecurringTemplateInputSchema,
} from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../lib/authz';
import { coerceBooleans, parseBody, parseQuery } from '../plugins/zod-validation';
import * as recurringService from '../services/recurring.service';

const ListQuerySchema = z.object({ includeArchived: z.boolean().optional() });

export async function recurringRoutes(app: FastifyInstance): Promise<void> {
  // A template's whole job is minting ledger rows, so scheduling one is a money
  // write — 'properties' would let a member without money access schedule them.
  const needsMoney = { preHandler: requirePermission('money') };

  app.get('/recurring-templates', async (req) => {
    const q = parseQuery(
      ListQuerySchema,
      coerceBooleans(req.query as Record<string, unknown>, ['includeArchived']),
    );
    return recurringService.list(req.accountId, { includeArchived: q.includeArchived });
  });

  app.post('/recurring-templates', needsMoney, async (req, reply) => {
    const input = parseBody(CreateRecurringTemplateInputSchema, req.body);
    const template = await recurringService.create(req.accountId, input);
    return reply.code(201).send(template);
  });

  app.patch<{ Params: { id: string } }>('/recurring-templates/:id', needsMoney, async (req) => {
    const input = parseBody(UpdateRecurringTemplateInputSchema, req.body);
    return recurringService.update(req.accountId, req.params.id, input);
  });

  // Archive = pause: the template stops drafting but keeps its history.
  app.delete<{ Params: { id: string } }>('/recurring-templates/:id', needsMoney, async (req, reply) => {
    await recurringService.remove(req.accountId, req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/recurring-templates/:id/restore', needsMoney, async (req) =>
    recurringService.restore(req.accountId, req.params.id),
  );
}
