import { CreateTenantInputSchema, UpdateTenantInputSchema } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { parseBody } from '../plugins/zod-validation';
import * as tenantService from '../services/tenant.service';

export async function tenantsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tenants', async (req) => tenantService.list(req.accountId));

  app.post('/tenants', async (req, reply) => {
    const input = parseBody(CreateTenantInputSchema, req.body);
    const tenant = await tenantService.create(req.accountId, input);
    return reply.code(201).send(tenant);
  });

  app.get<{ Params: { id: string } }>('/tenants/:id', async (req) =>
    tenantService.getDetail(req.accountId, req.params.id),
  );

  app.patch<{ Params: { id: string } }>('/tenants/:id', async (req) => {
    const input = parseBody(UpdateTenantInputSchema, req.body);
    return tenantService.update(req.accountId, req.params.id, input);
  });

  app.delete<{ Params: { id: string } }>('/tenants/:id', async (req, reply) => {
    await tenantService.remove(req.accountId, req.params.id);
    return reply.code(204).send();
  });
}
