// Workstream C of TRUSTWORTHY_TRANSACTIONS_PLAN.md: per-tenant shares on the
// rent tracker (stored or even-split fallback), deposit attribution via
// tenantId, and the unlinked-Rent-deposit nudge. Uses the seeded co-tenant
// fixture (Park + R. Osei split the Birch Ln charge) and restores every
// mutation so later files see the seeded state.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { RentTrackerResponseSchema, UnlinkedRentDepositsResponseSchema } from '@hearth/shared';
import {
  OKAFOR_NAME,
  OKAFOR_RENT_CENTS,
  PARK_COTENANT_NAME,
  PARK_NAME,
  PARK_RENT_CENTS,
  PARK_SHARE_CENTS,
} from '../../prisma/seed-constants';
import { buildApp } from '../app';
import { currentPeriod } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import * as rentService from '../services/rent.service';

let app: FastifyInstance;
let accountId: string;
const period = currentPeriod();

async function parkRow() {
  const tracker = await rentService.getMonthStatus(accountId, period);
  const row = tracker.rows.find((r) => r.tenantName === PARK_NAME);
  if (!row) throw new Error('Park row missing');
  return row;
}

beforeAll(async () => {
  app = await buildApp();
  accountId = await getDemoAccountId();
});

afterAll(async () => {
  // Restore Park's charge to fully unpaid for later files.
  const row = await parkRow();
  const ledger = await prisma.transaction.findMany({
    where: { accountId, description: { startsWith: 'Rent payment — ' }, date: { gte: new Date(Date.now() - 86_400_000) } },
    select: { id: true },
  });
  await prisma.transaction.deleteMany({ where: { id: { in: ledger.map((t) => t.id) } } });
  await prisma.rentPayment.update({
    where: { id: row.rentPaymentId },
    data: {
      status: 'due',
      method: null,
      paidAt: null,
      externalRef: null,
      transactionId: null,
      paidCents: 0,
    },
  });
  await prisma.auditLog.deleteMany({
    where: { accountId, entityId: { in: [row.rentPaymentId, ...ledger.map((t) => t.id)] } },
  });
  await app.close();
});

