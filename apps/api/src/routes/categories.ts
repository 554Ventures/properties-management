import { CreateCategoryInputSchema } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { parseBody } from '../plugins/zod-validation';
import * as categoryService from '../services/category.service';

export async function categoriesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/categories', async (req) => categoryService.list(req.accountId));

  app.post('/categories', async (req, reply) => {
    const input = parseBody(CreateCategoryInputSchema, req.body);
    const category = await categoryService.create(req.accountId, input);
    return reply.code(201).send(category);
  });
}
