// AuditLog writes (PRD §7.3). Called on: reminder sends, transaction
// create/confirm via any path, report generation, insight dismiss.
import { prisma } from '../lib/prisma';

export type AuditActor = 'user' | 'ai_suggested_user_confirmed' | 'system';

export async function writeAudit(
  accountId: string,
  entry: {
    actor?: AuditActor;
    action: string;
    entityType: string;
    entityId: string;
    detail?: unknown;
  },
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      accountId,
      actor: entry.actor ?? 'user',
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      detailJson: entry.detail === undefined ? null : JSON.stringify(entry.detail),
    },
  });
}
