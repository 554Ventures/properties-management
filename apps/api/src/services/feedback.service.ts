// Beta feedback ("Send feedback" in the app shell). No AuditLog here: product
// feedback isn't money/tenant-touching (precedent: push.service device
// registration). No permission gate either — any member may submit feedback;
// it isn't a business write. The owner-notification email is fire-and-forget:
// a send failure must NEVER fail the feedback write (mirrors
// push.service.notifyAccount).
import type { CreateFeedbackInput, Feedback } from '@hearth/shared';
import type { Feedback as DbFeedback } from '@prisma/client';
import { createEmailAdapter } from '../integrations/factory';
import { iso } from '../lib/dates';
import { prisma } from '../lib/prisma';

export function toApiFeedback(f: DbFeedback): Feedback {
  return {
    id: f.id,
    accountId: f.accountId,
    userId: f.userId,
    category: f.category as Feedback['category'],
    message: f.message,
    pagePath: f.pagePath,
    userAgent: f.userAgent,
    createdAt: iso(f.createdAt),
  };
}

export async function create(
  accountId: string,
  input: CreateFeedbackInput,
  ctx: { userId: string | null; userAgent: string | null },
): Promise<Feedback> {
  const row = await prisma.feedback.create({
    data: {
      accountId,
      userId: ctx.userId,
      category: input.category,
      message: input.message,
      pagePath: input.pagePath ?? null,
      userAgent: ctx.userAgent,
    },
  });
  // Awaited for deterministic tests, but never throws.
  await notifyOwner(row);
  return toApiFeedback(row);
}

/**
 * Email the new submission to FEEDBACK_NOTIFY_EMAIL (read at call time; no-op
 * when unset). Fire-and-forget semantics: NEVER throws — an email failure must
 * not fail the feedback write that triggered it.
 */
async function notifyOwner(row: DbFeedback): Promise<void> {
  try {
    const to = process.env.FEEDBACK_NOTIFY_EMAIL;
    if (!to) return;

    let submitter = 'demo mode';
    if (row.userId) {
      const user = await prisma.user.findUnique({ where: { id: row.userId } });
      submitter = user?.email ?? row.userId;
    }

    // Collapse whitespace in the subject preview: a newline in the first 60
    // chars would otherwise put raw CR/LF in the subject and the provider
    // would reject the send (silently, given never-throw).
    const preview = row.message.replace(/\s+/g, ' ').trim().slice(0, 60);
    await createEmailAdapter().send({
      to,
      subject: `[554 Properties feedback] ${row.category}: ${preview}`,
      body: [
        row.message,
        '',
        `Page: ${row.pagePath ?? '(not captured)'}`,
        `Submitted by: ${submitter}`,
        `Account: ${row.accountId}`,
        `User agent: ${row.userAgent ?? '(not captured)'}`,
        `At: ${iso(row.createdAt)}`,
      ].join('\n'),
    });
  } catch (err) {
    console.warn('[feedback] notifyOwner failed:', err instanceof Error ? err.message : err);
  }
}
