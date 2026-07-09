import {
  ExchangePublicTokenInputSchema,
  IntegrationTypeSchema,
  UpdateAccountSettingsInputSchema,
  type AccountSettings,
} from '@hearth/shared';
import type { Account as DbAccount } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { iso, isoOrNull } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { parseBody } from '../plugins/zod-validation';
import * as accountService from '../services/account.service';
import * as integrationService from '../services/integration.service';

function toApiAccount(a: DbAccount): AccountSettings {
  return {
    id: a.id,
    name: a.name,
    email: a.email,
    timezone: a.timezone,
    taxRatePct: a.taxRatePct,
    taxYearStartMonth: a.taxYearStartMonth,
    graceDays: a.graceDays,
    createdAt: iso(a.createdAt),
    deletionRequestedAt: isoOrNull(a.deletionRequestedAt),
  };
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/settings/account', async (req) => {
    const account = await prisma.account.findUniqueOrThrow({ where: { id: req.accountId } });
    return toApiAccount(account);
  });

  app.patch('/settings/account', async (req) => {
    const input = parseBody(UpdateAccountSettingsInputSchema, req.body);
    const account = await prisma.account.update({ where: { id: req.accountId }, data: input });
    return toApiAccount(account);
  });

  // Data erasure (docs/SECURITY_PRIVACY_AUDIT.md §B2): starts/cancels the
  // grace-window deletion request. The actual hard delete only ever runs
  // from the daily scheduler once the grace period elapses (accountService.
  // processScheduledDeletions) — this endpoint never deletes anything itself.
  app.post('/settings/account/deletion', async (req, reply) => {
    const result = await accountService.requestDeletion(req.accountId);
    return reply.code(202).send(result);
  });

  app.delete('/settings/account/deletion', async (req, reply) => {
    await accountService.cancelDeletion(req.accountId);
    return reply.code(204).send();
  });

  app.get('/integrations', async (req) => integrationService.list(req.accountId));

  app.post('/integrations/plaid/link-token', async (req) =>
    integrationService.createLinkToken(req.accountId),
  );

  app.post('/integrations/plaid/exchange', async (req) => {
    const input = parseBody(ExchangePublicTokenInputSchema, req.body);
    return integrationService.exchangePublicToken(req.accountId, input.publicToken);
  });

  app.post<{ Params: { type: string } }>('/integrations/:type/connect', async (req) => {
    const type = IntegrationTypeSchema.parse(req.params.type);
    return integrationService.connectMock(req.accountId, type);
  });

  app.delete<{ Params: { id: string } }>('/integrations/:id', async (req, reply) => {
    await integrationService.disconnect(req.accountId, req.params.id);
    return reply.code(204).send();
  });
}
