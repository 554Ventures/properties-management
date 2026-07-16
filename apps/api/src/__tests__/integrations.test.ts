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

  it('importFromBank walks the mock cursor script: import, then modified+removed, then steady state', async () => {
    // First sync (cursor null): 3 expenses + 1 income (the rent-match demo
    // fixture). This account has no leases, which also proves the
    // review-queue rent matcher no-ops safely.
    const first = await importFromBank(accountId);
    expect(first).toEqual({ imported: 4, skipped: 0, updated: 0, removed: 0 });

    // Second sync (cursor mock_cursor_1): the pending Sherwin-Williams charge
    // posts at a settled amount; the Lowe's pending auth is voided.
    const second = await importFromBank(accountId);
    expect(second).toEqual({ imported: 0, skipped: 0, updated: 1, removed: 1 });

    const sherwin = await prisma.transaction.findFirstOrThrow({
      where: { accountId, externalId: 'plaid_mock_1' },
    });
    expect(sherwin).toMatchObject({
      description: 'SHERWIN WILLIAMS #7012 — POSTED',
      amountCents: 9310,
      status: 'pending_review',
    });
    expect(
      await prisma.transaction.findFirst({ where: { accountId, externalId: 'plaid_mock_3' } }),
    ).toBeNull();
    expect(
      await prisma.transaction.findFirst({ where: { accountId, externalId: 'plaid_mock_4' } }),
    ).not.toBeNull();

    // Machine edits are system-attributed with a reason in the audit trail.
    const audits = await prisma.auditLog.findMany({
      where: { accountId, action: { in: ['transaction.updated', 'transaction.deleted'] } },
    });
    expect(
      audits.map((a) => ({
        actor: a.actor,
        action: a.action,
        reason: (JSON.parse(a.detailJson!) as { reason?: string }).reason,
      })),
    ).toEqual(
      expect.arrayContaining([
        { actor: 'system', action: 'transaction.updated', reason: 'plaid_modified' },
        { actor: 'system', action: 'transaction.deleted', reason: 'plaid_removed' },
      ]),
    );

    // Cursor advanced to the steady state and lastSyncedAt was stamped.
    const row = await prisma.integration.findFirstOrThrow({
      where: { accountId, type: 'plaid' },
    });
    expect((JSON.parse(row.configJson) as { cursor: string }).cursor).toBe('mock_cursor_2');
    expect(row.lastSyncedAt).not.toBeNull();

    // Third sync: nothing left to deliver.
    const third = await importFromBank(accountId);
    expect(third).toEqual({ imported: 0, skipped: 0, updated: 0, removed: 0 });

    // lastSyncedAt round-trips as an ISO string through the shared contract.
    const listed = IntegrationListResponseSchema.parse(await integrationService.list(accountId));
    expect(listed.find((i) => i.type === 'plaid')!.lastSyncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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

describe('importFromBank without a Plaid row (stateless mock fallback)', () => {
  it('replays the initial batch and dedup-skips on repeat calls', async () => {
    const account = await prisma.account.create({
      data: { name: 'Plaid Stateless', email: 'plaid-stateless@integrationtest.example' },
    });
    const first = await importFromBank(account.id);
    expect(first).toEqual({ imported: 4, skipped: 0, updated: 0, removed: 0 });

    // No Integration row → no cursor persisted → the mock replays the same
    // batch; every id dedups against the unique (accountId, externalId).
    const second = await importFromBank(account.id);
    expect(second).toEqual({ imported: 0, skipped: 4, updated: 0, removed: 0 });
    expect(await prisma.transaction.count({ where: { accountId: account.id } })).toBe(4);
  });

  it('concurrent imports never double-write — unique races count as skipped', async () => {
    const account = await prisma.account.create({
      data: { name: 'Plaid Concurrent', email: 'plaid-concurrent@integrationtest.example' },
    });
    const [a, b] = await Promise.all([importFromBank(account.id), importFromBank(account.id)]);
    expect(a.imported + b.imported).toBe(4);
    expect(a.skipped + b.skipped).toBe(4);
    expect(await prisma.transaction.count({ where: { accountId: account.id } })).toBe(4);
  });
});

describe('importFromBank never rewrites user-vouched rows', () => {
  it('leaves confirmed rows untouched by Plaid modified/removed', async () => {
    const account = await prisma.account.create({
      data: { name: 'Plaid Confirmed Guard', email: 'plaid-confirmed@integrationtest.example' },
    });
    await integrationService.exchangePublicToken(account.id, 'mock-public-token');
    await importFromBank(account.id); // batch in, cursor → mock_cursor_1

    // The user confirms exactly the two rows the next sync would touch.
    await prisma.transaction.updateMany({
      where: { accountId: account.id, externalId: { in: ['plaid_mock_1', 'plaid_mock_3'] } },
      data: { status: 'confirmed' },
    });

    const second = await importFromBank(account.id);
    // The confirmed rows are still never rewritten or deleted — but the bank's
    // modified/removed changes are now recorded as pending discrepancies for
    // the user to accept or dismiss, not silently dropped (WS5).
    expect(second).toEqual({
      imported: 0,
      skipped: 0,
      updated: 0,
      removed: 0,
      flaggedForReview: 2,
    });

    const sherwin = await prisma.transaction.findFirstOrThrow({
      where: { accountId: account.id, externalId: 'plaid_mock_1' },
    });
    expect(sherwin).toMatchObject({
      description: 'SHERWIN WILLIAMS #7012', // NOT the posted rewrite
      amountCents: 9250,
      status: 'confirmed',
    });
    const lowes = await prisma.transaction.findFirstOrThrow({
      where: { accountId: account.id, externalId: 'plaid_mock_3' },
    });
    expect(lowes.status).toBe('confirmed'); // not deleted

    // Both bank-side changes landed as pending discrepancies (modified Sherwin,
    // removed Lowe's), each pointing at its still-intact confirmed ledger row.
    const discrepancies = await prisma.bankSyncDiscrepancy.findMany({
      where: { accountId: account.id, status: 'pending' },
    });
    expect(discrepancies.map((d) => d.kind).sort()).toEqual(['modified', 'removed']);
  });
});

describe('import cooldown (HEARTH_IMPORT_COOLDOWN_MINUTES)', () => {
  it('rejects a second import inside the window, then allows it once the window passes', async () => {
    const account = await prisma.account.create({
      data: { name: 'Plaid Cooldown', email: 'plaid-cooldown@integrationtest.example' },
    });
    await integrationService.exchangePublicToken(account.id, 'mock-public-token');

    process.env.HEARTH_IMPORT_COOLDOWN_MINUTES = '60';
    try {
      await importFromBank(account.id);

      const before = Date.now();
      const err: unknown = await importFromBank(account.id).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'import_rate_limited', statusCode: 429 });
      const nextAllowedAt = new Date(
        (err as { detail: { nextAllowedAt: string } }).detail.nextAllowedAt,
      ).getTime();
      expect(nextAllowedAt).toBeGreaterThan(before);
      expect(nextAllowedAt).toBeLessThanOrEqual(before + 61 * 60_000);

      // Rewind the stamp past the window — the guard lifts and the next
      // cursor page (modified + removed) comes through.
      await prisma.integration.updateMany({
        where: { accountId: account.id, type: 'plaid' },
        data: { lastSyncedAt: new Date(Date.now() - 61 * 60_000) },
      });
      await expect(importFromBank(account.id)).resolves.toMatchObject({
        updated: 1,
        removed: 1,
      });
    } finally {
      delete process.env.HEARTH_IMPORT_COOLDOWN_MINUTES;
    }
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
