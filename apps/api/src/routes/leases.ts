import {
  AcceptRenewalInputSchema,
  AddLeaseTenantInputSchema,
  CreateLeaseInputSchema,
  LeaseStatusSchema,
  UpdateLeaseInputSchema,
  UpdateLeaseTenantShareInputSchema,
} from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../lib/authz';
import { parseBody, parseQuery } from '../plugins/zod-validation';
import * as leaseService from '../services/lease.service';
import * as rentService from '../services/rent.service';

const LeaseListQuerySchema = z.object({ status: LeaseStatusSchema.optional() });

export async function leasesRoutes(app: FastifyInstance): Promise<void> {
  // Leases are part of tenant management → same 'tenants' grant.
  const needsTenants = { preHandler: requirePermission('tenants') };

  app.get('/leases', async (req) => {
    const q = parseQuery(LeaseListQuerySchema, req.query);
    return leaseService.list(req.accountId, q);
  });

  app.post('/leases', needsTenants, async (req, reply) => {
    const input = parseBody(CreateLeaseInputSchema, req.body);
    const lease = await leaseService.create(req.accountId, input);
    return reply.code(201).send(lease);
  });

  app.get<{ Params: { id: string } }>('/leases/:id', async (req) =>
    leaseService.getDetail(req.accountId, req.params.id),
  );

  app.patch<{ Params: { id: string } }>('/leases/:id', needsTenants, async (req) => {
    const input = parseBody(UpdateLeaseInputSchema, req.body);
    return leaseService.update(req.accountId, req.params.id, input);
  });

  app.post<{ Params: { id: string } }>('/leases/:id/terminate', needsTenants, async (req) =>
    leaseService.terminate(req.accountId, req.params.id),
  );

  app.post<{ Params: { id: string } }>('/leases/:id/tenants', needsTenants, async (req) => {
    const input = parseBody(AddLeaseTenantInputSchema, req.body);
    return leaseService.addTenant(req.accountId, req.params.id, input);
  });

  // Set/clear a co-tenant's expected share of the rent (null = even split).
  app.patch<{ Params: { id: string; tenantId: string } }>(
    '/leases/:id/tenants/:tenantId',
    needsTenants,
    async (req, reply) => {
      const input = parseBody(UpdateLeaseTenantShareInputSchema, req.body);
      await rentService.setTenantShare(
        req.accountId,
        req.params.id,
        req.params.tenantId,
        input.shareCents,
      );
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string; tenantId: string } }>(
    '/leases/:id/tenants/:tenantId',
    needsTenants,
    async (req) => leaseService.removeTenant(req.accountId, req.params.id, req.params.tenantId),
  );

  app.post<{ Params: { id: string } }>('/leases/:id/renewal', needsTenants, async (req, reply) => {
    const input = parseBody(AcceptRenewalInputSchema, req.body);
    const lease = await leaseService.createRenewal(req.accountId, req.params.id, input);
    return reply.code(201).send(lease);
  });

  app.post<{ Params: { id: string } }>('/leases/:id/renewal-draft', needsTenants, async (req) =>
    leaseService.draftRenewal(req.accountId, req.params.id),
  );

  app.post<{ Params: { id: string } }>('/leases/:id/esign', needsTenants, async (req) =>
    leaseService.sendForEsign(req.accountId, req.params.id),
  );
}
