import {
  ExchangePublicTokenInputSchema,
  IntegrationTypeSchema,
  RecordConsentInputSchema,
  StripeFcCompleteInputSchema,
  UpdateAccountSettingsInputSchema,
  type AccountSettings,
} from '@hearth/shared';
import type { Account as DbAccount } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { requireOwner } from '../lib/authz';
import { iso, isoOrNull } from '../lib/dates';
import { BadRequestError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { parseBody } from '../plugins/zod-validation';
import * as accountService from '../services/account.service';
import * as authService from '../services/auth.service';
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
    defaultLateFeeCents: a.defaultLateFeeCents,
    createdAt: iso(a.createdAt),
    deletionRequestedAt: isoOrNull(a.deletionRequestedAt),
  };
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/settings/account', async (req) => {
    const account = await prisma.account.findUniqueOrThrow({ where: { id: req.accountId } });
    return toApiAccount(account);
  });

  // Owner-only (CLAUDE.md authz conventions): these settings steer account-wide
  // money math — timezone moves every period boundary, graceDays/defaultLateFeeCents
  // change rent derivation, taxRatePct changes the set-aside.
  app.patch('/settings/account', { preHandler: requireOwner() }, async (req) => {
    const input = parseBody(UpdateAccountSettingsInputSchema, req.body);
    const account = await prisma.account.update({ where: { id: req.accountId }, data: input });
    return toApiAccount(account);
  });

  // Data erasure (docs/SECURITY_PRIVACY_AUDIT.md §B2): starts/cancels the
  // grace-window deletion request. The actual hard delete only ever runs
  // from the daily scheduler once the grace period elapses (accountService.
  // processScheduledDeletions) — this endpoint never deletes anything itself.
  app.post('/settings/account/deletion', { preHandler: requireOwner() }, async (req, reply) => {
    const result = await accountService.requestDeletion(req.accountId);
    return reply.code(202).send(result);
  });

  app.delete('/settings/account/deletion', { preHandler: requireOwner() }, async (req, reply) => {
    await accountService.cancelDeletion(req.accountId);
    return reply.code(204).send();
  });

  // Consent capture (docs/SECURITY_PRIVACY_AUDIT.md §B5): the frontend calls
  // this once, right after a successful Supabase signup, when the user has
  // checked the required Privacy Policy / ToS acceptance box. Per-identity
  // (User), not per-Account — only meaningful in Supabase mode, since demo
  // mode has no signup flow and no User row to attach it to.
  app.post('/settings/consent', async (req, reply) => {
    if (!req.userId) {
      throw new BadRequestError('Consent capture requires Supabase auth mode.');
    }
    const input = parseBody(RecordConsentInputSchema, req.body);
    const status = await authService.recordPolicyConsent(req.userId, input.policyVersion);
    return reply.code(201).send(status);
  });

  app.get('/integrations', async (req) => integrationService.list(req.accountId));

  app.post('/integrations/plaid/link-token', async (req) =>
    integrationService.createLinkToken(req.accountId),
  );

  app.post('/integrations/plaid/exchange', async (req) => {
    const input = parseBody(ExchangePublicTokenInputSchema, req.body);
    return integrationService.exchangePublicToken(req.accountId, input.publicToken);
  });

  // Stripe Financial Connections (bank import): session → Stripe.js modal on
  // the client → complete. Mirrors the Plaid link-token/exchange pair.
  app.post('/integrations/stripe_fc/session', async (req) =>
    integrationService.createStripeFcSession(req.accountId),
  );

  app.post('/integrations/stripe_fc/complete', async (req) => {
    const input = parseBody(StripeFcCompleteInputSchema, req.body);
    return integrationService.completeStripeFcSession(req.accountId, input.sessionId);
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
