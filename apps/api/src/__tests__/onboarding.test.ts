// Onboarding checklist: a fresh account starts not_started with every step
// pending; step completion is derived live from portfolio data (never stored);
// skips and dismissal persist; status flips to derived "completed" once every
// step is completed or skipped. The demo account (fully seeded) must always
// derive completed so the banner never shows on the demo portfolio.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { OnboardingStateSchema } from '@hearth/shared';
import { buildApp } from '../app';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import * as onboardingService from '../services/onboarding.service';

let app: FastifyInstance;
let demoAccountId: string;
let freshAccountId: string;

const API = '/api/v1';

beforeAll(async () => {
  app = await buildApp();
  demoAccountId = await getDemoAccountId();
  const fresh = await prisma.account.create({
    data: { name: 'Onboarding Test', email: 'onboarding@test.example' },
  });
  freshAccountId = fresh.id;
});

afterAll(async () => {
  // Cascade removes the fresh account's onboarding row and portfolio; the demo
  // account's onboarding row is test-created state, not seed — drop it too.
  await prisma.account.delete({ where: { id: freshAccountId } });
  await prisma.onboardingState.deleteMany({ where: { accountId: demoAccountId } });
  await app.close();
});

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `${API}${url}`, payload: payload as never });
}

describe('onboarding derivation (fresh account, service level)', () => {
  it('a brand-new account is not_started with every step pending', async () => {
    const state = OnboardingStateSchema.parse(
      await onboardingService.getOnboarding(freshAccountId),
    );
    expect(state.status).toBe('not_started');
    expect(state.steps.map((s) => s.id)).toEqual([
      'add_property',
      'add_tenant',
      'create_lease',
      'log_transaction',
    ]);
    expect(state.steps.every((s) => s.state === 'pending')).toBe(true);
  });

  it('starting persists in_progress; skipping a step persists it', async () => {
    const started = await onboardingService.updateOnboarding(freshAccountId, {
      status: 'in_progress',
    });
    expect(started.status).toBe('in_progress');

    const skipped = await onboardingService.updateOnboarding(freshAccountId, {
      skipStep: 'log_transaction',
    });
    expect(skipped.status).toBe('in_progress'); // skip alone doesn't change status
    expect(skipped.steps.find((s) => s.id === 'log_transaction')?.state).toBe('skipped');

    // Persisted, not just in the response.
    const reread = await onboardingService.getOnboarding(freshAccountId);
    expect(reread.steps.find((s) => s.id === 'log_transaction')?.state).toBe('skipped');
  });

  it('steps complete from real data, and all-done derives completed', async () => {
    const property = await prisma.property.create({
      data: {
        accountId: freshAccountId,
        addressLine1: '1 Onboarding Way',
        city: 'Testville',
        state: 'NY',
        zip: '10001',
        units: { create: { label: 'A' } },
      },
      include: { units: true },
    });
    const tenant = await prisma.tenant.create({
      data: { accountId: freshAccountId, fullName: 'Onda Boarding' },
    });

    const partial = await onboardingService.getOnboarding(freshAccountId);
    expect(partial.status).toBe('in_progress');
    expect(partial.steps.find((s) => s.id === 'add_property')?.state).toBe('completed');
    expect(partial.steps.find((s) => s.id === 'add_tenant')?.state).toBe('completed');
    expect(partial.steps.find((s) => s.id === 'create_lease')?.state).toBe('pending');

    await prisma.lease.create({
      data: {
        unitId: property.units[0]!.id,
        rentCents: 100000,
        dueDay: 1,
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-12-31'),
        status: 'active',
        leaseTenants: { create: { tenantId: tenant.id, isPrimary: true } },
      },
    });

    // create_lease completed by data + log_transaction skipped earlier → done.
    const done = await onboardingService.getOnboarding(freshAccountId);
    expect(done.steps.find((s) => s.id === 'create_lease')?.state).toBe('completed');
    expect(done.status).toBe('completed');
  });
});

describe('onboarding routes (demo account)', () => {
  it('GET /onboarding parses with the shared schema; seeded demo derives completed', async () => {
    const res = await inject('GET', '/onboarding');
    expect(res.statusCode).toBe(200);
    const state = OnboardingStateSchema.parse(res.json());
    // The demo portfolio has properties/tenants/leases/transactions, so every
    // step derives completed and the banner never shows on the demo account.
    expect(state.status).toBe('completed');
    expect(state.steps.every((s) => s.state === 'completed')).toBe(true);
  });

  it('PATCH /onboarding dismisses (stored) and validates its body', async () => {
    const res = await inject('PATCH', '/onboarding', { status: 'dismissed' });
    expect(res.statusCode).toBe(200);
    OnboardingStateSchema.parse(res.json());
    const row = await prisma.onboardingState.findUniqueOrThrow({
      where: { accountId: demoAccountId },
    });
    expect(row.status).toBe('dismissed');

    expect((await inject('PATCH', '/onboarding', {})).statusCode).toBe(400);
    expect((await inject('PATCH', '/onboarding', { status: 'completed' })).statusCode).toBe(400);
  });
});
