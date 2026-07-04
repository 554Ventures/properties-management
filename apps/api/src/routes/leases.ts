import {
  AcceptRenewalInputSchema,
  AddLeaseTenantInputSchema,
  CreateLeaseInputSchema,
  LeaseStatusSchema,
  UpdateLeaseInputSchema,
} from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, parseQuery } from '../plugins/zod-validation';
import * as leaseService from '../services/lease.service';

const LeaseListQuerySchema = z.object({ status: LeaseStatusSchema.optional() });

export async function leasesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/leases', async (req) => {
    const q = parseQuery(LeaseListQuerySchema, req.query);
    return leaseService.list(req.accountId, q);
  });

  app.post('/leases', async (req, reply) => {
    const input = parseBody(CreateLeaseInputSchema, req.body);
    const lease = await leaseService.create(req.accountId, input);
    return reply.code(201).send(lease);
  });

  app.get<{ Params: { id: string } }>('/leases/:id', async (req) =>
    leaseService.getDetail(req.accountId, req.params.id),
  );

  app.patch<{ Params: { id: string } }>('/leases/:id', async (req) => {
    const input = parseBody(UpdateLeaseInputSchema, req.body);
    return leaseService.update(req.accountId, req.params.id, input);
  });

  app.post<{ Params: { id: string } }>('/leases/:id/terminate', async (req) =>
    leaseService.terminate(req.accountId, req.params.id),
  );

  app.post<{ Params: { id: string } }>('/leases/:id/tenants', async (req) => {
    const input = parseBody(AddLeaseTenantInputSchema, req.body);
    return leaseService.addTenant(req.accountId, req.params.id, input);
  });

  app.delete<{ Params: { id: string; tenantId: string } }>(
    '/leases/:id/tenants/:tenantId',
    async (req) => leaseService.removeTenant(req.accountId, req.params.id, req.params.tenantId),
  );

  app.post<{ Params: { id: string } }>('/leases/:id/renewal', async (req, reply) => {
    const input = parseBody(AcceptRenewalInputSchema, req.body);
    const lease = await leaseService.createRenewal(req.accountId, req.params.id, input);
    return reply.code(201).send(lease);
  });

  app.post<{ Params: { id: string } }>('/leases/:id/renewal-draft', async (req) =>
    leaseService.draftRenewal(req.accountId, req.params.id),
  );

  app.post<{ Params: { id: string } }>('/leases/:id/esign', async (req) =>
    leaseService.sendForEsign(req.accountId, req.params.id),
  );
}
