// Team / multi-user account routes (docs/WHATS_NEXT.md §4). All mutations are
// owner-only (requireOwner); GET /team is readable by any member so the
// Settings page can show who's on the account. GET /settings/me exposes the
// caller's own role + permissions so the web app can gate its write UI.
import { InviteMemberInputSchema, UpdateMemberInputSchema, type CurrentUser } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { requireOwner } from '../lib/authz';
import { parseBody } from '../plugins/zod-validation';
import * as teamService from '../services/team.service';

export async function teamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/settings/me', async (req): Promise<CurrentUser> => {
    return {
      userId: req.userId,
      role: req.userRole,
      permissions: req.userPermissions,
    };
  });

  app.get('/team', async (req) => teamService.listTeam(req.accountId));

  app.post('/team/invites', { preHandler: requireOwner() }, async (req, reply) => {
    const input = parseBody(InviteMemberInputSchema, req.body);
    const invite = await teamService.invite(req.accountId, req.userId, input);
    return reply.code(201).send(invite);
  });

  app.delete<{ Params: { id: string } }>(
    '/team/invites/:id',
    { preHandler: requireOwner() },
    async (req, reply) => {
      await teamService.revokeInvite(req.accountId, req.params.id);
      return reply.code(204).send();
    },
  );

  app.patch<{ Params: { userId: string } }>(
    '/team/members/:userId',
    { preHandler: requireOwner() },
    async (req) => {
      const input = parseBody(UpdateMemberInputSchema, req.body);
      return teamService.updateMemberPermissions(req.accountId, req.params.userId, input.permissions);
    },
  );

  app.delete<{ Params: { userId: string } }>(
    '/team/members/:userId',
    { preHandler: requireOwner() },
    async (req, reply) => {
      await teamService.removeMember(req.accountId, req.params.userId);
      return reply.code(204).send();
    },
  );
}
