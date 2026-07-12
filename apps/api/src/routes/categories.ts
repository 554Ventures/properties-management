import { CreateCategoryInputSchema } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../lib/authz';
import { parseBody } from '../plugins/zod-validation';
import * as categoryService from '../services/category.service';

export async function categoriesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/categories', async (req) => categoryService.list(req.accountId));

  // Categories organize the money ledger → same 'money' grant.
  app.post('/categories', { preHandler: requirePermission('money') }, async (req, reply) => {
    const input = parseBody(CreateCategoryInputSchema, req.body);
    const category = await categoryService.create(req.accountId, input);
    return reply.code(201).send(category);
  });
}
