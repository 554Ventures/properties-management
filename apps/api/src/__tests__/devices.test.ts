// Push devices: registration routes parse with the shared schemas, register is
// idempotent (relaunch-safe upsert), deletes are account-scoped, notifyAccount
// fans out via the mock provider and prunes unregistered tokens, and the two
// triggers (rent payment, daily-jobs warning insights) actually push.
// Everything created here is cleaned up so the seeded portfolio stays pristine.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PushDeviceListResponseSchema, PushDeviceSchema, formatUsd } from '@hearth/shared';
import { buildApp } from '../app';
import { resetMockPush, sentPushes } from '../integrations/mock/mock-push';
import { currentPeriod } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import * as insightService from '../services/insight.service';
import { runDailyJobs } from '../services/jobs.service';
import * as pushService from '../services/push.service';

let app: FastifyInstance;
let accountId: string;

const API = '/api/v1';
const TOKEN_PREFIX = 'test_device_';

beforeAll(async () => {
  app = await buildApp();
  accountId = await getDemoAccountId();
});

afterAll(async () => {
  await prisma.pushDevice.deleteMany({ where: { token: { startsWith: TOKEN_PREFIX } } });
  await app.close();
});

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `${API}${url}`, payload: payload as never });
}

describe('device registration routes', () => {
  it('POST /devices registers and GET /devices lists it (shared-schema parsed)', async () => {
    const token = `${TOKEN_PREFIX}register_1`;
    const res = await inject('POST', '/devices', { platform: 'ios', token });
    expect(res.statusCode).toBe(201);
    const device = PushDeviceSchema.parse(res.json());
    expect(device.accountId).toBe(accountId);
    expect(device.platform).toBe('ios');

    const list = PushDeviceListResponseSchema.parse((await inject('GET', '/devices')).json());
    expect(list.some((d) => d.token === token)).toBe(true);
  });

  it('re-registering the same token is idempotent: same row, lastSeenAt bumped', async () => {
    const token = `${TOKEN_PREFIX}register_1`;
    const before = await prisma.pushDevice.findUniqueOrThrow({ where: { token } });
    const res = await inject('POST', '/devices', { platform: 'ios', token });
    expect(res.statusCode).toBe(201);
    const again = PushDeviceSchema.parse(res.json());
    expect(again.id).toBe(before.id);
    expect(new Date(again.lastSeenAt).getTime()).toBeGreaterThanOrEqual(
      before.lastSeenAt.getTime(),
    );
    expect(await prisma.pushDevice.count({ where: { token } })).toBe(1);
  });

  it('re-registering an existing token from another account reassigns it', async () => {
    const token = `${TOKEN_PREFIX}reassign`;
    await pushService.registerDevice(accountId, { platform: 'ios', token });
    const other = await prisma.account.create({
      data: { name: 'Push Reassign Test', email: 'push-reassign@test.example' },
    });
    try {
      const moved = await pushService.registerDevice(other.id, { platform: 'ios', token });
      expect(moved.accountId).toBe(other.id);
      expect(await prisma.pushDevice.count({ where: { token } })).toBe(1);
    } finally {
      // Cascade also removes the reassigned device row.
      await prisma.account.delete({ where: { id: other.id } });
    }
  });

  it('DELETE /devices/:token removes the row; deletes are account-scoped', async () => {
    const token = `${TOKEN_PREFIX}delete_me`;
    await pushService.registerDevice(accountId, { platform: 'ios', token });

    // Another account deleting our token is a no-op.
    const other = await prisma.account.create({
      data: { name: 'Push Delete Test', email: 'push-delete@test.example' },
    });
    try {
      await pushService.unregisterDevice(other.id, token);
      expect(await prisma.pushDevice.count({ where: { token } })).toBe(1);
    } finally {
      await prisma.account.delete({ where: { id: other.id } });
    }

    const res = await inject('DELETE', `/devices/${token}`);
    expect(res.statusCode).toBe(204);
    expect(await prisma.pushDevice.count({ where: { token } })).toBe(0);
  });
});

describe('pushService.notifyAccount', () => {
  it('sends to every device on the account', async () => {
    const tokens = [`${TOKEN_PREFIX}fanout_1`, `${TOKEN_PREFIX}fanout_2`];
    for (const token of tokens) {
      await pushService.registerDevice(accountId, { platform: 'ios', token });
    }
    resetMockPush();
    await pushService.notifyAccount(accountId, { title: 'Hello', body: 'World', deepLink: '/x' });
    // Filter to this test's tokens — earlier registrations may still exist.
    const mine = sentPushes.filter((p) => tokens.includes(p.deviceToken));
    expect(mine.map((p) => p.deviceToken).sort()).toEqual(tokens);
    expect(mine[0]!.message).toEqual({ title: 'Hello', body: 'World', deepLink: '/x' });
    await prisma.pushDevice.deleteMany({ where: { token: { in: tokens } } });
  });

  it('prunes tokens the provider reports as unregistered', async () => {
    const dead = `${TOKEN_PREFIX}unregistered_gone`;
    const alive = `${TOKEN_PREFIX}still_alive`;
    await pushService.registerDevice(accountId, { platform: 'ios', token: dead });
    await pushService.registerDevice(accountId, { platform: 'ios', token: alive });
    resetMockPush();
    await pushService.notifyAccount(accountId, { title: 'Prune', body: 'check' });
    expect(await prisma.pushDevice.count({ where: { token: dead } })).toBe(0);
    expect(await prisma.pushDevice.count({ where: { token: alive } })).toBe(1);
    await prisma.pushDevice.deleteMany({ where: { token: alive } });
  });

  it('never throws — resolves quietly with no devices registered', async () => {
    await expect(
      pushService.notifyAccount('acct_does_not_exist', { title: 'x', body: 'y' }),
    ).resolves.toBeUndefined();
  });
});

