// (g) Transaction create returns aiSuggestedCategoryId when categoryId is
// omitted; confirm applies the suggestion; both audit-logged. Every row this
// file creates is deleted again so the seeded ledger stays pristine.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TransactionSchema } from '@hearth/shared';
import { buildApp } from '../app';
import { iso } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';

let app: FastifyInstance;
const createdIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await prisma.transaction.deleteMany({ where: { id: { in: createdIds } } });
  await app.close();
});

describe('POST /transactions', () => {
  it('suggests a category (keyword table) when categoryId is omitted', async () => {
    const accountId = await getDemoAccountId();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      payload: {
        date: iso(new Date()),
        amountCents: 21500,
        type: 'expense',
        description: 'Emergency plumbing repair — kitchen sink',
        vendor: 'Reyes Plumbing',
      },
    });
    expect(res.statusCode).toBe(201);
    const txn = TransactionSchema.parse(res.json());
    createdIds.push(txn.id);

    const repairs = await prisma.category.findFirst({ where: { name: 'Repairs', isSystem: true } });
    expect(txn.aiSuggestedCategoryId).toBe(repairs?.id);
    expect(txn.aiConfidence).toBe(0.84);
    expect(txn.categoryId).toBeNull(); // never auto-applied — save is explicit

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'transaction.created', entityId: txn.id },
    });
    expect(audit).not.toBeNull();
  });

  it('falls back to Supplies @ 0.62 for unmatched descriptions', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/transactions',
      payload: {
        date: iso(new Date()),
        amountCents: 3300,
        type: 'expense',
        description: 'Misc odds and ends',
      },
    });
    expect(res.statusCode).toBe(201);
    const txn = TransactionSchema.parse(res.json());
    createdIds.push(txn.id);
    const supplies = await prisma.category.findFirst({
      where: { name: 'Supplies', isSystem: true },
    });
    expect(txn.aiSuggestedCategoryId).toBe(supplies?.id);
    expect(txn.aiConfidence).toBe(0.62);
  });
});

describe('POST /transactions/:id/confirm', () => {
  it('applies the AI suggestion, confirms, and audit-logs the confirmation', async () => {
    const accountId = await getDemoAccountId();
    const utilities = await prisma.category.findFirst({
      where: { name: 'Utilities', isSystem: true },
    });
    const pending = await prisma.transaction.create({
      data: {
        accountId,
        date: new Date(),
        amountCents: 9900,
        type: 'expense',
        description: 'TEST CITY WATER BILL',
        source: 'bank',
        status: 'pending_review',
        aiSuggestedCategoryId: utilities?.id ?? null,
        aiConfidence: 0.91,
      },
    });
    createdIds.push(pending.id);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${pending.id}/confirm`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const confirmed = TransactionSchema.parse(res.json());
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.categoryId).toBe(utilities?.id);

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'transaction.confirmed', entityId: pending.id },
    });
    expect(audit?.actor).toBe('ai_suggested_user_confirmed');
  });
});
