// Push device registry + fan-out (Phase 2 iOS shell). No AuditLog here: device
// registration isn't money/tenant-touching (precedent: integration.service).
import type { PushDevice, RegisterDeviceInput } from '@hearth/shared';
import type { PushDevice as DbPushDevice } from '@prisma/client';
import { createPushProvider } from '../integrations/factory';
import type { PushMessage } from '../integrations/types';
import { iso } from '../lib/dates';
import { prisma } from '../lib/prisma';

export function toApiPushDevice(d: DbPushDevice): PushDevice {
  return {
    id: d.id,
    accountId: d.accountId,
    platform: d.platform as PushDevice['platform'],
    token: d.token,
    createdAt: iso(d.createdAt),
    lastSeenAt: iso(d.lastSeenAt),
  };
}

/**
 * Idempotent: the app re-registers its token on every launch. An existing
 * token is reassigned to the authenticated account (APNs tokens follow the
 * device, not the signed-in user) and lastSeenAt is bumped.
 */
export async function registerDevice(
  accountId: string,
  input: RegisterDeviceInput,
): Promise<PushDevice> {
  const row = await prisma.pushDevice.upsert({
    where: { token: input.token },
    create: { accountId, platform: input.platform, token: input.token },
    update: { accountId, platform: input.platform, lastSeenAt: new Date() },
  });
  return toApiPushDevice(row);
}

export async function listDevices(accountId: string): Promise<PushDevice[]> {
  const rows = await prisma.pushDevice.findMany({
    where: { accountId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toApiPushDevice);
}

/** Account-scoped, idempotent: deleting a token you don't own is a no-op. */
export async function unregisterDevice(accountId: string, token: string): Promise<void> {
  await prisma.pushDevice.deleteMany({ where: { accountId, token } });
}

/**
 * Send `message` to every device on the account. Fire-and-forget semantics:
 * NEVER throws — a push failure must not fail the write that triggered it.
 * Tokens APNs reports as unregistered are pruned.
 */
export async function notifyAccount(accountId: string, message: PushMessage): Promise<void> {
  try {
    const devices = await prisma.pushDevice.findMany({ where: { accountId } });
    if (devices.length === 0) return;
    const provider = createPushProvider();
    for (const device of devices) {
      const result = await provider.send(device.token, message);
      if (!result.ok && result.unregistered) {
        await prisma.pushDevice.deleteMany({ where: { id: device.id } });
      }
    }
  } catch (err) {
    console.warn('[push] notifyAccount failed:', err instanceof Error ? err.message : err);
  }
}
