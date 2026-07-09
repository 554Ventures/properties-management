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

  app.post<{ Params: { id: string } }>('/tenants/:id/restore', async (req) =>
    tenantService.restore(req.accountId, req.params.id),
  );

  // Data erasure (docs/SECURITY_PRIVACY_AUDIT.md §B2): irreversible PII
  // anonymization, distinct from the soft-archive DELETE above — financial/
  // lease history is retained, only contact info + PII-bearing documents go.
  app.post<{ Params: { id: string } }>('/tenants/:id/erase-pii', async (req) =>
    tenantService.erasePii(req.accountId, req.params.id),
  );
}
