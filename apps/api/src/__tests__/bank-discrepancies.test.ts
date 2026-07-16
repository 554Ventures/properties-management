// WS5 — bank-correction surface + scheduler visibility. When a bank
// `modified`/`removed` change lands on a row the user already confirmed,
// applySyncBatch records a pending BankSyncDiscrepancy instead of silently
// rewriting the vouched ledger (which left stale P&L). The user accepts (apply
// the restated values through the SAME guarded update/remove, so rent-link
// protections hold) or dismisses. jobs.service stamps sync-failure health;
// insight rules surface both. Own throwaway fixtures, cleaned up in afterAll —
// never touches the seeded demo account (later files pin it exactly).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import {
  BankDiscrepancyListResponseSchema,
  BankDiscrepancyResolutionSchema,
  ImportTransactionsResponseSchema,
} from '@hearth/shared';
import { buildApp } from '../app';
import { addDays, currentPeriod } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { MOCK_FC_SESSION_ID } from '../integrations/mock/mock-stripe-fc';
import { resetAuthServiceCache } from '../services/auth.service';
import * as insightService from '../services/insight.service';
import * as integrationService from '../services/integration.service';
import * as leaseService from '../services/lease.service';
import * as propertyService from '../services/property.service';
import * as rentService from '../services/rent.service';
import * as tenantService from '../services/tenant.service';
import { runDailyJobs } from '../services/jobs.service';
import {
  acceptBankDiscrepancy,
  dismissBankDiscrepancy,
  importFromBank,
  listBankDiscrepancies,
} from '../services/transaction.service';

const EMAIL = (s: string) => `bank-disc-${s}@bankdisctest.example`;

afterAll(async () => {
  await prisma.account.deleteMany({ where: { email: { endsWith: '@bankdisctest.example' } } });
});

/** Connected mock Plaid account whose plaid_mock_1 (modified) + plaid_mock_3
 *  (removed) rows have been confirmed, then re-synced — leaving two pending
 *  discrepancies against the two still-intact confirmed ledger rows. */
async function setupConfirmedDiscrepancies(suffix: string) {
  const account = await prisma.account.create({
    data: { name: `Bank Disc ${suffix}`, email: EMAIL(suffix) },
  });
  await integrationService.exchangePublicToken(account.id, 'mock-public-token');
  await importFromBank(account.id); // 4 pending rows; cursor → mock_cursor_1
  // The user vouches for exactly the two rows the next sync page touches.
  await prisma.transaction.updateMany({
    where: { accountId: account.id, externalId: { in: ['plaid_mock_1', 'plaid_mock_3'] } },
    data: { status: 'confirmed' },
  });
  const reimport = await importFromBank(account.id); // modified + removed → discrepancies
  return { accountId: account.id, reimport };
}

