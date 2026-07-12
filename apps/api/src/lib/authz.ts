// Route authorization guards (docs/WHATS_NEXT.md §4). Fastify preHandlers that
// gate a write route by the acting user's role/permissions. Reads are never
// guarded — a member can view the whole account. Owners bypass permission
// checks. In demo mode there is no User row (req.userId is null), so both
// guards no-op and the single operator retains full access.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { MemberPermission } from '@hearth/shared';
import { HttpError } from './errors';

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Owner-only action (team management, billing, account settings/deletion). */
export function requireOwner(): PreHandler {
  return async (req) => {
    if (req.userId === null) return; // demo mode: single operator = owner
    if (req.userRole !== 'owner') {
      throw new HttpError(403, 'forbidden', 'Only the account owner can perform this action.');
    }
  };
}

/** Write action in a given area — owners always pass; members need the grant. */
export function requirePermission(permission: MemberPermission): PreHandler {
  return async (req) => {
    if (req.userId === null) return; // demo mode: single operator = owner
    if (req.userRole === 'owner') return;
    if (!req.userPermissions.includes(permission)) {
      throw new HttpError(
        403,
        'forbidden',
        `You don't have permission to manage ${permission} for this account.`,
      );
    }
  };
}
