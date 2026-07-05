// Plaid connect/exchange/disconnect/import-from-bank, at the service layer.
// Uses a dedicated account (not the shared demo account, which already has
// a seeded status:'mock' Plaid row) so "no connected Plaid row yet" scenarios
// aren't polluted by seed data. Runs entirely in mock mode (no PLAID_CLIENT_ID
// set) since that's what this offline suite can exercise deterministically —
// the real-adapter request/response mapping is covered in real-plaid.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IntegrationListResponseSchema } from '@hearth/shared';
import { prisma } from '../lib/prisma';
import * as integrationService from '../services/integration.service';
import { importFromBank } from '../services/transaction.service';

let accountId: string;

beforeAll(async () => {
  const account = await prisma.account.create({
    data: { name: 'Plaid Test', email: 'plaid-test@integrationtest.example' },
  });
  accountId = account.id;
});

afterAll(async () => {
  await prisma.account.deleteMany({ where: { email: { endsWith: '@integrationtest.example' } } });
});

describe('integrations: demo account smoke test', () => {
  it('GET /integrations parity: list() returns the 4 seeded mock rows for an account with none created', async () => {
    // Fresh account created above has zero Integration rows — mirrors a real
    // production signup, the empty-state gap this feature started from.
    const rows = IntegrationListResponseSchema.parse(await integrationService.list(accountId));
    expect(rows).toHaveLength(0);
  });
});

describe('Plaid connect flow (mock mode)', () => {
  it('createLinkToken returns a mock link token', async () => {
    const { linkToken, mock } = await integrationService.createLinkToken(accountId);
    expect(mock).toBe(true);
    expect(linkToken).toBeTruthy();
  });

  it('exchangePublicToken creates a connected row with non-empty configJson', async () => {
    const integration = await integrationService.exchangePublicToken(accountId, 'mock-public-token');
    expect(integration.status).toBe('connected');
    expect(integration.type).toBe('plaid');

    const row = await prisma.integration.findUniqueOrThrow({ where: { id: integration.id } });
    expect(row.configJson).not.toBe('{}');
    expect(JSON.parse(row.configJson)).toMatchObject({ itemId: 'mock_item_id', cursor: null });
  });

  it('importFromBank imports the mock batch once, then dedupes on repeat calls', async () => {
    const first = await importFromBank(accountId);
    expect(first.imported).toBe(3);

    const second = await importFromBank(accountId);
    expect(second.imported).toBe(0);
  });

  it('disconnect clears configJson back to {}', async () => {
    const rows = await prisma.integration.findMany({ where: { accountId, type: 'plaid' } });
    const row = rows[0]!;
    await integrationService.disconnect(accountId, row.id);

    const updated = await prisma.integration.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.status).toBe('disconnected');
    expect(updated.configJson).toBe('{}');
    expect(updated.externalRef).toBeNull();
  });

  it('connectMock rejects type=plaid — the Link flow must be used instead', async () => {
    await expect(integrationService.connectMock(accountId, 'plaid')).rejects.toThrow(
      /link-token/,
    );
  });
});

describe('importFromBank in real mode requires a connected Plaid row', () => {
  const account2Id = { current: '' };

  beforeAll(async () => {
    const account = await prisma.account.create({
      data: { name: 'Plaid Real Mode Test', email: 'plaid-real-mode@integrationtest.example' },
    });
    account2Id.current = account.id;
  });

  it('throws plaid_not_connected when no Integration row exists yet', async () => {
    process.env.PLAID_CLIENT_ID = 'test_client_id';
    process.env.PLAID_SECRET = 'test_secret';
    process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    try {
      await expect(importFromBank(account2Id.current)).rejects.toMatchObject({
        code: 'plaid_not_connected',
      });
    } finally {
      delete process.env.PLAID_CLIENT_ID;
      delete process.env.PLAID_SECRET;
      delete process.env.INTEGRATION_ENCRYPTION_KEY;
    }
  });
});