describe('per-tenant shares on the tracker (seed co-tenant fixture)', () => {
  it('exposes both co-tenants with their stored shares; single-tenant rows fall back to an even split of one', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/rent/tracker?period=${period}` });
    const tracker = RentTrackerResponseSchema.parse(res.json());

    const park = tracker.rows.find((r) => r.tenantName === PARK_NAME)!;
    expect(park.tenants).toHaveLength(2);
    expect(park.tenants[0]!.tenantName).toBe(PARK_NAME); // primary first
    expect(park.tenants.map((t) => t.shareCents)).toEqual([PARK_SHARE_CENTS, PARK_SHARE_CENTS]);
    expect(park.tenants.every((t) => t.shareSpecified)).toBe(true);
    expect(park.sharesMismatch).toBe(false);

    const okafor = tracker.rows.find((r) => r.tenantName === OKAFOR_NAME)!;
    expect(okafor.tenants).toHaveLength(1);
    expect(okafor.tenants[0]!.shareCents).toBe(OKAFOR_RENT_CENTS); // even split of one
    expect(okafor.tenants[0]!.shareSpecified).toBe(false);
  });

  it('attributes a tenantId-tagged deposit to that co-tenant and settles their share', async () => {
    const row = await parkRow();
    const cotenant = row.tenants.find((t) => t.tenantName === PARK_COTENANT_NAME)!;

    const paid = await rentService.recordPayment(accountId, {
      leaseId: row.leaseId,
      period,
      amountCents: PARK_SHARE_CENTS,
      method: 'manual',
      tenantId: cotenant.tenantId,
    });
    expect(paid.paidCents).toBe(PARK_SHARE_CENTS);

    const after = await parkRow();
    expect(after.status).toBe('partial');
    const osei = after.tenants.find((t) => t.tenantId === cotenant.tenantId)!;
    expect(osei.paidCents).toBe(PARK_SHARE_CENTS);
    expect(osei.settled).toBe(true);
    const park = after.tenants.find((t) => t.tenantName === PARK_NAME)!;
    expect(park.paidCents).toBe(0);
    expect(park.settled).toBe(false);
  });

  it('rejects attributing a payment to a tenant who is not on the lease', async () => {
    const row = await parkRow();
    const stranger = await prisma.tenant.findFirstOrThrow({
      where: { accountId, fullName: OKAFOR_NAME },
    });
    await expect(
      rentService.recordPayment(accountId, {
        leaseId: row.leaseId,
        period,
        amountCents: 1000,
        method: 'manual',
        tenantId: stranger.id,
      }),
    ).rejects.toThrow(/not on this lease/);
  });
});

describe('lease tenant share endpoint', () => {
  it('sets and clears a share via PATCH /leases/:id/tenants/:tenantId', async () => {
    const row = await parkRow();
    const cotenant = row.tenants.find((t) => t.tenantName === PARK_COTENANT_NAME)!;

    const setRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/leases/${row.leaseId}/tenants/${cotenant.tenantId}`,
      payload: { shareCents: 60000 },
    });
    expect(setRes.statusCode).toBe(204);
    let link = await prisma.leaseTenant.findUniqueOrThrow({
      where: { leaseId_tenantId: { leaseId: row.leaseId, tenantId: cotenant.tenantId } },
    });
    expect(link.shareCents).toBe(60000);
    // 60000 + 49250 ≠ 98500 → soft mismatch flag, never a hard block.
    const after = await parkRow();
    expect(after.sharesMismatch).toBe(true);

    // Restore the seeded share.
    const clearRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/leases/${row.leaseId}/tenants/${cotenant.tenantId}`,
      payload: { shareCents: PARK_SHARE_CENTS },
    });
    expect(clearRes.statusCode).toBe(204);
    link = await prisma.leaseTenant.findUniqueOrThrow({
      where: { leaseId_tenantId: { leaseId: row.leaseId, tenantId: cotenant.tenantId } },
    });
    expect(link.shareCents).toBe(PARK_SHARE_CENTS);
  });
});

describe('GET /rent/unlinked-deposits (the linkage nudge)', () => {
  it('surfaces an unlinked Rent-categorized income for a still-open charge; linking clears it', async () => {
    const row = await parkRow();
    const remaining = row.amountCents - row.paidCents;
    const rentCategory = await prisma.category.findFirstOrThrow({
      where: { name: 'Rent', type: 'income', isSystem: true },
    });
    // A confirmed Rent income on Park's unit that never got linked.
    const txn = await prisma.transaction.create({
      data: {
        accountId,
        propertyId: row.propertyId,
        unitId: row.unitId,
        categoryId: rentCategory.id,
        date: new Date(),
        amountCents: remaining,
        type: 'income',
        description: 'TEST unlinked rent deposit',
        source: 'manual',
        status: 'confirmed',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/rent/unlinked-deposits?period=${period}`,
    });
    const body = UnlinkedRentDepositsResponseSchema.parse(res.json());
    const item = body.items.find((i) => i.transactionId === txn.id);
    expect(item).toMatchObject({
      rentPaymentId: row.rentPaymentId,
      tenantName: PARK_NAME,
      remainingCents: remaining,
      period,
    });

    // Linking it through the existing confirm path clears the nudge and pays the charge.
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${txn.id}/confirm`,
      payload: { rentPaymentId: row.rentPaymentId },
    });
    expect(confirmRes.statusCode).toBe(200);

    const afterBody = UnlinkedRentDepositsResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/v1/rent/unlinked-deposits?period=${period}` })).json(),
    );
    expect(afterBody.items.find((i) => i.transactionId === txn.id)).toBeUndefined();
    const paid = await prisma.rentPayment.findUniqueOrThrow({ where: { id: row.rentPaymentId } });
    expect(paid.paidCents).toBe(PARK_RENT_CENTS);
    expect(paid.status).toBe('paid');

    // Cleanup: unlink + delete the test transaction (cascades the deposit).
    const deposit = await prisma.rentPaymentDeposit.findUniqueOrThrow({
      where: { transactionId: txn.id },
    });
    await rentService.unlinkDeposit(accountId, row.rentPaymentId, deposit.id);
    await prisma.transaction.delete({ where: { id: txn.id } });
  });

  it('does not surface amounts above the remaining balance or non-Rent income', async () => {
    const row = await parkRow();
    const remaining = row.amountCents - row.paidCents;
    const rentCategory = await prisma.category.findFirstOrThrow({
      where: { name: 'Rent', type: 'income', isSystem: true },
    });
    const otherIncome = await prisma.category.findFirstOrThrow({
      where: { name: 'Other Income', type: 'income', isSystem: true },
    });
    const over = await prisma.transaction.create({
      data: {
        accountId,
        unitId: row.unitId,
        propertyId: row.propertyId,
        categoryId: rentCategory.id,
        date: new Date(),
        amountCents: remaining + 1,
        type: 'income',
        description: 'TEST oversized deposit',
        source: 'manual',
        status: 'confirmed',
      },
    });
    const wrongCategory = await prisma.transaction.create({
      data: {
        accountId,
        unitId: row.unitId,
        propertyId: row.propertyId,
        categoryId: otherIncome.id,
        date: new Date(),
        amountCents: remaining,
        type: 'income',
        description: 'TEST laundry income',
        source: 'manual',
        status: 'confirmed',
      },
    });

    const body = UnlinkedRentDepositsResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/v1/rent/unlinked-deposits?period=${period}` })).json(),
    );
    expect(body.items.find((i) => i.transactionId === over.id)).toBeUndefined();
    expect(body.items.find((i) => i.transactionId === wrongCategory.id)).toBeUndefined();

    await prisma.transaction.deleteMany({ where: { id: { in: [over.id, wrongCategory.id] } } });
  });
});
