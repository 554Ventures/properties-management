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
import type { PolicyConsentStatus } from '@hearth/shared';
import { SEED_CATEGORIES } from '../../prisma/seed-constants';
import { isoOrNull } from '../lib/dates';
import { HttpError } from '../lib/errors';
import { prisma } from '../lib/prisma';

export interface ResolvedIdentity {
  accountId: string;
  userId: string;
}

const identityBySub = new Map<string, ResolvedIdentity>();

/** Test helper: forget cached identity→account mappings. */
export function resetAuthServiceCache(): void {
  identityBySub.clear();
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
): Promise<ResolvedIdentity> {
  const cached = identityBySub.get(supabaseUserId);
  if (cached) return cached;

  const existing = await prisma.user.findUnique({ where: { supabaseUserId } });
  if (existing) {
    const resolved = { accountId: existing.accountId, userId: existing.id };
    identityBySub.set(supabaseUserId, resolved);
    return resolved;
  }

  // Tokens for email-less identities (e.g. phone auth) still need a unique
  // Account.email; .invalid is reserved and can never collide with a real one.
  const resolvedEmail = email ?? `${supabaseUserId}@users.hearth.invalid`;

  try {
    const resolved = await prisma.$transaction(async (tx) => {
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
      const user = await tx.user.create({
        data: { accountId: account.id, supabaseUserId, email: resolvedEmail },
      });
      return { accountId: account.id, userId: user.id };
    });
    identityBySub.set(supabaseUserId, resolved);
    return resolved;
  } catch (err) {
    // P2002 on User.supabaseUserId: a concurrent first request won the race —
    // re-read and use its mapping.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const raced = await prisma.user.findUnique({ where: { supabaseUserId } });
      if (raced) {
        const resolved = { accountId: raced.accountId, userId: raced.id };
        identityBySub.set(supabaseUserId, resolved);
        return resolved;
      }
    }
    throw err;
  }
}

function toConsentStatus(row: {
  policyConsentAcceptedAt: Date | null;
  policyConsentVersion: string | null;
}): PolicyConsentStatus {
  return {
    accepted: Boolean(row.policyConsentAcceptedAt),
    acceptedAt: isoOrNull(row.policyConsentAcceptedAt),
    policyVersion: row.policyConsentVersion,
  };
}

/** Records Privacy Policy / ToS acceptance for the given User (identity) —
 *  called once, right after signup, from the frontend's consent checkbox. */
export async function recordPolicyConsent(
  userId: string,
  policyVersion: string,
): Promise<PolicyConsentStatus> {
  const row = await prisma.user.update({
    where: { id: userId },
    data: { policyConsentAcceptedAt: new Date(), policyConsentVersion: policyVersion },
  });
  return toConsentStatus(row);
}

export async function getPolicyConsent(userId: string): Promise<PolicyConsentStatus> {
  const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return toConsentStatus(row);
}
