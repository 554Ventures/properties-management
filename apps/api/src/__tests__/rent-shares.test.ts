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

  it('disambiguates a deposit fitting several charges when the descriptor names exactly one tenant; a still-ambiguous one surfaces as a candidate list', async () => {
    // Both seeded open charges (Okafor's and Park's) can absorb a small
    // unattributed deposit.
    const tracker = await rentService.getMonthStatus(accountId, period);
    const okafor = tracker.rows.find((r) => r.tenantName === OKAFOR_NAME)!;
    const park = tracker.rows.find((r) => r.tenantName === PARK_NAME)!;
    const amountCents = 40000;
    expect(amountCents).toBeLessThanOrEqual(okafor.amountCents - okafor.paidCents);
    expect(amountCents).toBeLessThanOrEqual(park.amountCents - park.paidCents);

    const rentCategory = await prisma.category.findFirstOrThrow({
      where: { name: 'Rent', type: 'income', isSystem: true },
    });
    const base = {
      accountId,
      categoryId: rentCategory.id,
      date: new Date(),
      amountCents,
      type: 'income',
      source: 'manual',
      status: 'confirmed',
    } as const;
    const named = await prisma.transaction.create({
      data: { ...base, description: 'TEST ZELLE FROM T OKAFOR' },
    });
    const bland = await prisma.transaction.create({
      data: { ...base, description: 'TEST MYSTERY DEPOSIT' },
    });

    const body = UnlinkedRentDepositsResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/v1/rent/unlinked-deposits?period=${period}` })).json(),
    );
    // Descriptor names Okafor's lease tenant → that charge, unambiguously —
    // a name-disambiguated single still lands in `items` exactly as before.
    expect(body.items.find((i) => i.transactionId === named.id)).toMatchObject({
      rentPaymentId: okafor.rentPaymentId,
      tenantName: OKAFOR_NAME,
    });
    expect(body.ambiguous?.find((a) => a.transactionId === named.id)).toBeUndefined();
    // Bland descriptor still fits both charges → the manual picker's
    // `ambiguous` list (rent-match v2), never silently dropped.
    expect(body.items.find((i) => i.transactionId === bland.id)).toBeUndefined();
    const ambiguousEntry = body.ambiguous?.find((a) => a.transactionId === bland.id);
    expect(ambiguousEntry).toMatchObject({ amountCents, description: 'TEST MYSTERY DEPOSIT' });
    expect(ambiguousEntry?.candidates).toHaveLength(2);
    expect(new Set(ambiguousEntry?.candidates.map((c) => c.rentPaymentId))).toEqual(
      new Set([okafor.rentPaymentId, park.rentPaymentId]),
    );

    await prisma.transaction.deleteMany({ where: { id: { in: [named.id, bland.id] } } });
  });

  it('links an ambiguous deposit through the existing POST /transactions/:id/confirm { rentPaymentId } path — it drops off the next response', async () => {
    const tracker = await rentService.getMonthStatus(accountId, period);
    const okafor = tracker.rows.find((r) => r.tenantName === OKAFOR_NAME)!;
    const park = tracker.rows.find((r) => r.tenantName === PARK_NAME)!;
    const amountCents = 40000;
    expect(amountCents).toBeLessThanOrEqual(okafor.amountCents - okafor.paidCents);
    expect(amountCents).toBeLessThanOrEqual(park.amountCents - park.paidCents);
    const startedAt = new Date();

    const rentCategory = await prisma.category.findFirstOrThrow({
      where: { name: 'Rent', type: 'income', isSystem: true },
    });
    const txn = await prisma.transaction.create({
      data: {
        accountId,
        categoryId: rentCategory.id,
        date: new Date(),
        amountCents,
        type: 'income',
        source: 'manual',
        status: 'confirmed',
        description: 'TEST AMBIGUOUS DEPOSIT TO LINK',
      },
    });

    const before = UnlinkedRentDepositsResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/v1/rent/unlinked-deposits?period=${period}` })).json(),
    );
    expect(
      before.ambiguous?.find((a) => a.transactionId === txn.id)?.candidates.map((c) => c.rentPaymentId),
    ).toEqual(expect.arrayContaining([okafor.rentPaymentId, park.rentPaymentId]));

    // The manual picker: the user resolves the ambiguity by choosing Okafor's
    // charge, through the same confirm path the heuristic-matched flow uses.
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${txn.id}/confirm`,
      payload: { rentPaymentId: okafor.rentPaymentId, linkSource: 'manual' },
    });
    expect(confirmRes.statusCode).toBe(200);

    // A hand-picked charge is the user's own call — plain 'user' actor, not
    // the ai_suggested_user_confirmed upgrade an accepted suggestion gets.
    const confirmAudit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'transaction.confirmed', entityId: txn.id },
    });
    expect(confirmAudit?.actor).toBe('user');

    const after = UnlinkedRentDepositsResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/v1/rent/unlinked-deposits?period=${period}` })).json(),
    );
    expect(after.ambiguous?.find((a) => a.transactionId === txn.id)).toBeUndefined();
    expect(after.items.find((i) => i.transactionId === txn.id)).toBeUndefined();
    const linked = await prisma.rentPayment.findUniqueOrThrow({ where: { id: okafor.rentPaymentId } });
    expect(linked.paidCents).toBe(amountCents);

    // Cleanup: unlink (reverts paidCents/status), delete the test transaction,
    // and its audit trail (scoped to rows created just now) so Okafor's charge
    // is exactly as the seed left it for later files.
    const deposit = await prisma.rentPaymentDeposit.findUniqueOrThrow({ where: { transactionId: txn.id } });
    await rentService.unlinkDeposit(accountId, okafor.rentPaymentId, deposit.id);
    await prisma.transaction.delete({ where: { id: txn.id } });
    await prisma.auditLog.deleteMany({
      where: { accountId, entityId: { in: [txn.id, okafor.rentPaymentId] }, createdAt: { gte: startedAt } },
    });
  });
});

