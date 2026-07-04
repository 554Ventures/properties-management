// Auth plugin in Supabase mode (deployment plan §4.1): JWT verification,
// first-sight provisioning, email linking/conflicts — plus the internal cron
// endpoint's shared-secret gate (§4.3). Demo mode is exercised implicitly by
// every other test file. Env is read per request, so tests flip modes by
// setting/unsetting SUPABASE_JWT_SECRET around the same app instance.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { DEMO_EMAIL } from '../../prisma/seed-constants';
import { buildApp } from '../app';
import { prisma } from '../lib/prisma';
import { resetAuthServiceCache } from '../services/auth.service';

const TEST_SECRET = 'test-jwt-secret-with-at-least-32-characters!';

async function signToken(
  sub: string,
  email?: string,
  opts: { expired?: boolean; audience?: string; secret?: string } = {},
): Promise<string> {
  let jwt = new SignJWT({ ...(email ? { email } : {}), aud: opts.audience ?? 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt(opts.expired ? Math.floor(Date.now() / 1000) - 7200 : undefined);
  jwt = jwt.setExpirationTime(opts.expired ? Math.floor(Date.now() / 1000) - 3600 : '1h');
  return jwt.sign(new TextEncoder().encode(opts.secret ?? TEST_SECRET));
}

let app: FastifyInstance;

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
  resetAuthServiceCache();
  app = await buildApp();
});

afterAll(async () => {
  delete process.env.SUPABASE_JWT_SECRET;
  delete process.env.CRON_SECRET;
  resetAuthServiceCache();
  // Remove accounts provisioned here so later test files see only seed data.
  await prisma.account.deleteMany({ where: { email: { endsWith: '@authtest.example' } } });
  await prisma.account.deleteMany({ where: { email: { endsWith: '.invalid' } } });
  await app.close();
});

describe('supabase mode: rejections', () => {
  it('401s without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/properties' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('401s on a malformed token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/properties',
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('401s on a token signed with the wrong secret', async () => {
    const token = await signToken('sub-wrong-secret', 'a@authtest.example', {
      secret: 'some-other-secret-that-is-also-32-chars!!',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/properties',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('401s on an expired token', async () => {
    const token = await signToken('sub-expired', 'b@authtest.example', { expired: true });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/properties',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('401s on a wrong audience', async () => {
    const token = await signToken('sub-wrong-aud', 'c@authtest.example', { audience: 'anon' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/properties',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('healthz stays open', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/healthz' });
    expect(res.statusCode).toBe(200);
  });
});

describe('supabase mode: provisioning', () => {
  it('provisions Account + User on first sight and reuses them after', async () => {
    const token = await signToken('sub-new-user', 'pat.moss@authtest.example');
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/properties',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual([]); // fresh account, no seed data

    const user = await prisma.user.findUnique({ where: { supabaseUserId: 'sub-new-user' } });
    expect(user).not.toBeNull();
    const account = await prisma.account.findUnique({ where: { id: user!.accountId } });
    expect(account?.email).toBe('pat.moss@authtest.example');
    expect(account?.name).toBe('Pat Moss');

    const again = await app.inject({
      method: 'GET',
      url: '/api/v1/properties',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(again.statusCode).toBe(200);
    const users = await prisma.user.findMany({ where: { supabaseUserId: 'sub-new-user' } });
    expect(users).toHaveLength(1);
  });

  it('links a first login to a pre-auth account with the same email', async () => {
    // The seeded demo account predates Supabase mode and has no User row.
    const token = await signToken('sub-demo-claim', DEMO_EMAIL);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/properties',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThan(0); // sees the seeded portfolio

    const user = await prisma.user.findUnique({ where: { supabaseUserId: 'sub-demo-claim' } });
    const demo = await prisma.account.findUnique({ where: { email: DEMO_EMAIL } });
    expect(user?.accountId).toBe(demo?.id);
  });

  it('403s a different login whose email is already linked', async () => {
    const token = await signToken('sub-demo-imposter', DEMO_EMAIL);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/properties',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('account_conflict');
  });

  it('provisions an email-less identity with a placeholder email', async () => {
    const token = await signToken('sub-phone-only');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/properties',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const user = await prisma.user.findUnique({ where: { supabaseUserId: 'sub-phone-only' } });
    expect(user?.email).toBe('sub-phone-only@users.hearth.invalid');
  });
});

describe('internal cron endpoint', () => {
  it('401s when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    const res = await app.inject({ method: 'POST', url: '/api/v1/internal/run-daily-jobs' });
    expect(res.statusCode).toBe(401);
  });

  it('401s on a wrong secret and runs the jobs on the right one', async () => {
    process.env.CRON_SECRET = 'cron-secret-for-tests';

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/internal/run-daily-jobs',
      headers: { 'x-cron-secret': 'nope' },
    });
    expect(wrong.statusCode).toBe(401);

    const right = await app.inject({
      method: 'POST',
      url: '/api/v1/internal/run-daily-jobs',
      headers: { 'x-cron-secret': 'cron-secret-for-tests' },
    });
    expect(right.statusCode).toBe(200);
    const body = right.json();
    expect(body.accountsProcessed).toBeGreaterThan(0);
    // Empty accounts provisioned above must not break the run for the rest.
    expect(body.errors).toEqual([]);
  });
});

describe('demo mode fallback', () => {
  it('serves the demo account without a token once Supabase env is cleared', async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/properties' });
      expect(res.statusCode).toBe(200);
      expect(res.json().length).toBeGreaterThan(0);
    } finally {
      process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
    }
  });
});
