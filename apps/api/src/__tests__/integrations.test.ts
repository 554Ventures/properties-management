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
    // 3 expenses + 1 income (the rent-match demo fixture). This account has no
    // leases, which also proves the review-queue rent matcher no-ops safely.
    const first = await importFromBank(accountId);
    expect(first.imported).toBe(4);

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

describe('integration writes are audited (security remediation)', () => {
  it('connectMock writes a connect AuditLog row', async () => {
    const account = await prisma.account.create({
      data: { name: 'Integration Audit', email: 'integration-audit@integrationtest.example' },
    });
    const integration = await integrationService.connectMock(account.id, 'stripe');

    const logs = await prisma.auditLog.findMany({ where: { accountId: account.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actor: 'user',
      action: 'connect',
      entityType: 'integration',
      entityId: integration.id,
    });
    expect(JSON.parse(logs[0]!.detailJson!)).toMatchObject({ type: 'stripe', mock: true });
  });

  it('exchangePublicToken writes a connect AuditLog row without leaking the access token', async () => {
    const account = await prisma.account.create({
      data: { name: 'Integration Audit Plaid', email: 'integration-audit-plaid@integrationtest.example' },
    });
    const integration = await integrationService.exchangePublicToken(account.id, 'mock-public-token');

    const logs = await prisma.auditLog.findMany({ where: { accountId: account.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actor: 'user',
      action: 'connect',
      entityType: 'integration',
      entityId: integration.id,
    });
    const detail = JSON.parse(logs[0]!.detailJson!);
    expect(detail).toMatchObject({ type: 'plaid', itemId: 'mock_item_id' });
    expect(JSON.stringify(detail)).not.toMatch(/mock-public-token|accessToken/i);
  });

  it('disconnect writes a disconnect AuditLog row', async () => {
    const account = await prisma.account.create({
      data: { name: 'Integration Audit Disconnect', email: 'integration-audit-disconnect@integrationtest.example' },
    });
    const integration = await integrationService.connectMock(account.id, 'docusign');
    await integrationService.disconnect(account.id, integration.id);

    const logs = await prisma.auditLog.findMany({
      where: { accountId: account.id, action: 'disconnect' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actor: 'user',
      action: 'disconnect',
      entityType: 'integration',
      entityId: integration.id,
    });
    expect(JSON.parse(logs[0]!.detailJson!)).toMatchObject({ type: 'docusign' });
  });

  it('actor defaults to "user" but honors an explicit system actor (MCP/model-invoked writes)', async () => {
    const account = await prisma.account.create({
      data: { name: 'Integration Audit System Actor', email: 'integration-audit-system@integrationtest.example' },
    });
    const integration = await integrationService.connectMock(account.id, 'email', 'system');

    const logs = await prisma.auditLog.findMany({ where: { accountId: account.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.actor).toBe('system');
    void integration;
  });
});

describe('disconnect is best-effort when the stored token is unreadable', () => {
  it('disconnects a mock-mode (plaintext) Plaid row even after INTEGRATION_ENCRYPTION_KEY is set', async () => {
    // Reproduces the production bug: Connect ran in mock mode (no encryption
    // key) so the access token was stored as plaintext; later the key is set,
    // so decodeAccessToken tries to decrypt the plaintext and throws
    // "malformed ciphertext". Disconnect must swallow that and still flip.
    const account = await prisma.account.create({
      data: { name: 'Plaid Stale Token', email: 'plaid-stale@integrationtest.example' },
    });
    // status:'connected' with a plaintext (mock) access token — exactly what
    // exchangePublicToken persists when INTEGRATION_ENCRYPTION_KEY is unset.
    const row = await prisma.integration.create({
      data: {
        accountId: account.id,
        type: 'plaid',
        name: 'Plaid (bank import)',
        status: 'connected',
        externalRef: 'mock_item_id',
        scopesJson: '[]',
        configJson: JSON.stringify({
          accessTokenEncrypted: 'mock-access-token', // plaintext, not iv.tag.ct
          itemId: 'mock_item_id',
          cursor: null,
        }),
      },
    });

    process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    try {
      await expect(integrationService.disconnect(account.id, row.id)).resolves.toBeUndefined();
    } finally {
      delete process.env.INTEGRATION_ENCRYPTION_KEY;
    }

    const updated = await prisma.integration.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.status).toBe('disconnected');
    expect(updated.configJson).toBe('{}');
    expect(updated.externalRef).toBeNull();
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
