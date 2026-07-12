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
import {
  ALL_MEMBER_PERMISSIONS,
  MemberPermissionSchema,
  SEAT_LIMIT,
  type MemberPermission,
  type PolicyConsentStatus,
  type UserRole,
} from '@hearth/shared';
import { SEED_CATEGORIES } from '../../prisma/seed-constants';
import { isoOrNull } from '../lib/dates';
import { HttpError } from '../lib/errors';
import { prisma } from '../lib/prisma';

export interface ResolvedIdentity {
  accountId: string;
  userId: string;
  role: UserRole;
  permissions: MemberPermission[];
}

// sub → identity. Cleared wholesale whenever team membership/permissions change
// (see invalidateIdentityCache), so a revoked grant or removed member takes
// effect on the member's next request. Process-local — safe because production
// runs a single API container (docs/property-app-deployment-plan.md).
const identityBySub = new Map<string, ResolvedIdentity>();

/** Drop all cached identity→account mappings (called on any team mutation and
 *  by the test suite when the seed re-runs). */
export function invalidateIdentityCache(): void {
  identityBySub.clear();
}

/** Test helper alias — kept for existing callers. */
export function resetAuthServiceCache(): void {
  invalidateIdentityCache();
}

/** The write areas a user may act on: owners hold every permission implicitly;
 *  members hold exactly the grants stored on their row. */
export function effectivePermissions(role: string, permissionsJson: string): MemberPermission[] {
  if (role === 'owner') return [...ALL_MEMBER_PERMISSIONS];
  let raw: unknown = [];
  try {
    raw = JSON.parse(permissionsJson || '[]');
  } catch {
    raw = [];
  }
  const parsed = MemberPermissionSchema.array().safeParse(raw);
  return parsed.success ? parsed.data : [];
}

function toResolvedIdentity(user: {
  id: string;
  accountId: string;
  role: string;
  permissionsJson: string;
}): ResolvedIdentity {
  return {
    accountId: user.accountId,
    userId: user.id,
    role: user.role as UserRole,
    permissions: effectivePermissions(user.role, user.permissionsJson),
  };
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
    const resolved = toResolvedIdentity(existing);
    identityBySub.set(supabaseUserId, resolved);
    return resolved;
  }

  // Tokens for email-less identities (e.g. phone auth) still need a unique
  // Account.email; .invalid is reserved and can never collide with a real one.
  const resolvedEmail = email ?? `${supabaseUserId}@users.hearth.invalid`;

  try {
    const resolved = await prisma.$transaction(async (tx) => {
      await ensureSystemCategories(tx);

      // 1. Pending team invite for this email → join that account as a member
      //    (docs/WHATS_NEXT.md §4), rather than provisioning a fresh account.
      const invite = await tx.invite.findFirst({
        where: { email: { equals: resolvedEmail, mode: 'insensitive' }, status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
      if (invite) {
        // Defensive: the owner could have hit the seat cap between sending the
        // invite and the teammate accepting it.
        const seatCount = await tx.user.count({ where: { accountId: invite.accountId } });
        if (seatCount >= SEAT_LIMIT) {
          throw new HttpError(
            402,
            'seat_limit_reached',
            'This account has reached its seat limit.',
          );
        }
        const user = await tx.user.create({
          data: {
            accountId: invite.accountId,
            supabaseUserId,
            email: resolvedEmail,
            role: invite.role,
            permissionsJson: invite.permissionsJson,
          },
        });
        await tx.invite.update({
          where: { id: invite.id },
          data: { status: 'accepted', acceptedAt: new Date() },
        });
        return toResolvedIdentity(user);
      }

      // 2. A pre-auth account with this email and no linked user yet → link as
      //    owner (covers accounts created before Supabase mode was enabled).
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
      return toResolvedIdentity(user);
    });
    identityBySub.set(supabaseUserId, resolved);
    return resolved;
  } catch (err) {
    // P2002 on User.supabaseUserId: a concurrent first request won the race —
    // re-read and use its mapping.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const raced = await prisma.user.findUnique({ where: { supabaseUserId } });
      if (raced) {
        const resolved = toResolvedIdentity(raced);
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
