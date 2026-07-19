// Per-user notification preferences + category-routed delivery for scheduler
// notifications (warning insights, weekly brief, monthly review). Prefs are
// stored sparse (User.notificationPrefsJson; Account.notificationPrefsJson in
// demo mode, which has no User rows) and merged over
// DEFAULT_NOTIFICATION_PREFS on read. No AuditLog on pref writes — not
// money/tenant-touching (precedent: push.service device registration).
import {
  DEFAULT_NOTIFICATION_PREFS,
  NotificationPrefsSchema,
  type NotificationCategory,
  type NotificationPrefs,
} from '@hearth/shared';
import { createEmailAdapter } from '../integrations/factory';
import type { PushMessage } from '../integrations/types';
import { prisma } from '../lib/prisma';
import { notifyAccount, sendToDevices } from './push.service';

/** Sparse stored JSON → full prefs. Corrupt/foreign JSON degrades to defaults. */
function mergePrefs(storedJson: string): NotificationPrefs {
  let overrides: Partial<NotificationPrefs> = {};
  try {
    const parsed = NotificationPrefsSchema.partial().safeParse(JSON.parse(storedJson));
    if (parsed.success) overrides = parsed.data;
  } catch {
    // Corrupt JSON → defaults, never throw.
  }
  return {
    warning_insights: {
      ...DEFAULT_NOTIFICATION_PREFS.warning_insights,
      ...overrides.warning_insights,
    },
    weekly_brief: { ...DEFAULT_NOTIFICATION_PREFS.weekly_brief, ...overrides.weekly_brief },
    monthly_review: {
      ...DEFAULT_NOTIFICATION_PREFS.monthly_review,
      ...overrides.monthly_review,
    },
  };
}

/** userId null = demo mode (no User rows) → the account-level store. */
export async function getPrefs(
  accountId: string,
  userId: string | null,
): Promise<NotificationPrefs> {
  if (userId === null) {
    const account = await prisma.account.findUnique({ where: { id: accountId } });
    return mergePrefs(account?.notificationPrefsJson ?? '{}');
  }
  const user = await prisma.user.findFirst({ where: { id: userId, accountId } });
  return mergePrefs(user?.notificationPrefsJson ?? '{}');
}

/** Full-object replace into the caller's own row (self-service — see routes). */
export async function updatePrefs(
  accountId: string,
  userId: string | null,
  input: NotificationPrefs,
): Promise<NotificationPrefs> {
  const notificationPrefsJson = JSON.stringify(input);
  if (userId === null) {
    await prisma.account.update({ where: { id: accountId }, data: { notificationPrefsJson } });
  } else {
    await prisma.user.updateMany({
      where: { id: userId, accountId },
      data: { notificationPrefsJson },
    });
  }
  return input;
}

export interface CategoryMessage {
  push: PushMessage;
  email?: { subject: string; body: string };
}

/**
 * Deliver a category notification to every recipient on the account per their
 * prefs. Fire-and-forget: NEVER throws (mirrors push.service.notifyAccount) —
 * a delivery failure must not fail the job/write that triggered it.
 *
 * Demo mode (no User rows): account-level prefs; push fans out to all account
 * devices, email goes to Account.email. Supabase mode: per user — email to the
 * user's sign-in address, push to the devices stamped with their userId
 * (null-userId legacy/demo rows follow the OWNER, matching the account-wide
 * behavior they were registered under).
 */
export async function notifyCategory(
  accountId: string,
  category: NotificationCategory,
  msg: CategoryMessage,
): Promise<void> {
  try {
    const users = await prisma.user.findMany({ where: { accountId } });
    if (users.length === 0) {
      const prefs = await getPrefs(accountId, null);
      if (prefs[category].push) await notifyAccount(accountId, msg.push);
      if (prefs[category].email && msg.email) {
        const account = await prisma.account.findUnique({ where: { id: accountId } });
        if (account) {
          try {
            await createEmailAdapter().send({ to: account.email, ...msg.email });
          } catch (err) {
            console.warn(
              '[notify] email send failed:',
              err instanceof Error ? err.message : err,
            );
          }
        }
      }
      return;
    }
    for (const user of users) {
      const prefs = mergePrefs(user.notificationPrefsJson);
      if (prefs[category].email && msg.email) {
        try {
          await createEmailAdapter().send({ to: user.email, ...msg.email });
        } catch (err) {
          console.warn('[notify] email send failed:', err instanceof Error ? err.message : err);
        }
      }
      if (prefs[category].push) {
        const devices = await prisma.pushDevice.findMany({
          where: {
            accountId,
            OR: [{ userId: user.id }, ...(user.role === 'owner' ? [{ userId: null }] : [])],
          },
        });
        await sendToDevices(devices, msg.push);
      }
    }
  } catch (err) {
    console.warn('[notify] notifyCategory failed:', err instanceof Error ? err.message : err);
  }
}
