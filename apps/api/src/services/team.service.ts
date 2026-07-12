// Team / multi-user account service (docs/WHATS_NEXT.md §4). Owner-only
// operations: list the team, invite a teammate by email (capped at SEAT_LIMIT),
// edit a member's permissions, remove a member, revoke a pending invite. Every
// mutation is audited with actor 'user'. Invites are matched to a Supabase
// identity on that teammate's first request (see auth.service.resolveAccountForIdentity),
// so nothing here sends email.
import { SEAT_LIMIT } from '@hearth/shared';
import type { AccountMember, MemberPermission, PendingInvite, TeamResponse } from '@hearth/shared';
import type { Invite as DbInvite, User as DbUser } from '@prisma/client';
import { iso } from '../lib/dates';
import { HttpError, NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import {
  effectivePermissions,
  invalidateIdentityCache,
} from './auth.service';
import { writeAudit } from './audit.service';

function toMember(u: DbUser): AccountMember {
  return {
    userId: u.id,
    email: u.email,
    role: u.role as AccountMember['role'],
    permissions: effectivePermissions(u.role, u.permissionsJson),
    createdAt: iso(u.createdAt),
  };
}

function toPendingInvite(i: DbInvite): PendingInvite {
  return {
    id: i.id,
    email: i.email,
    permissions: effectivePermissions('member', i.permissionsJson),
    createdAt: iso(i.createdAt),
  };
}

export async function listTeam(accountId: string): Promise<TeamResponse> {
  const [users, invites] = await Promise.all([
    prisma.user.findMany({ where: { accountId }, orderBy: { createdAt: 'asc' } }),
    prisma.invite.findMany({
      where: { accountId, status: 'pending' },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  return {
    members: users.map(toMember),
    pendingInvites: invites.map(toPendingInvite),
    seatsUsed: users.length + invites.length,
    seatLimit: SEAT_LIMIT,
  };
}

export async function invite(
  accountId: string,
  invitedByUserId: string | null,
  input: { email: string; permissions: MemberPermission[] },
): Promise<PendingInvite> {
  const email = input.email.trim().toLowerCase();

  const invited = await prisma.$transaction(async (tx) => {
    const [userCount, pendingCount] = await Promise.all([
      tx.user.count({ where: { accountId } }),
      tx.invite.count({ where: { accountId, status: 'pending' } }),
    ]);
    if (userCount + pendingCount >= SEAT_LIMIT) {
      throw new HttpError(
        402,
        'seat_limit_reached',
        `This plan is limited to ${SEAT_LIMIT} users. Upgrade for more seats.`,
      );
    }
    // Already a member of this account?
    const existingUser = await tx.user.findFirst({ where: { accountId, email } });
    if (existingUser) {
      throw new HttpError(409, 'already_member', 'That person is already on your team.');
    }
    // An outstanding invite for the same address → treat as idempotent-ish and
    // reject rather than pile up duplicates.
    const existingInvite = await tx.invite.findFirst({
      where: { accountId, email, status: 'pending' },
    });
    if (existingInvite) {
      throw new HttpError(409, 'already_invited', 'That email already has a pending invite.');
    }
    return tx.invite.create({
      data: {
        accountId,
        email,
        role: 'member',
        permissionsJson: JSON.stringify(input.permissions),
        invitedByUserId,
      },
    });
  });

  await writeAudit(accountId, {
    actor: 'user',
    action: 'member.invited',
    entityType: 'invite',
    entityId: invited.id,
    detail: { email, permissions: input.permissions },
  });
  return toPendingInvite(invited);
}

export async function updateMemberPermissions(
  accountId: string,
  memberUserId: string,
  permissions: MemberPermission[],
): Promise<AccountMember> {
  const member = await prisma.user.findFirst({ where: { id: memberUserId, accountId } });
  if (!member) throw new NotFoundError('member', memberUserId);
  if (member.role === 'owner') {
    throw new HttpError(400, 'cannot_edit_owner', "The owner's permissions can't be changed.");
  }
  const updated = await prisma.user.update({
    where: { id: memberUserId },
    data: { permissionsJson: JSON.stringify(permissions) },
  });
  invalidateIdentityCache();
  await writeAudit(accountId, {
    actor: 'user',
    action: 'member.updated',
    entityType: 'user',
    entityId: memberUserId,
    detail: { permissions },
  });
  return toMember(updated);
}

export async function removeMember(accountId: string, memberUserId: string): Promise<void> {
  const member = await prisma.user.findFirst({ where: { id: memberUserId, accountId } });
  if (!member) throw new NotFoundError('member', memberUserId);
  if (member.role === 'owner') {
    throw new HttpError(400, 'cannot_remove_owner', 'The account owner cannot be removed.');
  }
  await prisma.user.delete({ where: { id: memberUserId } });
  invalidateIdentityCache();
  await writeAudit(accountId, {
    actor: 'user',
    action: 'member.removed',
    entityType: 'user',
    entityId: memberUserId,
    detail: { email: member.email },
  });
}

export async function revokeInvite(accountId: string, inviteId: string): Promise<void> {
  const existing = await prisma.invite.findFirst({
    where: { id: inviteId, accountId, status: 'pending' },
  });
  if (!existing) throw new NotFoundError('invite', inviteId);
  await prisma.invite.update({ where: { id: inviteId }, data: { status: 'revoked' } });
  await writeAudit(accountId, {
    actor: 'user',
    action: 'invite.revoked',
    entityType: 'invite',
    entityId: inviteId,
    detail: { email: existing.email },
  });
}
