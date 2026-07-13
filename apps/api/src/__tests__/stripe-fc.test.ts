// Stripe Financial Connections session/complete/disconnect/import-from-bank,
// at the service layer, in mock mode (no STRIPE_SECRET_KEY set) — the real
// adapter's request/response mapping is covered in real-stripe-fc.test.ts.
// Mirrors integrations.test.ts's Plaid coverage. Note: with nothing real
// configured, importFromBank also runs the stateless mock Plaid feed, so the
// counts below include both providers — that merge is itself part of what
// these tests lock in.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { IntegrationListResponseSchema } from '@hearth/shared';
import { MOCK_FC_ACCOUNT_ID, MOCK_FC_SESSION_ID } from '../integrations/mock/mock-stripe-fc';
import { prisma } from '../lib/prisma';
import * as integrationService from '../services/integration.service';
import { runDailyJobs } from '../services/jobs.service';
import { importFromBank } from '../services/transaction.service';

let accountId: string;

beforeAll(async () => {
  const account = await prisma.account.create({
    data: { name: 'Stripe FC Test', email: 'stripe-fc-test@integrationtest.example' },
  });
  accountId = account.id;
});

afterAll(async () => {
  await prisma.account.deleteMany({ where: { email: { endsWith: '@integrationtest.example' } } });
});