describe('trigger: rent payment → landlord push', () => {
  const created = { propertyId: '', unitId: '', tenantId: '', leaseId: '' };

  afterAll(async () => {
    const payment = await prisma.rentPayment.findFirst({ where: { leaseId: created.leaseId } });
    if (payment?.transactionId) {
      await prisma.rentPayment.update({
        where: { id: payment.id },
        data: { transactionId: null },
      });
      await prisma.transaction.delete({ where: { id: payment.transactionId } });
      await prisma.auditLog.deleteMany({
        where: { entityId: { in: [payment.id, payment.transactionId] } },
      });
    }
    if (created.propertyId) {
      await prisma.property.delete({ where: { id: created.propertyId } });
    }
    if (created.tenantId) {
      await prisma.tenant.delete({ where: { id: created.tenantId } });
    }
  });

  it('POST /rent/payments notifies the account devices', async () => {
    const property = await prisma.property.create({
      data: {
        accountId,
        addressLine1: '99 Push Trigger Ln',
        city: 'Testville',
        state: 'NY',
        zip: '10001',
      },
    });
    created.propertyId = property.id;
    const unit = await prisma.unit.create({ data: { propertyId: property.id, label: 'PT-1' } });
    created.unitId = unit.id;
    const tenant = await prisma.tenant.create({
      data: { accountId, fullName: 'Pusha Tenant' },
    });
    created.tenantId = tenant.id;
    const lease = await prisma.lease.create({
      data: {
        unitId: unit.id,
        rentCents: 123400,
        dueDay: 1,
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-12-31'),
        status: 'active',
        leaseTenants: { create: { tenantId: tenant.id, isPrimary: true } },
      },
    });
    created.leaseId = lease.id;

    const token = `${TOKEN_PREFIX}rent_trigger`;
    await pushService.registerDevice(accountId, { platform: 'ios', token });
    resetMockPush();

    const res = await inject('POST', '/rent/payments', {
      leaseId: lease.id,
      period: currentPeriod(),
      amountCents: 123400,
      method: 'manual',
    });
    expect(res.statusCode).toBe(201);

    const push = sentPushes.find((p) => p.deviceToken === token);
    expect(push).toBeDefined();
    expect(push!.message.title).toBe('Rent received');
    expect(push!.message.body).toBe(
      `Pusha Tenant paid ${formatUsd(123400)} for ${currentPeriod()}`,
    );
    expect(push!.message.deepLink).toBe('/rent');
  });
});

describe('trigger: daily jobs push fresh warning insights', () => {
  it('a newly created warning insight during runDailyJobs is pushed', async () => {
    const token = `${TOKEN_PREFIX}daily_jobs`;
    await pushService.registerDevice(accountId, { platform: 'ios', token });

    // Settle insights first so the only *new* warning the daily run creates is
    // the synthetic late rent below (dedupeKey-guarded rows aren't "new").
    await insightService.generateInsights(accountId);

    // Synthesize a fresh late-rent condition: an unpaid current-period rent 10
    // days past due (> the 5-day rule threshold), on a lease whose end date
    // stays outside the 60-day renewal window so no other insight fires.
    const tenantName = 'Overdue Ollie Pushtest';
    const property = await prisma.property.create({
      data: {
        accountId,
        addressLine1: '7 Late Rent Way',
        city: 'Testville',
        state: 'NY',
        zip: '10001',
      },
    });
    const unit = await prisma.unit.create({ data: { propertyId: property.id, label: 'LR-1' } });
    const tenant = await prisma.tenant.create({ data: { accountId, fullName: tenantName } });
    const lease = await prisma.lease.create({
      data: {
        unitId: unit.id,
        rentCents: 98700,
        dueDay: 1,
        startDate: new Date('2026-01-01'),
        endDate: new Date('2027-06-30'),
        status: 'active',
        leaseTenants: { create: { tenantId: tenant.id, isPrimary: true } },
      },
    });
    const dueDate = new Date();
    dueDate.setUTCDate(dueDate.getUTCDate() - 10);
    await prisma.rentPayment.create({
      data: {
        leaseId: lease.id,
        period: currentPeriod(),
        dueDate,
        amountCents: 98700,
        status: 'due',
      },
    });

    const reportsBefore = new Set(
      (await prisma.report.findMany({ select: { id: true } })).map((r) => r.id),
    );

    resetMockPush();
    try {
      const result = await runDailyJobs();
      expect(result.errors).toEqual([]);
      const push = sentPushes.find(
        (p) => p.deviceToken === token && p.message.title.startsWith(tenantName),
      );
      expect(push).toBeDefined();
      expect(push!.message.title).toContain('days late on rent');
      expect(push!.message.deepLink).toBe('/rent');
    } finally {
      // Restore the pristine seed: drop the synthetic insight + portfolio rows
      // and any monthly-review report the run snapshotted.
      await prisma.insight.deleteMany({ where: { accountId, tenantId: tenant.id } });
      await prisma.property.delete({ where: { id: property.id } });
      await prisma.tenant.delete({ where: { id: tenant.id } });
      await prisma.report.deleteMany({
        where: { id: { notIn: [...reportsBefore] }, type: 'monthly_review' },
      });
      await prisma.pushDevice.deleteMany({ where: { token } });
    }
  });
});
