import type { Integration, IntegrationStatus, IntegrationType } from '@hearth/shared';
import type { Integration as DbIntegration } from '@prisma/client';
import { iso } from '../lib/dates';
import { NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';

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

export async function disconnect(accountId: string, id: string): Promise<void> {
  const existing = await prisma.integration.findFirst({ where: { id, accountId } });
  if (!existing) throw new NotFoundError('integration', id);
  await prisma.integration.update({
    where: { id },
    data: { status: 'disconnected', externalRef: null },
  });
}
