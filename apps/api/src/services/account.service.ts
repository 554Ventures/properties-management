// Account deletion / data erasure (docs/SECURITY_PRIVACY_AUDIT.md §B2):
//   1. requestDeletion — starts a short, cancellable grace window.
//   2. cancelDeletion — recovers the account with no data loss.
//   3. hardDeleteAccount — irreversible: purges stored Document bytes, deletes
//      the Supabase Auth identity, writes a DeletionLog proof record, then
//      deletes the Account row (Prisma cascades every child row per
//      schema.prisma's onDelete: Cascade — Property/Unit/Lease/LeaseTenant/
//      RentPayment/Tenant/Transaction/Category/Report/Insight/ChatSession/
//      ChatMessage/Integration/AuditLog/User/Document metadata).
//   4. processScheduledDeletions — the daily-scheduler sweep that calls #3
//      once a request's grace period has elapsed.
import { addDays, iso } from '../lib/dates';
import { ConflictError, NotFoundError } from '../lib/errors';
import { createStorageAdapter } from '../integrations/factory';
import { deleteSupabaseAuthUser } from '../integrations/real/supabase-admin';
import { prisma } from '../lib/prisma';
import { writeAudit } from './audit.service';

const DEFAULT_GRACE_DAYS = 7;

export function deletionGraceDays(): number {
  const raw = Number(process.env.ACCOUNT_DELETION_GRACE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GRACE_DAYS;
}

export interface RequestDeletionResult {
  deletionRequestedAt: string;
  scheduledDeletionAt: string;
}

/** Idempotent: calling again while already pending just returns the existing window. */
export async function requestDeletion(accountId: string): Promise<RequestDeletionResult> {
  const existing = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const deletionRequestedAt = existing.deletionRequestedAt ?? new Date();
  if (!existing.deletionRequestedAt) {
    await prisma.account.update({ where: { id: accountId }, data: { deletionRequestedAt } });
    await writeAudit(accountId, {
      action: 'account.deletion_requested',
      entityType: 'account',
      entityId: accountId,
    });
  }
  return {
    deletionRequestedAt: iso(deletionRequestedAt),
    scheduledDeletionAt: iso(addDays(deletionRequestedAt, deletionGraceDays())),
  };
}

export async function cancelDeletion(accountId: string): Promise<void> {
  const existing = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  if (!existing.deletionRequestedAt) {
    throw new ConflictError('No account deletion request is pending.');
  }
  await prisma.account.update({ where: { id: accountId }, data: { deletionRequestedAt: null } });
  await writeAudit(accountId, {
    action: 'account.deletion_cancelled',
    entityType: 'account',
    entityId: accountId,
  });
}

/** Irreversible. Not gated on the grace window itself — callers (the route,
 *  the scheduler sweep) decide when this is appropriate to invoke. */
export async function hardDeleteAccount(accountId: string): Promise<void> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: { users: true, documents: { select: { storageKey: true } } },
  });
  if (!account) throw new NotFoundError('account', accountId);

  const storage = createStorageAdapter();
  for (const doc of account.documents) {
    try {
      await storage.delete(doc.storageKey);
    } catch (err) {
      // Best-effort: an orphaned blob must never block account deletion.
      console.error(`[account] storage delete failed for ${doc.storageKey} (continuing)`, err);
    }
  }

  for (const user of account.users) {
    try {
      await deleteSupabaseAuthUser(user.supabaseUserId);
    } catch (err) {
      console.error(
        `[account] Supabase auth user delete failed for ${user.supabaseUserId} (continuing)`,
        err,
      );
    }
  }

  // Written before the cascade delete so it's the durable proof this
  // happened — AuditLog rows for this account are about to be cascaded away.
  await prisma.deletionLog.create({
    data: {
      accountId: account.id,
      accountEmail: account.email,
      requestedAt: account.deletionRequestedAt ?? new Date(),
    },
  });

  await prisma.account.delete({ where: { id: accountId } });
}

export interface ScheduledDeletionsResult {
  deleted: number;
  errors: Array<{ accountId: string; message: string }>;
}

/** Called by the daily scheduler (jobs.service.ts): hard-deletes every
 *  account whose grace period has elapsed. One account's failure never
 *  blocks the others. */
export async function processScheduledDeletions(): Promise<ScheduledDeletionsResult> {
  const cutoff = new Date(Date.now() - deletionGraceDays() * 24 * 60 * 60 * 1000);
  const due = await prisma.account.findMany({
    where: { deletionRequestedAt: { lte: cutoff } },
    select: { id: true },
  });
  const result: ScheduledDeletionsResult = { deleted: 0, errors: [] };
  for (const { id } of due) {
    try {
      await hardDeleteAccount(id);
      result.deleted += 1;
    } catch (err) {
      result.errors.push({ accountId: id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