describe('recording bank-side changes against confirmed rows', () => {
  let accountId: string;
  let reimport: Awaited<ReturnType<typeof importFromBank>>;

  beforeAll(async () => {
    ({ accountId, reimport } = await setupConfirmedDiscrepancies('record'));
  });

  it('records modified + removed as pending discrepancies, leaves the ledger untouched, and reports flaggedForReview', async () => {
    // The import result carries the flagged count (2), and never claims to have
    // updated/removed the confirmed ledger rows.
    const parsed = ImportTransactionsResponseSchema.parse(reimport);
    expect(parsed).toEqual({
      imported: 0,
      skipped: 0,
      updated: 0,
      removed: 0,
      flaggedForReview: 2,
    });

    // Ledger untouched: Sherwin not rewritten to the POSTED amount, Lowe's not deleted.
    const sherwin = await prisma.transaction.findFirstOrThrow({
      where: { accountId, externalId: 'plaid_mock_1' },
    });
    expect(sherwin).toMatchObject({
      description: 'SHERWIN WILLIAMS #7012',
      amountCents: 9250,
      status: 'confirmed',
    });
    const lowes = await prisma.transaction.findFirst({
      where: { accountId, externalId: 'plaid_mock_3' },
    });
    expect(lowes?.status).toBe('confirmed');

    // Two pending discrepancies with the restated bank data (null for removed).
    const list = BankDiscrepancyListResponseSchema.parse(await listBankDiscrepancies(accountId));
    expect(list.items).toHaveLength(2);
    const modified = list.items.find((d) => d.kind === 'modified');
    const removed = list.items.find((d) => d.kind === 'removed');
    expect(modified?.externalId).toBe('plaid_mock_1');
    expect(modified?.bankData).toMatchObject({ amountCents: 9310, type: 'expense' });
    expect(modified?.transaction).toMatchObject({ id: sherwin.id, amountCents: 9250 });
    expect(removed?.externalId).toBe('plaid_mock_3');
    expect(removed?.bankData).toBeNull();
    expect(removed?.transaction?.id).toBe(lowes?.id);

    // System-attributed audit for the recording (one per created discrepancy).
    const audits = await prisma.auditLog.findMany({
      where: { accountId, action: 'bank_discrepancy.recorded' },
    });
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.actor === 'system')).toBe(true);
  });

  it('re-running the same sync batch refreshes the pending row without duplicating it', async () => {
    const before = await prisma.bankSyncDiscrepancy.findFirstOrThrow({
      where: { accountId, kind: 'modified', status: 'pending' },
    });
    // Simulate a stale stored payload, then rewind the cursor so the next sync
    // re-delivers the same modified/removed page.
    await prisma.bankSyncDiscrepancy.update({
      where: { id: before.id },
      data: { bankDataJson: JSON.stringify({ stale: true }) },
    });
    const plaid = await prisma.integration.findFirstOrThrow({ where: { accountId, type: 'plaid' } });
    await prisma.integration.update({
      where: { id: plaid.id },
      data: { configJson: JSON.stringify({ ...JSON.parse(plaid.configJson), cursor: 'mock_cursor_1' }) },
    });

    const replay = await importFromBank(accountId);
    expect(replay.flaggedForReview).toBe(2);

    // Still exactly two pending rows (same ids) — no accretion.
    const after = await prisma.bankSyncDiscrepancy.findMany({
      where: { accountId, status: 'pending' },
    });
    expect(after).toHaveLength(2);
    // The stale payload was refreshed back to the restated bank values.
    const modified = await prisma.bankSyncDiscrepancy.findUniqueOrThrow({ where: { id: before.id } });
    expect(JSON.parse(modified.bankDataJson!)).toMatchObject({ amountCents: 9310 });
    // A replay must not re-audit (create-only attribution — no spam).
    const audits = await prisma.auditLog.count({
      where: { accountId, action: 'bank_discrepancy.recorded' },
    });
    expect(audits).toBe(2);
  });
});

describe('accepting a bank change applies the restated values through the guarded path', () => {
  it("accept('modified') updates the ledger row and marks the discrepancy accepted", async () => {
    const { accountId } = await setupConfirmedDiscrepancies('accept');
    const list = await listBankDiscrepancies(accountId);
    const modified = list.items.find((d) => d.kind === 'modified')!;

    const resolution = BankDiscrepancyResolutionSchema.parse(
      await acceptBankDiscrepancy(accountId, modified.id),
    );
    expect(resolution).toMatchObject({ id: modified.id, status: 'accepted' });
    expect(resolution.resolvedAt).not.toBeNull();

    // The bank's restated values were applied to the confirmed ledger row.
    const sherwin = await prisma.transaction.findFirstOrThrow({
      where: { accountId, externalId: 'plaid_mock_1' },
    });
    expect(sherwin).toMatchObject({
      description: 'SHERWIN WILLIAMS #7012 — POSTED',
      amountCents: 9310,
      status: 'confirmed',
    });

    // It leaves the pending list (only the removed one remains).
    const after = await listBankDiscrepancies(accountId);
    expect(after.items.map((d) => d.kind)).toEqual(['removed']);

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'bank_discrepancy.accepted', entityId: modified.id },
    });
    expect(audit?.actor).toBe('user');
  });
});

