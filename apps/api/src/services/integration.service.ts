import type { Integration, IntegrationStatus, IntegrationType } from '@hearth/shared';
import type { Integration as DbIntegration } from '@prisma/client';
import { createPlaidAdapter, createStripeFcAdapter } from '../integrations/factory';
import type { StripeFcAccountSummary } from '../integrations/types';
import { decrypt, encrypt } from '../lib/crypto';
import { iso, isoOrNull } from '../lib/dates';
import { BadRequestError, NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { writeAudit, type AuditActor } from './audit.service';

interface PlaidConfig {
  accessTokenEncrypted: string;
  itemId: string;
  cursor: string | null;
}

// No encrypted credential here: fca_/cus_ ids are inert without
// STRIPE_SECRET_KEY, which never leaves the env (see real-stripe-fc.ts).
interface StripeFcConfig {
  customerId: string | null;
  accounts: StripeFcAccountSummary[];
  /** fca account id → last processed transaction_refresh id. */
  cursors: Record<string, string>;
}

/** Encrypted only when INTEGRATION_ENCRYPTION_KEY is set (real mode); plaintext in mock mode. */
function encodeAccessToken(accessToken: string): string {
  const key = process.env.INTEGRATION_ENCRYPTION_KEY;
  return key ? encrypt(accessToken, key) : accessToken;
}

export function decodeAccessToken(encoded: string): string {
  const key = process.env.INTEGRATION_ENCRYPTION_KEY;
  return key ? decrypt(encoded, key) : encoded;
}

const INTEGRATION_NAMES: Record<IntegrationType, string> = {
  plaid: 'Plaid (bank import)',
  stripe: 'Stripe (rent payments)',
  stripe_fc: 'Stripe Financial Connections (bank import)',
  docusign: 'Docusign (e-sign)',
  email: 'Email (reminders & reports)',
  mcp_client: 'MCP client',
};

export function toApiIntegration(i: DbIntegration): Integration {
  return {
    id: i.id,
    accountId: i.accountId,
    type: i.type as IntegrationType,
    name: i.name,
    status: i.status as IntegrationStatus,
    externalRef: i.externalRef,
    scopes: JSON.parse(i.scopesJson) as string[],
    lastSyncedAt: isoOrNull(i.lastSyncedAt),
    lastSyncError: i.lastSyncError,
    lastSyncErrorAt: isoOrNull(i.lastSyncErrorAt),
    syncFailureCount: i.syncFailureCount,
    createdAt: iso(i.createdAt),
  };
}

export async function list(accountId: string): Promise<Integration[]> {
  const rows = await prisma.integration.findMany({
    where: { accountId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toApiIntegration);
}

/** Flips (or creates) the mock integration row to 'connected'. */
export async function connectMock(
  accountId: string,
  type: IntegrationType,
  actor: AuditActor = 'user',
): Promise<Integration> {
  if (type === 'plaid') {
    throw new BadRequestError(
      'Use POST /integrations/plaid/link-token and /integrations/plaid/exchange to connect Plaid.',
    );
  }
  if (type === 'stripe_fc') {
    throw new BadRequestError(
      'Use POST /integrations/stripe_fc/session and /integrations/stripe_fc/complete to connect Stripe Financial Connections.',
    );
  }
  const existing = await prisma.integration.findFirst({ where: { accountId, type } });
  const row = existing
    ? await prisma.integration.update({
        where: { id: existing.id },
        data: { status: 'connected', externalRef: `mock_${type}_${Date.now()}` },
      })
    : await prisma.integration.create({
        data: {
          accountId,
          type,
          name: INTEGRATION_NAMES[type],
          status: 'connected',
          externalRef: `mock_${type}_${Date.now()}`,
          scopesJson: '[]',
        },
      });
  await writeAudit(accountId, {
    actor,
    action: 'connect',
    entityType: 'integration',
    entityId: row.id,
    detail: { type, mock: true },
  });
  return toApiIntegration(row);
}

export async function createLinkToken(
  accountId: string,
): Promise<{ linkToken: string; mock: boolean }> {
  return createPlaidAdapter().createLinkToken(accountId);
}

export async function exchangePublicToken(
  accountId: string,
  publicToken: string,
  actor: AuditActor = 'user',
): Promise<Integration> {
  const { accessToken, itemId } = await createPlaidAdapter().exchangePublicToken(publicToken);
  const config: PlaidConfig = {
    accessTokenEncrypted: encodeAccessToken(accessToken),
    itemId,
    cursor: null,
  };
  const existing = await prisma.integration.findFirst({ where: { accountId, type: 'plaid' } });
  const row = existing
    ? await prisma.integration.update({
        where: { id: existing.id },
        data: { status: 'connected', externalRef: itemId, configJson: JSON.stringify(config) },
      })
    : await prisma.integration.create({
        data: {
          accountId,
          type: 'plaid',
          name: INTEGRATION_NAMES.plaid,
          status: 'connected',
          externalRef: itemId,
          scopesJson: '[]',
          configJson: JSON.stringify(config),
        },
      });
  // Never write the token (encrypted or not) to the audit trail's detailJson.
  await writeAudit(accountId, {
    actor,
    action: 'connect',
    entityType: 'integration',
    entityId: row.id,
    detail: { type: 'plaid', itemId },
  });
  return toApiIntegration(row);
}

export async function createStripeFcSession(accountId: string): Promise<{
  clientSecret: string;
  sessionId: string;
  publishableKey: string;
  mock: boolean;
}> {
  // Reuse the Stripe Customer across reconnects (even after a disconnect the
  // config is wiped, so only a currently-configured row can supply one).
  const existing = await prisma.integration.findFirst({
    where: { accountId, type: 'stripe_fc' },
  });
  let customerId: string | null = null;
  if (existing && existing.configJson !== '{}') {
    customerId = (JSON.parse(existing.configJson) as Partial<StripeFcConfig>).customerId ?? null;
  }
  return createStripeFcAdapter().createSession(accountId, customerId);
}

export async function completeStripeFcSession(
  accountId: string,
  sessionId: string,
  actor: AuditActor = 'user',
): Promise<Integration> {
  let result: Awaited<ReturnType<ReturnType<typeof createStripeFcAdapter>['completeSession']>>;
  try {
    result = await createStripeFcAdapter().completeSession(sessionId);
  } catch (err) {
    // Covers both "no accounts collected" (user closed the modal) and an
    // unknown/foreign session id; neither should surface as a 500.
    throw new BadRequestError(
      err instanceof Error ? err.message : 'Could not complete the Stripe bank connection.',
    );
  }
  const config: StripeFcConfig = {
    customerId: result.customerId,
    accounts: result.accounts,
    cursors: {},
  };
  const accountIds = result.accounts.map((a) => a.id);
  const existing = await prisma.integration.findFirst({ where: { accountId, type: 'stripe_fc' } });
  const row = existing
    ? await prisma.integration.update({
        where: { id: existing.id },
        data: {
          status: 'connected',
          externalRef: sessionId,
          configJson: JSON.stringify(config),
        },
      })
    : await prisma.integration.create({
        data: {
          accountId,
          type: 'stripe_fc',
          name: INTEGRATION_NAMES.stripe_fc,
          status: 'connected',
          externalRef: sessionId,
          scopesJson: '[]',
          configJson: JSON.stringify(config),
        },
      });
  await writeAudit(accountId, {
    actor,
    action: 'connect',
    entityType: 'integration',
    entityId: row.id,
    detail: { type: 'stripe_fc', sessionId, fcAccountIds: accountIds },
  });
  return toApiIntegration(row);
}

export interface ConnectedStripeFcState {
  integrationId: string;
  config: StripeFcConfig;
  lastSyncedAt: Date | null;
}

export async function getConnectedStripeFc(
  accountId: string,
): Promise<ConnectedStripeFcState | null> {
  const integration = await prisma.integration.findFirst({
    where: { accountId, type: 'stripe_fc', status: 'connected' },
  });
  if (!integration) return null;
  const config = JSON.parse(integration.configJson) as StripeFcConfig;
  return { integrationId: integration.id, config, lastSyncedAt: integration.lastSyncedAt };
}

export async function persistStripeFcCursors(
  integrationId: string,
  config: StripeFcConfig,
  cursors: Record<string, string>,
): Promise<void> {
  const next: StripeFcConfig = { ...config, cursors };
  await prisma.integration.update({
    where: { id: integrationId },
    data: { configJson: JSON.stringify(next) },
  });
}

export interface ConnectedPlaidState {
  integrationId: string;
  itemId: string;
  accessToken: string; // decrypted, ready to pass to the adapter
  accessTokenEncrypted: string; // pass back unchanged when persisting a new cursor
  cursor: string | null;
  lastSyncedAt: Date | null;
}

export async function getConnectedPlaid(accountId: string): Promise<ConnectedPlaidState | null> {
  const integration = await prisma.integration.findFirst({
    where: { accountId, type: 'plaid', status: 'connected' },
  });
  if (!integration) return null;
  const config = JSON.parse(integration.configJson) as PlaidConfig;
  return {
    integrationId: integration.id,
    itemId: config.itemId,
    accessToken: decodeAccessToken(config.accessTokenEncrypted),
    accessTokenEncrypted: config.accessTokenEncrypted,
    cursor: config.cursor,
    lastSyncedAt: integration.lastSyncedAt,
  };
}

export async function persistPlaidCursor(
  integrationId: string,
  itemId: string,
  accessTokenEncrypted: string,
  cursor: string,
): Promise<void> {
  const config: PlaidConfig = { accessTokenEncrypted, itemId, cursor };
  await prisma.integration.update({
    where: { id: integrationId },
    data: { configJson: JSON.stringify(config) },
  });
}

export async function disconnect(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<void> {
  const existing = await prisma.integration.findFirst({ where: { id, accountId } });
  if (!existing) throw new NotFoundError('integration', id);

  if (existing.type === 'stripe_fc' && existing.configJson !== '{}') {
    // Same best-effort contract as the Plaid branch below: bank-side cleanup
    // must never block the user's local disconnect.
    try {
      const config = JSON.parse(existing.configJson) as Partial<StripeFcConfig>;
      const fcAccountIds = (config.accounts ?? []).map((a) => a.id);
      if (fcAccountIds.length > 0) {
        await createStripeFcAdapter().disconnectAccounts(fcAccountIds);
      }
    } catch (err) {
      console.error('[stripe_fc] pre-disconnect cleanup failed (continuing local disconnect)', err);
    }
  }

  if (existing.type === 'plaid' && existing.configJson !== '{}') {
    // Best-effort: nothing here — a Plaid-side error, a malformed config, or a
    // token stored in a different mode (e.g. a plaintext mock token that now
    // fails to decrypt once INTEGRATION_ENCRYPTION_KEY is set) — may block the
    // user's local disconnect. Swallow everything and still flip the row.
    try {
      const config = JSON.parse(existing.configJson) as Partial<PlaidConfig>;
      if (config.accessTokenEncrypted) {
        await createPlaidAdapter().removeItem(decodeAccessToken(config.accessTokenEncrypted));
      }
    } catch (err) {
      console.error('[plaid] pre-disconnect cleanup failed (continuing local disconnect)', err);
    }
  }

  await prisma.integration.update({
    where: { id },
    data: { status: 'disconnected', externalRef: null, configJson: '{}' },
  });
  await writeAudit(accountId, {
    actor,
    action: 'disconnect',
    entityType: 'integration',
    entityId: id,
    detail: { type: existing.type },
  });
}
