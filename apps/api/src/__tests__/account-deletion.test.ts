// Data erasure — account closure (docs/SECURITY_PRIVACY_AUDIT.md §B2):
// request/cancel grace-window flow + the irreversible hard-delete + the
// scheduler sweep. Service-level tests use throwaway accounts (never the
// shared demo account, which every other test file's fixtures depend on);
// the one route-level test that touches the demo account only exercises the
// reversible request/cancel path and force-clears it in `afterAll` no matter
// what, so a failed assertion can never leave the shared demo account
// scheduled for deletion.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { addDays } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import * as accountService from '../services/account.service';
import * as documentService from '../services/document.service';

process.env.STORAGE_DIR = mkdtempSync(path.join(os.tmpdir(), 'hearth-deletion-test-'));

async function makeAccount(email: string) {
  return prisma.account.create({ data: { name: 'Deletion Test', email } });
}

afterAll(async () => {
  await prisma.account.deleteMany({ where: { email: { endsWith: '@deletiontest.example' } } });
});

describe('requestDeletion / cancelDeletion', () => {
  it('starts a grace window and is idempotent on repeat requests', async () => {
    const account = await makeAccount('request-a@deletiontest.example');
    const first = await accountService.requestDeletion(account.id);
    const second = await accountService.requestDeletion(account.id);
    expect(first).toEqual(second); // same requestedAt, not reset on re-request

    const row = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(row.deletionRequestedAt).not.toBeNull();
    expect(first.scheduledDeletionAt).toBe(
      addDays(row.deletionRequestedAt!, accountService.deletionGraceDays()).toISOString(),
    );

    const audits = await prisma.auditLog.findMany({
      where: { accountId: account.id, action: 'account.deletion_requested' },
    });
    expect(audits).toHaveLength(1); // not duplicated by the idempotent second call
  });

  it('cancelDeletion clears the request; a second cancel throws conflict', async () => {
    const account = await makeAccount('cancel-a@deletiontest.example');
    await accountService.requestDeletion(account.id);
    await accountService.cancelDeletion(account.id);

    const row = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(row.deletionRequestedAt).toBeNull();

    await expect(accountService.cancelDeletion(account.id)).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});

describe('hardDeleteAccount', () => {
  it('purges Document storage bytes, cascades every child row, and writes a DeletionLog proof', async () => {
    const account = await makeAccount('harddelete-a@deletiontest.example');
    const property = await prisma.property.create({
      data: { accountId: account.id, addressLine1: '1 Erase St', city: 'X', state: 'YY', zip: '00000' },
    });
    const tenant = await prisma.tenant.create({
      data: { accountId: account.id, fullName: 'Erase Me' },
    });
    const document = await documentService.create(account.id, {
      entityType: 'property',
      entityId: property.id,
      type: 'other',
      name: 'erase-me.pdf',
      buffer: Buffer.from('%PDF-1.4\nerase\n%%EOF', 'utf-8'),
      mimeType: 'application/pdf',
    });
    // Document bytes exist before deletion. storageKey is internal-only (not
    // on the public Document schema) — read it via the raw row for the
    // post-deletion storage-adapter check below.
    await expect(documentService.getForDownload(account.id, document.id)).resolves.toBeTruthy();
    const documentRow = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });

    await accountService.hardDeleteAccount(account.id);

    expect(await prisma.account.findUnique({ where: { id: account.id } })).toBeNull();
    expect(await prisma.property.findUnique({ where: { id: property.id } })).toBeNull();
    expect(await prisma.tenant.findUnique({ where: { id: tenant.id } })).toBeNull();
    expect(await prisma.document.findUnique({ where: { id: document.id } })).toBeNull();

    const log = await prisma.deletionLog.findFirst({ where: { accountId: account.id } });
    expect(log).not.toBeNull();
    expect(log!.accountEmail).toBe('harddelete-a@deletiontest.example');

    // Storage bytes are actually gone, not just the DB row.
    const { createStorageAdapter } = await import('../integrations/factory');
    await expect(createStorageAdapter().get(documentRow.storageKey)).resolves.toBeNull();
  });

  it('throws not_found for an account that does not exist', async () => {
    await expect(accountService.hardDeleteAccount('nonexistent-id')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  describe('Supabase Auth identity deletion', () => {
    const fetchSpy = vi.fn();

    afterEach(() => {
      fetchSpy.mockReset();
      vi.unstubAllGlobals();
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    });

    it('calls the Supabase admin delete-user endpoint for each linked User when configured', async () => {
      process.env.SUPABASE_URL = 'https://project.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
      fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);

      const account = await makeAccount('supabase-a@deletiontest.example');
      await prisma.user.create({
        data: { accountId: account.id, supabaseUserId: 'sb-user-123', email: account.email },
      });

      await accountService.hardDeleteAccount(account.id);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toBe('https://project.supabase.co/auth/v1/admin/users/sb-user-123');
      expect(init.method).toBe('DELETE');
      expect(init.headers.Authorization).toBe('Bearer service-role-key');
    });

    it('skips Supabase Auth deletion silently (no fetch call) when unconfigured — demo mode', async () => {
      fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);

      const account = await makeAccount('nosupabase-a@deletiontest.example');
      await prisma.user.create({
        data: { accountId: account.id, supabaseUserId: 'sb-user-456', email: account.email },
      });

      await accountService.hardDeleteAccount(account.id);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await prisma.account.findUnique({ where: { id: account.id } })).toBeNull();
    });

    it('still deletes the account locally even if the Supabase admin call fails', async () => {
      process.env.SUPABASE_URL = 'https://project.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
      fetchSpy.mockResolvedValue(new Response('server error', { status: 500 }));
      vi.stubGlobal('fetch', fetchSpy);

      const account = await makeAccount('supabase-fail@deletiontest.example');
      await prisma.user.create({
        data: { accountId: account.id, supabaseUserId: 'sb-user-789', email: account.email },
      });

      await expect(accountService.hardDeleteAccount(account.id)).resolves.toBeUndefined();
      expect(await prisma.account.findUnique({ where: { id: account.id } })).toBeNull();
    });
  });
});

