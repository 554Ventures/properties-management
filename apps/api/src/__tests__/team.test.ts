// Multi-user accounts (docs/WHATS_NEXT.md §4): email invites → join, the
// 2-seat cap, per-member permission enforcement on write routes, and
// remove/revoke with audit attribution. Runs in Supabase mode so real User
// rows and roles exist (demo mode has neither). Provisioned accounts are
// cleaned up in afterAll so later files see only seed data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../app';
import { prisma } from '../lib/prisma';
import { resetAuthServiceCache } from '../services/auth.service';

const TEST_SECRET = 'test-jwt-secret-with-at-least-32-characters!';

async function signToken(sub: string, email: string): Promise<string> {
  return new SignJWT({ email, aud: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(TEST_SECRET));
}

/** Sign in a brand-new identity, forcing first-sight provisioning. */
async function provision(sub: string, email: string): Promise<string> {
  const token = await signToken(sub, email);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/properties',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return token;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

const PROPERTY_PAYLOAD = {
  addressLine1: '1 Team St',
  city: 'Austin',
  state: 'TX',
  zip: '78701',
  units: [{ label: 'A' }],
};

let app: FastifyInstance;

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
  resetAuthServiceCache();
  app = await buildApp();
});

afterAll(async () => {
  delete process.env.SUPABASE_JWT_SECRET;
  resetAuthServiceCache();
  await prisma.account.deleteMany({ where: { email: { endsWith: '@teamtest.example' } } });
  await prisma.account.deleteMany({ where: { email: { endsWith: '.invalid' } } });
  await app.close();
});

describe('invite → join → seat cap', () => {
  it('invites by email, joins the same account on first login, then caps at 2 seats', async () => {
    const ownerToken = await provision('team-owner-1', 'owner1@teamtest.example');
    const ownerUser = await prisma.user.findUniqueOrThrow({
      where: { supabaseUserId: 'team-owner-1' },
    });

    // Owner invites a teammate with only the 'rent' grant.
    const invited = await app.inject({
      method: 'POST',
      url: '/api/v1/team/invites',
      headers: auth(ownerToken),
      payload: { email: 'member1@teamtest.example', permissions: ['rent'] },
    });
    expect(invited.statusCode).toBe(201);

    // The team now shows the owner + one pending invite (2 seats used).
    const team = await app.inject({ method: 'GET', url: '/api/v1/team', headers: auth(ownerToken) });
    expect(team.statusCode).toBe(200);
    const body = team.json();
    expect(body.members).toHaveLength(1);
    expect(body.pendingInvites).toHaveLength(1);
    expect(body.pendingInvites[0].email).toBe('member1@teamtest.example');
    expect(body.seatsUsed).toBe(2);
    expect(body.seatLimit).toBe(2);

    // The teammate signs in with the invited email → joins the SAME account.
    await provision('team-member-1', 'member1@teamtest.example');
    const memberUser = await prisma.user.findUniqueOrThrow({
      where: { supabaseUserId: 'team-member-1' },
    });
    expect(memberUser.accountId).toBe(ownerUser.accountId);
    expect(memberUser.role).toBe('member');
    expect(JSON.parse(memberUser.permissionsJson)).toEqual(['rent']);

    // Invite is consumed; both seats are now active members.
    const after = await app.inject({ method: 'GET', url: '/api/v1/team', headers: auth(ownerToken) });
    expect(after.json().members).toHaveLength(2);
    expect(after.json().pendingInvites).toHaveLength(0);

    // A third seat is blocked with 402.
    const third = await app.inject({
      method: 'POST',
      url: '/api/v1/team/invites',
      headers: auth(ownerToken),
      payload: { email: 'member2@teamtest.example', permissions: [] },
    });
    expect(third.statusCode).toBe(402);
    expect(third.json().error.code).toBe('seat_limit_reached');
  });
});

