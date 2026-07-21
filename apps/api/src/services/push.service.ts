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
 * device, not the signed-in user) and lastSeenAt is bumped. userId is stamped
 * on create AND update so pre-existing rows self-heal on the next app launch
 * (null in demo mode — treated as the owner's device by notification routing).
 */
export async function registerDevice(
  accountId: string,
  input: RegisterDeviceInput,
  userId: string | null = null,
): Promise<PushDevice> {
  const row = await prisma.pushDevice.upsert({
    where: { token: input.token },
    create: { accountId, userId, platform: input.platform, token: input.token },
    update: { accountId, userId, platform: input.platform, lastSeenAt: new Date() },
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
 * Provider fan-out shared by notifyAccount and notification.service's
 * per-user routing: send `message` to each given device row, pruning tokens
 * APNs reports as unregistered. May throw on provider construction — callers
 * wrap it in their own never-throw guard.
 */
export async function sendToDevices(devices: DbPushDevice[], message: PushMessage): Promise<void> {
  if (devices.length === 0) return;
  const provider = createPushProvider();
  for (const device of devices) {
    const result = await provider.send(device.token, message);
    if (!result.ok && result.unregistered) {
      await prisma.pushDevice.deleteMany({ where: { id: device.id } });
    }
  }
}

/**
 * Send `message` to every device on the account. Fire-and-forget semantics:
 * NEVER throws — a push failure must not fail the write that triggered it.
 * Tokens APNs reports as unregistered are pruned.
 */
export async function notifyAccount(accountId: string, message: PushMessage): Promise<void> {
  try {
    const devices = await prisma.pushDevice.findMany({ where: { accountId } });
    await sendToDevices(devices, message);
  } catch (err) {
    console.warn('[push] notifyAccount failed:', err instanceof Error ? err.message : err);
  }
}