describe('processScheduledDeletions (the daily-scheduler sweep)', () => {
  afterEach(() => {
    delete process.env.ACCOUNT_DELETION_GRACE_DAYS;
  });

  it('deletes only accounts whose grace period has elapsed, leaves others untouched', async () => {
    process.env.ACCOUNT_DELETION_GRACE_DAYS = '2';

    const overdue = await makeAccount('overdue@deletiontest.example');
    await prisma.account.update({
      where: { id: overdue.id },
      data: { deletionRequestedAt: addDays(new Date(), -3) }, // 3 days ago, grace is 2
    });

    const withinGrace = await makeAccount('within-grace@deletiontest.example');
    await prisma.account.update({
      where: { id: withinGrace.id },
      data: { deletionRequestedAt: addDays(new Date(), -1) }, // 1 day ago, grace is 2
    });

    const notPending = await makeAccount('not-pending@deletiontest.example');

    const result = await accountService.processScheduledDeletions();

    expect(result.errors).toEqual([]);
    expect(await prisma.account.findUnique({ where: { id: overdue.id } })).toBeNull();
    expect(await prisma.account.findUnique({ where: { id: withinGrace.id } })).not.toBeNull();
    expect(await prisma.account.findUnique({ where: { id: notPending.id } })).not.toBeNull();

    const log = await prisma.deletionLog.findFirst({ where: { accountId: overdue.id } });
    expect(log).not.toBeNull();

    // These two survived this test on purpose (to prove the sweep leaves
    // them alone) — remove them now so a later test's *different* grace
    // period can't retroactively sweep them up too.
    await prisma.account.deleteMany({ where: { id: { in: [withinGrace.id, notPending.id] } } });
  });

  it("isolates one account's deletion failure from the rest of the sweep", async () => {
    process.env.ACCOUNT_DELETION_GRACE_DAYS = '1';

    const willFail = await makeAccount('will-fail@deletiontest.example');
    await prisma.account.update({
      where: { id: willFail.id },
      data: { deletionRequestedAt: addDays(new Date(), -5) },
    });
    const willSucceed = await makeAccount('will-succeed@deletiontest.example');
    await prisma.account.update({
      where: { id: willSucceed.id },
      data: { deletionRequestedAt: addDays(new Date(), -5) },
    });

    // Simulate a genuine mid-sweep failure for exactly one account (e.g. a
    // transient DB error) without disturbing the other — real prisma calls
    // pass through for every other id.
    const realDelete = prisma.account.delete.bind(prisma.account);
    const deleteSpy = vi
      .spyOn(prisma.account, 'delete')
      .mockImplementation(((args: Parameters<typeof prisma.account.delete>[0]) => {
        if (args.where.id === willFail.id) {
          return Promise.reject(new Error('simulated transient failure'));
        }
        return realDelete(args);
      }) as unknown as typeof prisma.account.delete);

    try {
      const result = await accountService.processScheduledDeletions();
      expect(result.deleted).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        accountId: willFail.id,
        message: 'simulated transient failure',
      });
      expect(await prisma.account.findUnique({ where: { id: willSucceed.id } })).toBeNull();
      // The one that "failed" is untouched — still there, still pending.
      expect(await prisma.account.findUnique({ where: { id: willFail.id } })).not.toBeNull();
    } finally {
      deleteSpy.mockRestore();
      await prisma.account.deleteMany({ where: { id: willFail.id } });
    }
  });
});

describe('POST/DELETE /settings/account/deletion (route)', () => {
  let app: FastifyInstance;
  let demoAccountId: string;

  beforeAll(async () => {
    app = await buildApp();
    demoAccountId = await getDemoAccountId();
  });

  afterAll(async () => {
    // Unconditional safety net: never leave the shared demo account scheduled
    // for deletion, regardless of how the test below finished.
    await prisma.account.update({
      where: { id: demoAccountId },
      data: { deletionRequestedAt: null },
    });
    await app.close();
  });

  it('request → GET reflects it → cancel → GET clears it', async () => {
    const requestRes = await app.inject({ method: 'POST', url: '/api/v1/settings/account/deletion' });
    expect(requestRes.statusCode).toBe(202);
    expect(requestRes.json().deletionRequestedAt).toBeTruthy();

    const afterRequest = await app.inject({ method: 'GET', url: '/api/v1/settings/account' });
    expect(afterRequest.json().deletionRequestedAt).toBeTruthy();

    const cancelRes = await app.inject({ method: 'DELETE', url: '/api/v1/settings/account/deletion' });
    expect(cancelRes.statusCode).toBe(204);

    const afterCancel = await app.inject({ method: 'GET', url: '/api/v1/settings/account' });
    expect(afterCancel.json().deletionRequestedAt).toBeNull();

    // Cancelling again with nothing pending is a 409.
    const secondCancel = await app.inject({ method: 'DELETE', url: '/api/v1/settings/account/deletion' });
    expect(secondCancel.statusCode).toBe(409);
  });
});