describe('Stripe FC connect flow (mock mode)', () => {
  it('createStripeFcSession returns the mock session', async () => {
    const session = await integrationService.createStripeFcSession(accountId);
    expect(session.mock).toBe(true);
    expect(session.sessionId).toBe(MOCK_FC_SESSION_ID);
    expect(session.clientSecret).toBeTruthy();
    expect(session.publishableKey).toBeTruthy();
  });

  it('completeStripeFcSession rejects an unknown session id as a 400, not a 500', async () => {
    await expect(
      integrationService.completeStripeFcSession(accountId, 'fcsess_someone_elses'),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('completeStripeFcSession creates a connected row holding accounts + empty cursors', async () => {
    const integration = await integrationService.completeStripeFcSession(
      accountId,
      MOCK_FC_SESSION_ID,
    );
    expect(integration.status).toBe('connected');
    expect(integration.type).toBe('stripe_fc');

    const row = await prisma.integration.findUniqueOrThrow({ where: { id: integration.id } });
    expect(JSON.parse(row.configJson)).toMatchObject({
      customerId: 'mock_fc_customer',
      accounts: [{ id: MOCK_FC_ACCOUNT_ID, institutionName: 'Demo Bank', last4: '4321' }],
      cursors: {},
    });
  });

  it('importFromBank walks the mock cursor script (merged with the stateless mock Plaid feed)', async () => {
    // First sync: 3 Stripe FC transactions + 4 stateless mock Plaid ones
    // (this account has no Plaid row, so the Plaid feed replays its initial
    // batch each import and dedups from the second call on).
    const first = await importFromBank(accountId);
    expect(first).toEqual({ imported: 7, skipped: 0, updated: 0, removed: 0 });

    // Second sync (fc cursor fctxnref_mock_1): the pending Home Depot charge
    // posts at a settled amount; the State Farm pending auth is voided. The
    // Plaid replay contributes 4 dedup skips.
    const second = await importFromBank(accountId);
    expect(second).toEqual({ imported: 0, skipped: 4, updated: 1, removed: 1 });

    const homeDepot = await prisma.transaction.findFirstOrThrow({
      where: { accountId, externalId: 'stripe_fc_mock_1' },
    });
    expect(homeDepot).toMatchObject({
      description: 'HOME DEPOT #4521 — POSTED',
      amountCents: 8550,
      status: 'pending_review',
    });
    expect(
      await prisma.transaction.findFirst({ where: { accountId, externalId: 'stripe_fc_mock_2' } }),
    ).toBeNull();

    // Machine edits are system-attributed with provider-flavored reasons.
    const audits = await prisma.auditLog.findMany({
      where: { accountId, action: { in: ['transaction.updated', 'transaction.deleted'] } },
    });
    expect(
      audits.map((a) => ({
        action: a.action,
        reason: (JSON.parse(a.detailJson!) as { reason?: string }).reason,
      })),
    ).toEqual(
      expect.arrayContaining([
        { action: 'transaction.updated', reason: 'stripe_fc_modified' },
        { action: 'transaction.deleted', reason: 'stripe_fc_removed' },
      ]),
    );

    // The per-fca cursor advanced and lastSyncedAt was stamped.
    const row = await prisma.integration.findFirstOrThrow({
      where: { accountId, type: 'stripe_fc' },
    });
    expect(
      (JSON.parse(row.configJson) as { cursors: Record<string, string> }).cursors,
    ).toEqual({ [MOCK_FC_ACCOUNT_ID]: 'fctxnref_mock_2' });
    expect(row.lastSyncedAt).not.toBeNull();

    // Third sync: Stripe FC steady state; Plaid still replays 4 dedup skips.
    const third = await importFromBank(accountId);
    expect(third).toEqual({ imported: 0, skipped: 4, updated: 0, removed: 0 });

    // lastSyncedAt round-trips as an ISO string through the shared contract.
    const listed = IntegrationListResponseSchema.parse(await integrationService.list(accountId));
    expect(listed.find((i) => i.type === 'stripe_fc')!.lastSyncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('disconnect clears configJson back to {}', async () => {
    const rows = await prisma.integration.findMany({ where: { accountId, type: 'stripe_fc' } });
    const row = rows[0]!;
    await integrationService.disconnect(accountId, row.id);

    const updated = await prisma.integration.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.status).toBe('disconnected');
    expect(updated.configJson).toBe('{}');
    expect(updated.externalRef).toBeNull();
  });

  it('connectMock rejects type=stripe_fc — the session/complete flow must be used instead', async () => {
    await expect(integrationService.connectMock(accountId, 'stripe_fc')).rejects.toThrow(
      /session/,
    );
  });
});

describe('mock-feed safety once a real provider is configured', () => {
  const saved: Record<string, string | undefined> = {
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('with real Stripe keys set and nothing connected, import 409s instead of leaking mock Plaid rows', async () => {
    const account = await prisma.account.create({
      data: { name: 'FC Real Guard', email: 'stripe-fc-guard@integrationtest.example' },
    });
    process.env.STRIPE_SECRET_KEY = 'sk_test_guard';
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_guard';

    // Without this guard the stateless mock Plaid feed would inject demo
    // transactions into a ledger that is about to hold real bank data.
    await expect(importFromBank(account.id)).rejects.toMatchObject({
      code: 'plaid_not_connected',
    });
    expect(await prisma.transaction.count({ where: { accountId: account.id } })).toBe(0);
  });
});

describe('nightly bank sync (runDailyJobs)', () => {
  let syncAccountId: string;

  it('imports for accounts with a connected feed and surfaces the review-queue insight the same run', async () => {
    const account = await prisma.account.create({
      data: { name: 'Nightly Sync', email: 'stripe-fc-nightly@integrationtest.example' },
    });
    syncAccountId = account.id;
    await integrationService.createStripeFcSession(syncAccountId);
    await integrationService.completeStripeFcSession(syncAccountId, MOCK_FC_SESSION_ID);

    const result = await runDailyJobs();

    // First sync for this account: 3 mock FC + 4 stateless mock Plaid rows.
    expect(result.bankTransactionsImported).toBe(7);
    expect(result.errors).toEqual([]);
    const pending = await prisma.transaction.count({
      where: { accountId: syncAccountId, status: 'pending_review' },
    });
    expect(pending).toBe(7);
    // The sync ran before the insight refresh, so tonight's rows already
    // carry tonight's review-queue card.
    const card = await prisma.insight.findFirst({
      where: { accountId: syncAccountId, type: 'transactions_pending_review', status: 'active' },
    });
    expect(card?.title).toBe('7 imported transactions are waiting for review');
  });

  it('skips accounts without a connected feed — pure mock-mode accounts accrete nothing nightly', async () => {
    const account = await prisma.account.create({
      data: { name: 'Nightly No Feed', email: 'stripe-fc-nightly-nofeed@integrationtest.example' },
    });

    await runDailyJobs();

    expect(await prisma.transaction.count({ where: { accountId: account.id } })).toBe(0);
  });

  it('a feed inside its import cooldown is skipped silently, not recorded as an error', async () => {
    process.env.HEARTH_IMPORT_COOLDOWN_MINUTES = '60';
    try {
      // The connected account synced moments ago in the tests above.
      const result = await runDailyJobs();
      expect(result.bankTransactionsImported).toBe(0);
      expect(result.errors).toEqual([]);
    } finally {
      delete process.env.HEARTH_IMPORT_COOLDOWN_MINUTES;
    }
  });
});
