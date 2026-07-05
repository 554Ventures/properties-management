import {
  ExchangePublicTokenInputSchema,
  IntegrationTypeSchema,
  UpdateAccountSettingsInputSchema,
  type AccountSettings,
} from '@hearth/shared';
import type { Account as DbAccount } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { iso } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { parseBody } from '../plugins/zod-validation';
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
