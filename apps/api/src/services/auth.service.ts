// Supabase-identity → Account resolution (deployment plan §4.1). Called by
// plugins/auth.ts on every request in Supabase mode. Unlike the rest of the
// service layer this function *derives* the accountId rather than taking it —
// it is the one place an external identity becomes a 554 Properties account.
//
// Provisioning rules for a first-seen identity (JWT `sub`):
//   1. If an Account with the same (Supabase-verified) email exists and has no
//      linked User yet, link to it — covers pre-auth accounts created before
//      Supabase mode was enabled.
//   2. If that Account is already linked to a different login, refuse (403).
//   3. Otherwise create a fresh Account + User. System categories are ensured
//      first, since production databases never run the demo seed.
import { Prisma } from '@prisma/client';
import { SEED_CATEGORIES } from '../../prisma/seed-constants';
import { HttpError } from '../lib/errors';
import { prisma } from '../lib/prisma';

const accountIdBySub = new Map<string, string>();

/** Test helper: forget cached identity→account mappings. */
export function resetAuthServiceCache(): void {
  accountIdBySub.clear();
}

/** "sam.landlord@x.com" → "Sam Landlord" (best-effort display name). */
function nameFromEmail(email: string): string {
  const words = (email.split('@')[0] ?? '').split(/[._\-+]+/).filter(Boolean);
  if (words.length === 0) return 'Landlord';
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
}

async function ensureSystemCategories(tx: Prisma.TransactionClient): Promise<void> {
  const count = await tx.category.count({ where: { isSystem: true } });
  if (count > 0) return;
  for (const c of SEED_CATEGORIES) {
    await tx.category.create({
      data: { name: c.name, type: c.type, irsScheduleELine: c.irsScheduleELine, isSystem: true },
    });
  }
}

export async function resolveAccountForIdentity(
  supabaseUserId: string,
  email: string | undefined,
): Promise<string> {
  const cached = accountIdBySub.get(supabaseUserId);
  if (cached) return cached;

  const existing = await prisma.user.findUnique({ where: { supabaseUserId } });
  if (existing) {
    accountIdBySub.set(supabaseUserId, existing.accountId);
    return existing.accountId;
  }

  // Tokens for email-less identities (e.g. phone auth) still need a unique
  // Account.email; .invalid is reserved and can never collide with a real one.
  const resolvedEmail = email ?? `${supabaseUserId}@users.hearth.invalid`;

  try {
    const accountId = await prisma.$transaction(async (tx) => {
      await ensureSystemCategories(tx);
      const byEmail = await tx.account.findUnique({
        where: { email: resolvedEmail },
        include: { users: { select: { id: true } } },
      });
      if (byEmail && byEmail.users.length > 0) {
        throw new HttpError(
          403,
          'account_conflict',
          'An account with this email is already linked to a different login.',
        );
      }
      const account =
        byEmail ??
        (await tx.account.create({
          data: { name: nameFromEmail(resolvedEmail), email: resolvedEmail },
        }));
      await tx.user.create({
        data: { accountId: account.id, supabaseUserId, email: resolvedEmail },
      });
      return account.id;
    });
    accountIdBySub.set(supabaseUserId, accountId);
    return accountId;
  } catch (err) {
    // P2002 on User.supabaseUserId: a concurrent first request won the race —
    // re-read and use its mapping.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const raced = await prisma.user.findUnique({ where: { supabaseUserId } });
      if (raced) {
        accountIdBySub.set(supabaseUserId, raced.accountId);
        return raced.accountId;
      }
    }
    throw err;
  }
}