describe('a rent-linked row is protected by the same guard, then acceptable after unlinking', () => {
  it('400s while the deposit is linked, stays pending, then accepts once unlinked', async () => {
    const account = await prisma.account.create({
      data: { name: 'Bank Disc Rent', email: EMAIL('rent') },
    });
    const property = await propertyService.create(account.id, {
      addressLine1: '1 Rent Link Way',
      city: 'Springfield',
      state: 'IL',
      zip: '62701',
      units: [{ label: 'A' }],
    });
    const detail = await propertyService.getDetail(account.id, property.id);
    const unitId = detail.units[0]!.id;
    const tenant = await tenantService.create(account.id, { fullName: 'Rent Payer' });
    const period = currentPeriod();
    await leaseService.create(account.id, {
      unitId,
      tenantIds: [tenant.id],
      rentCents: 100000,
      dueDay: 1,
      startDate: new Date(Date.now() - 200 * 86_400_000).toISOString(),
      endDate: new Date(Date.now() + 200 * 86_400_000).toISOString(),
    });
    const lease = await prisma.lease.findFirstOrThrow({ where: { unitId } });

    // Record full rent → a confirmed ledger row backing a deposit (rent-linked).
    await rentService.recordPayment(account.id, {
      leaseId: lease.id,
      period,
      amountCents: 100000,
      method: 'manual',
    });
    const depositTxn = await prisma.transaction.findFirstOrThrow({
      where: { accountId: account.id, unitId, type: 'income' },
    });

    // A bank restatement of that deposit's amount, recorded as a discrepancy.
    const discrepancy = await prisma.bankSyncDiscrepancy.create({
      data: {
        accountId: account.id,
        transactionId: depositTxn.id,
        externalId: 'ext_rent_restate_1',
        provider: 'plaid',
        kind: 'modified',
        status: 'pending',
        bankDataJson: JSON.stringify({
          date: depositTxn.date.toISOString(),
          amountCents: 100500, // differs → trips the rent-link guard
          type: 'income',
          description: depositTxn.description,
          vendor: null,
        }),
      },
    });

    // The list carries the guided-unlink context (rentPaymentId + depositId + period).
    const list = BankDiscrepancyListResponseSchema.parse(await listBankDiscrepancies(account.id));
    const row = list.items.find((d) => d.id === discrepancy.id)!;
    expect(row.rentPaymentId).toBeTruthy();
    expect(row.depositId).toBeTruthy();
    expect(row.rentPeriod).toBe(period);

    // Accept goes through update() → rent-link guard → 400; discrepancy untouched.
    await expect(acceptBankDiscrepancy(account.id, discrepancy.id)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(
      (await prisma.bankSyncDiscrepancy.findUniqueOrThrow({ where: { id: discrepancy.id } })).status,
    ).toBe('pending');
    // Ledger amount unchanged (the guard blocked the write).
    expect(
      (await prisma.transaction.findUniqueOrThrow({ where: { id: depositTxn.id } })).amountCents,
    ).toBe(100000);

    // Unlink the deposit (the sanctioned path), then accept succeeds.
    await rentService.unlinkDeposit(account.id, row.rentPaymentId!, row.depositId!);
    const resolution = await acceptBankDiscrepancy(account.id, discrepancy.id);
    expect(resolution.status).toBe('accepted');
    expect(
      (await prisma.transaction.findUniqueOrThrow({ where: { id: depositTxn.id } })).amountCents,
    ).toBe(100500);
  });
});

describe('dismiss is terminal', () => {
  it('marks the discrepancy dismissed and rejects any further resolution', async () => {
    const account = await prisma.account.create({
      data: { name: 'Bank Disc Dismiss', email: EMAIL('dismiss') },
    });
    const txn = await prisma.transaction.create({
      data: {
        accountId: account.id,
        date: new Date(),
        amountCents: 4200,
        type: 'expense',
        description: 'CONFIRMED CHARGE',
        source: 'bank',
        status: 'confirmed',
        externalId: 'ext_dismiss_1',
      },
    });
    const discrepancy = await prisma.bankSyncDiscrepancy.create({
      data: {
        accountId: account.id,
        transactionId: txn.id,
        externalId: 'ext_dismiss_1',
        provider: 'plaid',
        kind: 'removed',
        status: 'pending',
      },
    });

    const resolution = BankDiscrepancyResolutionSchema.parse(
      await dismissBankDiscrepancy(account.id, discrepancy.id),
    );
    expect(resolution).toMatchObject({ status: 'dismissed' });
    expect(resolution.resolvedAt).not.toBeNull();
    // The ledger row is kept (dismiss = "keep my version").
    expect(await prisma.transaction.findUnique({ where: { id: txn.id } })).not.toBeNull();

    // Terminal: neither dismiss nor accept can act on it again.
    await expect(dismissBankDiscrepancy(account.id, discrepancy.id)).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(acceptBankDiscrepancy(account.id, discrepancy.id)).rejects.toMatchObject({
      statusCode: 400,
    });
    // Gone from the pending list.
    const list = await listBankDiscrepancies(account.id);
    expect(list.items).toHaveLength(0);
  });
});

describe('bank_discrepancies insight', () => {
  it('appears in the insight list while a pending discrepancy exists', async () => {
    const account = await prisma.account.create({
      data: { name: 'Bank Disc Insight', email: EMAIL('insight') },
    });
    const txn = await prisma.transaction.create({
      data: {
        accountId: account.id,
        date: new Date(),
        amountCents: 5000,
        type: 'expense',
        description: 'CONFIRMED',
        source: 'bank',
        status: 'confirmed',
        externalId: 'ext_insight_1',
      },
    });
    await prisma.bankSyncDiscrepancy.create({
      data: {
        accountId: account.id,
        transactionId: txn.id,
        externalId: 'ext_insight_1',
        provider: 'plaid',
        kind: 'modified',
        status: 'pending',
        bankDataJson: JSON.stringify({
          date: txn.date.toISOString(),
          amountCents: 5100,
          type: 'expense',
          description: 'CONFIRMED — POSTED',
          vendor: null,
        }),
      },
    });

    const active = await insightService.listActive(account.id);
    const insight = active.find((i) => i.type === 'bank_discrepancies');
    expect(insight).toBeDefined();
    expect(insight!.severity).toBe('warning');
    expect(insight!.actionTarget).toBe('/money/review');
    expect(insight!.title).toContain('1');
  });
});

describe('scheduler sync-health', () => {
  it('increments syncFailureCount over consecutive nightly failures, raises the insight, and resets on success', async () => {
    const account = await prisma.account.create({
      data: { name: 'Bank Disc Jobs', email: EMAIL('jobs') },
    });
    await integrationService.createStripeFcSession(account.id);
    await integrationService.completeStripeFcSession(account.id, MOCK_FC_SESSION_ID);
    // Corrupt the stored config so importFromBank throws when it parses it —
    // a forced, deterministic sync failure the nightly runner must record.
    const fc = await prisma.integration.findFirstOrThrow({
      where: { accountId: account.id, type: 'stripe_fc' },
    });
    await prisma.integration.update({ where: { id: fc.id }, data: { configJson: 'not-json' } });

    for (let i = 0; i < 3; i += 1) await runDailyJobs();

    const failed = await prisma.integration.findFirstOrThrow({
      where: { accountId: account.id, type: 'stripe_fc' },
    });
    expect(failed.syncFailureCount).toBe(3);
    expect(failed.lastSyncError).toBeTruthy();
    expect(failed.lastSyncErrorAt).not.toBeNull();

    // The warning insight fires at >= 3 consecutive failures.
    const active = await insightService.listActive(account.id);
    const failing = active.find((i) => i.type === 'bank_sync_failing');
    expect(failing).toBeDefined();
    expect(failing!.severity).toBe('warning');
    expect(failing!.actionTarget).toBe('/settings');

    // A successful sync clears the health. Re-complete the session to restore a
    // valid config, then run once more.
    await integrationService.completeStripeFcSession(account.id, MOCK_FC_SESSION_ID);
    await runDailyJobs();

    const recovered = await prisma.integration.findFirstOrThrow({
      where: { accountId: account.id, type: 'stripe_fc' },
    });
    expect(recovered.syncFailureCount).toBe(0);
    expect(recovered.lastSyncError).toBeNull();
    expect(recovered.lastSyncErrorAt).toBeNull();
  });
});

describe('permission enforcement (Supabase mode)', () => {
  const TEST_SECRET = 'test-jwt-secret-with-at-least-32-characters!';
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
    resetAuthServiceCache();
    app = await buildApp();
  });

  afterAll(async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    resetAuthServiceCache();
    await app.close();
  });

  it("403s a member without 'money' on accept", async () => {
    const account = await prisma.account.create({
      data: { name: 'Bank Disc Authz', email: EMAIL('authz') },
    });
    // A member with no grants attached to the account.
    await prisma.user.create({
      data: {
        accountId: account.id,
        supabaseUserId: 'bank-disc-member',
        email: EMAIL('member'),
        role: 'member',
        permissionsJson: '[]',
      },
    });
    const txn = await prisma.transaction.create({
      data: {
        accountId: account.id,
        date: new Date(),
        amountCents: 4200,
        type: 'expense',
        description: 'CONFIRMED',
        source: 'bank',
        status: 'confirmed',
        externalId: 'ext_authz_1',
      },
    });
    const discrepancy = await prisma.bankSyncDiscrepancy.create({
      data: {
        accountId: account.id,
        transactionId: txn.id,
        externalId: 'ext_authz_1',
        provider: 'plaid',
        kind: 'removed',
        status: 'pending',
      },
    });

    const token = await new SignJWT({ email: EMAIL('member'), aud: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('bank-disc-member')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(TEST_SECRET));

    // Reads stay open to any member.
    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/transactions/bank-discrepancies',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.statusCode).toBe(200);

    // The write is gated on 'money'.
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/bank-discrepancies/${discrepancy.id}/accept`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
    // The write never happened — still pending.
    expect(
      (await prisma.bankSyncDiscrepancy.findUniqueOrThrow({ where: { id: discrepancy.id } })).status,
    ).toBe('pending');
  });
});