// A deposit that arrives through the bank and is linked with POST
// /transactions/:id/confirm used to persist tenantId: null unconditionally, so
// two roommates closing one charge with two Zelle deposits left the charge
// reading "paid" while BOTH co-tenants read paidCents: 0, settled: false.
describe('confirm-path deposit attribution', () => {
  const startedAt = new Date();

  beforeAll(async () => {
    // Start from an untouched charge — earlier blocks left a recorded payment
    // on it, and the two-roommate repro needs both halves of it open.
    const row = await parkRow();
    const deposits = await prisma.rentPaymentDeposit.findMany({
      where: { rentPaymentId: row.rentPaymentId },
    });
    await prisma.transaction.deleteMany({
      where: { id: { in: deposits.map((d) => d.transactionId) } },
    });
    await prisma.rentPayment.update({
      where: { id: row.rentPaymentId },
      data: {
        paidCents: 0,
        status: 'due',
        method: null,
        paidAt: null,
        externalRef: null,
        transactionId: null,
      },
    });
  });

  /** A confirmed Rent income on Park's unit, ready to be linked as a deposit. */
  async function depositTxn(description: string, amountCents: number) {
    const row = await parkRow();
    const rentCategory = await prisma.category.findFirstOrThrow({
      where: { name: 'Rent', type: 'income', isSystem: true },
    });
    return prisma.transaction.create({
      data: {
        accountId,
        propertyId: row.propertyId,
        unitId: row.unitId,
        categoryId: rentCategory.id,
        date: new Date(),
        amountCents,
        type: 'income',
        description,
        source: 'bank',
        status: 'pending_review',
      },
    });
  }

  /** Undo one linked deposit and delete the ledger row behind it. */
  async function undo(txnId: string, rentPaymentId: string) {
    const deposit = await prisma.rentPaymentDeposit.findUnique({ where: { transactionId: txnId } });
    if (deposit) await rentService.unlinkDeposit(accountId, rentPaymentId, deposit.id);
    await prisma.transaction.delete({ where: { id: txnId } });
  }

  it('attributes an explicit tenantId to that co-tenant, and settles their share', async () => {
    const row = await parkRow();
    const park = row.tenants.find((t) => t.tenantName === PARK_NAME)!;
    const amountCents = 10_000;

    const txn = await depositTxn('TEST BANK DEPOSIT UNSIGNED', amountCents);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${txn.id}/confirm`,
      payload: { rentPaymentId: row.rentPaymentId, tenantId: park.tenantId },
    });
    expect(res.statusCode).toBe(200);

    const deposit = await prisma.rentPaymentDeposit.findUniqueOrThrow({
      where: { transactionId: txn.id },
    });
    expect(deposit.tenantId).toBe(park.tenantId);
    const after = await parkRow();
    expect(after.tenants.find((t) => t.tenantId === park.tenantId)!.paidCents).toBe(amountCents);
    expect(after.deposits.find((d) => d.transactionId === txn.id)!.tenantId).toBe(park.tenantId);

    await undo(txn.id, row.rentPaymentId);
  });

  it('leaves BOTH co-tenants settled when two deposits close one charge — and the charge itself reads exactly as it does unattributed', async () => {
    // Baseline: the pre-fix behaviour, both deposits linked with no payer.
    const before = await parkRow();
    const half = before.amountCents / 2;
    expect(before.paidCents).toBe(0); // Park's charge starts the block untouched
    const blandA = await depositTxn('TEST DEPOSIT ONE', half);
    const blandB = await depositTxn('TEST DEPOSIT TWO', half);
    for (const t of [blandA, blandB]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/transactions/${t.id}/confirm`,
        payload: { rentPaymentId: before.rentPaymentId },
      });
      expect(res.statusCode).toBe(200);
    }
    const unattributed = await parkRow();
    // The bug, reproduced: charge covered, nobody credited.
    expect(unattributed.tenants.every((t) => t.paidCents === 0 && !t.settled)).toBe(true);
    const chargeFigures = {
      amountCents: unattributed.amountCents,
      paidCents: unattributed.paidCents,
      lateFeeCents: unattributed.lateFeeCents,
      status: unattributed.status,
      remainingCents: unattributed.amountCents + unattributed.lateFeeCents - unattributed.paidCents,
    };
    expect(chargeFigures.paidCents).toBe(PARK_RENT_CENTS);
    await undo(blandA.id, before.rentPaymentId);
    await undo(blandB.id, before.rentPaymentId);

    // Same two deposits, now each naming its payer.
    const row = await parkRow();
    const park = row.tenants.find((t) => t.tenantName === PARK_NAME)!;
    const osei = row.tenants.find((t) => t.tenantName === PARK_COTENANT_NAME)!;
    const parkTxn = await depositTxn('TEST DEPOSIT ONE', half);
    const oseiTxn = await depositTxn('TEST DEPOSIT TWO', half);
    for (const [t, tenantId] of [
      [parkTxn, park.tenantId],
      [oseiTxn, osei.tenantId],
    ] as const) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/transactions/${t.id}/confirm`,
        payload: { rentPaymentId: row.rentPaymentId, tenantId },
      });
      expect(res.statusCode).toBe(200);
    }

    const attributed = await parkRow();
    expect(attributed.tenants.map((t) => [t.paidCents, t.settled])).toEqual([
      [PARK_SHARE_CENTS, true],
      [PARK_SHARE_CENTS, true],
    ]);
    // Attribution moves attribution, never money: the charge is identical.
    expect({
      amountCents: attributed.amountCents,
      paidCents: attributed.paidCents,
      lateFeeCents: attributed.lateFeeCents,
      status: attributed.status,
      remainingCents: attributed.amountCents + attributed.lateFeeCents - attributed.paidCents,
    }).toEqual(chargeFigures);

    await undo(parkTxn.id, row.rentPaymentId);
    await undo(oseiTxn.id, row.rentPaymentId);
  });

  it('refuses a tenant who is not on the charge\'s lease, and links nothing', async () => {
    const row = await parkRow();
    const stranger = await prisma.tenant.findFirstOrThrow({
      where: { accountId, fullName: OKAFOR_NAME },
    });
    const txn = await depositTxn('TEST BANK DEPOSIT STRANGER', 10_000);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${txn.id}/confirm`,
      payload: { rentPaymentId: row.rentPaymentId, tenantId: stranger.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/not on this lease/);
    // Rejected before anything was written: no deposit, still pending review.
    expect(await prisma.rentPaymentDeposit.findUnique({ where: { transactionId: txn.id } })).toBeNull();
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: txn.id } })).status).toBe(
      'pending_review',
    );
    expect((await parkRow()).paidCents).toBe(row.paidCents);

    await prisma.transaction.delete({ where: { id: txn.id } });
  });

  it('infers the payer when the bank descriptor names exactly one lease tenant, and says so in the audit', async () => {
    const row = await parkRow();
    const park = row.tenants.find((t) => t.tenantName === PARK_NAME)!;
    const txn = await depositTxn('TEST ZELLE FROM D PARK', 10_000);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${txn.id}/confirm`,
      payload: { rentPaymentId: row.rentPaymentId },
    });
    expect(res.statusCode).toBe(200);
    const deposit = await prisma.rentPaymentDeposit.findUniqueOrThrow({
      where: { transactionId: txn.id },
    });
    expect(deposit.tenantId).toBe(park.tenantId);

    // Inferred, not stated — the audit trail has to keep those apart.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { accountId, action: 'rent_payment.recorded', entityId: row.rentPaymentId },
      orderBy: { createdAt: 'desc' },
    });
    expect(JSON.parse(audit.detailJson!)).toMatchObject({
      tenantId: park.tenantId,
      tenantAttribution: 'inferred',
    });

    await undo(txn.id, row.rentPaymentId);
  });

  it('attributes nobody when the descriptor names no tenant or names both', async () => {
    const row = await parkRow();
    const bland = await depositTxn('TEST MYSTERY DEPOSIT', 10_000);
    const both = await depositTxn('TEST ZELLE FROM PARK AND OSEI', 10_000);

    for (const t of [bland, both]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/transactions/${t.id}/confirm`,
        payload: { rentPaymentId: row.rentPaymentId },
      });
      expect(res.statusCode).toBe(200);
      const deposit = await prisma.rentPaymentDeposit.findUniqueOrThrow({
        where: { transactionId: t.id },
      });
      expect(deposit.tenantId).toBeNull();
    }
    // Ambiguity costs nothing but attribution: the charge still collected both.
    expect((await parkRow()).paidCents).toBe(row.paidCents + 20_000);

    await undo(bland.id, row.rentPaymentId);
    await undo(both.id, row.rentPaymentId);
  });

  it('lets an explicit tenantId beat the name in the descriptor, audited as stated', async () => {
    const row = await parkRow();
    const osei = row.tenants.find((t) => t.tenantName === PARK_COTENANT_NAME)!;
    // Descriptor says Park; the caller says Osei (a Zelle sent from the wrong
    // roommate's account). The human statement wins.
    const txn = await depositTxn('TEST ZELLE FROM D PARK', 10_000);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${txn.id}/confirm`,
      payload: { rentPaymentId: row.rentPaymentId, tenantId: osei.tenantId },
    });
    expect(res.statusCode).toBe(200);
    const deposit = await prisma.rentPaymentDeposit.findUniqueOrThrow({
      where: { transactionId: txn.id },
    });
    expect(deposit.tenantId).toBe(osei.tenantId);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { accountId, action: 'rent_payment.recorded', entityId: row.rentPaymentId },
      orderBy: { createdAt: 'desc' },
    });
    expect(JSON.parse(audit.detailJson!)).toMatchObject({
      tenantId: osei.tenantId,
      tenantAttribution: 'stated',
    });

    await undo(txn.id, row.rentPaymentId);
  });

  // The repair path for deposits linked before any of this existed: ~15 closed
  // charges in production carry a null-attributed deposit, and unlink/re-link
  // would reopen a settled charge to change a field that moves no money.
  it('re-points an already-linked deposit without touching the charge, and refuses a stranger', async () => {
    const row = await parkRow();
    const park = row.tenants.find((t) => t.tenantName === PARK_NAME)!;
    const txn = await depositTxn('TEST DEPOSIT TO REPAIR', 10_000);
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${txn.id}/confirm`,
      payload: { rentPaymentId: row.rentPaymentId },
    });
    expect(confirmRes.statusCode).toBe(200);
    const deposit = await prisma.rentPaymentDeposit.findUniqueOrThrow({
      where: { transactionId: txn.id },
    });
    expect(deposit.tenantId).toBeNull(); // the shape production is stuck in
    const linked = await parkRow();

    const stranger = await prisma.tenant.findFirstOrThrow({
      where: { accountId, fullName: OKAFOR_NAME },
    });
    const refused = await app.inject({
      method: 'PATCH',
      url: `/api/v1/rent/payments/${row.rentPaymentId}/deposits/${deposit.id}`,
      payload: { tenantId: stranger.id },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toMatch(/not on this lease/);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/rent/payments/${row.rentPaymentId}/deposits/${deposit.id}`,
      payload: { tenantId: park.tenantId },
    });
    expect(res.statusCode).toBe(200);
    expect(
      (await prisma.rentPaymentDeposit.findUniqueOrThrow({ where: { id: deposit.id } })).tenantId,
    ).toBe(park.tenantId);

    const repaired = await parkRow();
    expect(repaired.tenants.find((t) => t.tenantId === park.tenantId)!.paidCents).toBe(10_000);
    // Money is untouched: same charge figures before and after the repair.
    expect({
      paidCents: repaired.paidCents,
      lateFeeCents: repaired.lateFeeCents,
      status: repaired.status,
      paidAt: repaired.paidAt,
    }).toEqual({
      paidCents: linked.paidCents,
      lateFeeCents: linked.lateFeeCents,
      status: linked.status,
      paidAt: linked.paidAt,
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { accountId, action: 'rent_payment.deposit_attributed', entityId: row.rentPaymentId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.actor).toBe('user');
    expect(JSON.parse(audit.detailJson!)).toMatchObject({
      depositId: deposit.id,
      tenantId: park.tenantId,
      previousTenantId: null,
    });

    // …and it clears back to "the unit paid, we don't know who".
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/v1/rent/payments/${row.rentPaymentId}/deposits/${deposit.id}`,
      payload: { tenantId: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(
      (await prisma.rentPaymentDeposit.findUniqueOrThrow({ where: { id: deposit.id } })).tenantId,
    ).toBeNull();

    await undo(txn.id, row.rentPaymentId);
  });

  afterAll(async () => {
    // Every test undoes its own links; this clears the audit trail they left so
    // later files see the seeded account.
    await prisma.auditLog.deleteMany({
      where: { accountId, entityType: 'rent_payment', createdAt: { gte: startedAt } },
    });
  });
});