describe('permission enforcement', () => {
  it('403s a member on an ungranted area, allows the owner, and honors a new grant live', async () => {
    const ownerToken = await provision('team-owner-2', 'owner2@teamtest.example');
    await app.inject({
      method: 'POST',
      url: '/api/v1/team/invites',
      headers: auth(ownerToken),
      payload: { email: 'member3@teamtest.example', permissions: ['rent'] },
    });
    const memberToken = await provision('team-member-3', 'member3@teamtest.example');
    const memberUser = await prisma.user.findUniqueOrThrow({
      where: { supabaseUserId: 'team-member-3' },
    });

    // Reads are always open.
    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/properties',
      headers: auth(memberToken),
    });
    expect(read.statusCode).toBe(200);

    // Member lacks 'properties' → 403 on the write.
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: auth(memberToken),
      payload: PROPERTY_PAYLOAD,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('forbidden');

    // Owner can always create.
    const ownerCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: auth(ownerToken),
      payload: PROPERTY_PAYLOAD,
    });
    expect(ownerCreate.statusCode).toBe(201);

    // Owner grants 'properties' → the change takes effect on the member's next request.
    const grant = await app.inject({
      method: 'PATCH',
      url: `/api/v1/team/members/${memberUser.id}`,
      headers: auth(ownerToken),
      payload: { permissions: ['rent', 'properties'] },
    });
    expect(grant.statusCode).toBe(200);

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: auth(memberToken),
      payload: PROPERTY_PAYLOAD,
    });
    expect(allowed.statusCode).toBe(201);
  });

  it('403s a member trying to manage the team (owner-only)', async () => {
    const ownerToken = await provision('team-owner-3', 'owner3@teamtest.example');
    await app.inject({
      method: 'POST',
      url: '/api/v1/team/invites',
      headers: auth(ownerToken),
      payload: { email: 'member4@teamtest.example', permissions: ['ai'] },
    });
    const memberToken = await provision('team-member-4', 'member4@teamtest.example');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/team/invites',
      headers: auth(memberToken),
      payload: { email: 'someone@teamtest.example', permissions: [] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });

  it('403s a member on account settings and deletion (owner-only), even with every area granted', async () => {
    const ownerToken = await provision('team-owner-90', 'owner90@teamtest.example');
    await app.inject({
      method: 'POST',
      url: '/api/v1/team/invites',
      headers: auth(ownerToken),
      payload: {
        email: 'member90@teamtest.example',
        permissions: ['properties', 'tenants', 'money', 'rent', 'reports', 'ai'],
      },
    });
    const memberToken = await provision('team-member-90', 'member90@teamtest.example');

    // Settings steer account-wide money math (timezone, graceDays, taxRatePct,
    // defaultLateFeeCents) — owner-only regardless of granted areas.
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/account',
      headers: auth(memberToken),
      payload: { graceDays: 10 },
    });
    expect(patch.statusCode).toBe(403);
    expect(patch.json().error.code).toBe('forbidden');

    const requestDeletion = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/account/deletion',
      headers: auth(memberToken),
    });
    expect(requestDeletion.statusCode).toBe(403);

    const cancelDeletion = await app.inject({
      method: 'DELETE',
      url: '/api/v1/settings/account/deletion',
      headers: auth(memberToken),
    });
    expect(cancelDeletion.statusCode).toBe(403);

    // Reads stay open to members; the owner's write still works.
    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/account',
      headers: auth(memberToken),
    });
    expect(read.statusCode).toBe(200);

    const ownerPatch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/account',
      headers: auth(ownerToken),
      payload: { graceDays: read.json().graceDays },
    });
    expect(ownerPatch.statusCode).toBe(200);
  });
});

describe('remove & revoke are audited', () => {
  it('removes a member and revokes an invite, both attributed to the user', async () => {
    const ownerToken = await provision('team-owner-4', 'owner4@teamtest.example');
    const ownerUser = await prisma.user.findUniqueOrThrow({
      where: { supabaseUserId: 'team-owner-4' },
    });

    // Invite + join a member, then remove them.
    await app.inject({
      method: 'POST',
      url: '/api/v1/team/invites',
      headers: auth(ownerToken),
      payload: { email: 'member5@teamtest.example', permissions: ['money'] },
    });
    await provision('team-member-5', 'member5@teamtest.example');
    const memberUser = await prisma.user.findUniqueOrThrow({
      where: { supabaseUserId: 'team-member-5' },
    });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/team/members/${memberUser.id}`,
      headers: auth(ownerToken),
    });
    expect(removed.statusCode).toBe(204);
    expect(await prisma.user.findUnique({ where: { id: memberUser.id } })).toBeNull();

    const removeAudit = await prisma.auditLog.findFirst({
      where: { accountId: ownerUser.accountId, action: 'member.removed', entityId: memberUser.id },
    });
    expect(removeAudit?.actor).toBe('user');

    // A seat freed → invite again, then revoke it.
    const reinvited = await app.inject({
      method: 'POST',
      url: '/api/v1/team/invites',
      headers: auth(ownerToken),
      payload: { email: 'member6@teamtest.example', permissions: [] },
    });
    expect(reinvited.statusCode).toBe(201);
    const inviteId = reinvited.json().id;

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/team/invites/${inviteId}`,
      headers: auth(ownerToken),
    });
    expect(revoked.statusCode).toBe(204);
    const invite = await prisma.invite.findUniqueOrThrow({ where: { id: inviteId } });
    expect(invite.status).toBe('revoked');

    const revokeAudit = await prisma.auditLog.findFirst({
      where: { accountId: ownerUser.accountId, action: 'invite.revoked', entityId: inviteId },
    });
    expect(revokeAudit?.actor).toBe('user');
  });
});
