// Multi-user accounts (docs/WHATS_NEXT.md §4): email invites → join, the
// 2-seat cap, per-member permission enforcement on write routes, and
// remove/revoke with audit attribution. Runs in Supabase mode so real User
// rows and roles exist (demo mode has neither). Provisioned accounts are
// cleaned up in afterAll so later files see only seed data.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import FormData from 'form-data';
import { SignJWT } from 'jose';
import { buildApp } from '../app';
import { iso } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { resetAuthServiceCache } from '../services/auth.service';

// Document-guard tests upload real bytes through the mock storage adapter.
process.env.STORAGE_DIR = mkdtempSync(path.join(os.tmpdir(), 'hearth-team-test-'));

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

const PDF_BYTES = Buffer.from('%PDF-1.4\nHearth team-guard test payload\n%%EOF', 'utf-8');

// Text fields MUST come before the file part: the POST route authorizes off
// `file.fields`, which only contains parts parsed before the file (same
// contract documents.test.ts and both clients rely on).
async function uploadDocument(token: string, fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('file', PDF_BYTES, { filename: 'guard.pdf', contentType: 'application/pdf' });
  return app.inject({
    method: 'POST',
    url: '/api/v1/documents',
    payload: form.getBuffer(),
    headers: { ...form.getHeaders(), ...auth(token) },
  });
}

/** Owner-side setup for the document-guard tests: a property + a transaction. */
async function createDocumentTargets(ownerToken: string) {
  const property = await app.inject({
    method: 'POST',
    url: '/api/v1/properties',
    headers: auth(ownerToken),
    payload: PROPERTY_PAYLOAD,
  });
  expect(property.statusCode).toBe(201);
  const txn = await app.inject({
    method: 'POST',
    url: '/api/v1/transactions',
    headers: auth(ownerToken),
    payload: {
      date: iso(new Date()),
      amountCents: 4200,
      type: 'expense',
      description: 'doc guard target',
    },
  });
  expect(txn.statusCode).toBe(201);
  return { propertyId: property.json().id as string, txnId: txn.json().id as string };
}

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

describe('document write guards (area follows the attached entityType)', () => {
  it("403s a member without the area on POST/PATCH/DELETE; reads stay open", async () => {
    const ownerToken = await provision('team-owner-5', 'owner5@teamtest.example');
    const { propertyId } = await createDocumentTargets(ownerToken);

    // Owner uploads freely (owner bypass) — and this doc becomes the target
    // for the member's denied PATCH/DELETE below.
    const ownerUpload = await uploadDocument(ownerToken, {
      entityType: 'property',
      entityId: propertyId,
      type: 'other',
      name: 'guard-target.pdf',
    });
    expect(ownerUpload.statusCode).toBe(201);
    const docId = ownerUpload.json().id as string;

    // Member holds only 'rent' — no document-relevant area at all.
    await app.inject({
      method: 'POST',
      url: '/api/v1/team/invites',
      headers: auth(ownerToken),
      payload: { email: 'member7@teamtest.example', permissions: ['rent'] },
    });
    const memberToken = await provision('team-member-7', 'member7@teamtest.example');

    const post = await uploadDocument(memberToken, {
      entityType: 'property',
      entityId: propertyId,
      type: 'other',
    });
    expect(post.statusCode).toBe(403);
    expect(post.json().error.code).toBe('forbidden');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${docId}`,
      headers: auth(memberToken),
      payload: { name: 'renamed.pdf' },
    });
    expect(patch.statusCode).toBe(403);
    expect(patch.json().error.code).toBe('forbidden');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${docId}`,
      headers: auth(memberToken),
    });
    expect(del.statusCode).toBe(403);
    expect(del.json().error.code).toBe('forbidden');

    // Reads are never guarded — list and download both work.
    const list = await app.inject({ url: '/api/v1/documents', headers: auth(memberToken) });
    expect(list.statusCode).toBe(200);
    expect(list.json().documents.map((d: { id: string }) => d.id)).toContain(docId);
    const download = await app.inject({
      url: `/api/v1/documents/${docId}/download`,
      headers: auth(memberToken),
    });
    expect(download.statusCode).toBe(200);

    // The doc survived every denied write untouched.
    const still = await prisma.document.findUniqueOrThrow({ where: { id: docId } });
    expect(still.name).toBe('guard-target.pdf');
  });

  it("maps the area per entityType: 'money' covers transaction docs but not property docs", async () => {
    const ownerToken = await provision('team-owner-6', 'owner6@teamtest.example');
    const { propertyId, txnId } = await createDocumentTargets(ownerToken);
    await app.inject({
      method: 'POST',
      url: '/api/v1/team/invites',
      headers: auth(ownerToken),
      payload: { email: 'member8@teamtest.example', permissions: ['money'] },
    });
    const memberToken = await provision('team-member-8', 'member8@teamtest.example');

    const toTransaction = await uploadDocument(memberToken, {
      entityType: 'transaction',
      entityId: txnId,
      type: 'receipt',
    });
    expect(toTransaction.statusCode).toBe(201);

    const toProperty = await uploadDocument(memberToken, {
      entityType: 'property',
      entityId: propertyId,
      type: 'other',
    });
    expect(toProperty.statusCode).toBe(403);
    expect(toProperty.json().error.code).toBe('forbidden');
  });

  it("404s (never 403s) a member touching another account's document", async () => {
    // The preHandler must fall through when the id isn't in the caller's
    // account so the service's scoped lookup 404s — a 403 would leak that
    // the id exists elsewhere.
    const foreignOwner = await provision('team-owner-7', 'owner7@teamtest.example');
    const targets = await createDocumentTargets(foreignOwner);
    const foreignUpload = await uploadDocument(foreignOwner, {
      entityType: 'property',
      entityId: targets.propertyId,
      type: 'other',
      name: 'foreign.pdf',
    });
    expect(foreignUpload.statusCode).toBe(201);
    const foreignDocId = foreignUpload.json().id as string;

    // A member of a different account, holding every document-relevant area.
    const ownerToken = await provision('team-owner-8', 'owner8@teamtest.example');
    await app.inject({
      method: 'POST',
      url: '/api/v1/team/invites',
      headers: auth(ownerToken),
      payload: { email: 'member9@teamtest.example', permissions: ['money', 'properties', 'tenants'] },
    });
    const memberToken = await provision('team-member-9', 'member9@teamtest.example');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${foreignDocId}`,
      headers: auth(memberToken),
      payload: { name: 'stolen.pdf' },
    });
    expect(patch.statusCode).toBe(404);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${foreignDocId}`,
      headers: auth(memberToken),
    });
    expect(del.statusCode).toBe(404);

    const still = await prisma.document.findUniqueOrThrow({ where: { id: foreignDocId } });
    expect(still.name).toBe('foreign.pdf');
  });
});
