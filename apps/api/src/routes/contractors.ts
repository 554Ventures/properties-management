import {
  CreateContractorInputSchema,
  LogContractorJobInputSchema,
  UpdateContractorInputSchema,
} from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../lib/authz';
import { parseBody } from '../plugins/zod-validation';
import * as contractorService from '../services/contractor.service';

export async function contractorsRoutes(app: FastifyInstance): Promise<void> {
  // The maintenance directory is part of property operations → 'properties' grant.
  const needsProperties = { preHandler: requirePermission('properties') };
  // Logging a job is not a directory edit — it mints a confirmed expense in the
  // ledger (contractor.service.logJob → transaction.service.create), so it is
  // gated by the permission that governs the *effect*, not the surface it's
  // reached from. Gating it on 'properties' let a member denied 'money' write
  // to the ledger. 'money' alone (not both) is correct: a member holding 'money'
  // can already produce the same row via POST /transactions, where a matching
  // vendor name links the contractor automatically (ARCHITECTURE §4).
  const needsMoney = { preHandler: requirePermission('money') };

  app.get('/contractors', async (req) => contractorService.list(req.accountId));

  app.post('/contractors', needsProperties, async (req, reply) => {
    const input = parseBody(CreateContractorInputSchema, req.body);
    const contractor = await contractorService.create(req.accountId, input);
    return reply.code(201).send(contractor);
  });

  app.get<{ Params: { id: string } }>('/contractors/:id', async (req) =>
    contractorService.detail(req.accountId, req.params.id),
  );

  app.patch<{ Params: { id: string } }>('/contractors/:id', needsProperties, async (req) => {
    const input = parseBody(UpdateContractorInputSchema, req.body);
    return contractorService.update(req.accountId, req.params.id, input);
  });

  app.delete<{ Params: { id: string } }>('/contractors/:id', needsProperties, async (req, reply) => {
    await contractorService.remove(req.accountId, req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/contractors/:id/restore', needsProperties, async (req) =>
    contractorService.restore(req.accountId, req.params.id),
  );

  app.post<{ Params: { id: string } }>('/contractors/:id/jobs', needsMoney, async (req) => {
    const input = parseBody(LogContractorJobInputSchema, req.body);
    return contractorService.logJob(req.accountId, req.params.id, input);
  });
}
