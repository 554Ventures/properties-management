import type { Integration, IntegrationStatus, IntegrationType } from '@hearth/shared';
import type { Integration as DbIntegration } from '@prisma/client';
import { createPlaidAdapter } from '../integrations/factory';
import { decrypt, encrypt } from '../lib/crypto';
import { iso } from '../lib/dates';
import { BadRequestError, NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';

interface PlaidConfig {
  accessTokenEncrypted: string;
  itemId: string;
  cursor: string | null;
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
): Promise<Integration> {
  if (type === 'plaid') {
    throw new BadRequestError(
      'Use POST /integrations/plaid/link-token and /integrations/plaid/exchange to connect Plaid.',
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
  return toApiIntegration(row);
}

export interface ConnectedPlaidState {
  integrationId: string;
  itemId: string;
  accessToken: string; // decrypted, ready to pass to the adapter
  accessTokenEncrypted: string; // pass back unchanged when persisting a new cursor
  cursor: string | null;
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

export async function disconnect(accountId: string, id: string): Promise<void> {
  const existing = await prisma.integration.findFirst({ where: { id, accountId } });
  if (!existing) throw new NotFoundError('integration', id);

  if (existing.type === 'plaid' && existing.configJson !== '{}') {
    const config = JSON.parse(existing.configJson) as Partial<PlaidConfig>;
    if (config.accessTokenEncrypted) {
      // Best-effort: a transient Plaid-side error must never block disconnect.
      await createPlaidAdapter().removeItem(decodeAccessToken(config.accessTokenEncrypted));
    }
  }

  await prisma.integration.update({
    where: { id },
    data: { status: 'disconnected', externalRef: null, configJson: '{}' },
  });
}
