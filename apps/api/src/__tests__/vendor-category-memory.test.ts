// Workstream A of TRUSTWORTHY_TRANSACTIONS_PLAN.md: category corrections are
// remembered per (account, normalized vendor, type) and auto-suggested for
// future transactions from the same vendor. Every row this file creates is
// deleted again so the seeded ledger stays pristine.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ReviewQueueResponseSchema } from '@hearth/shared';
import { buildApp } from '../app';
import { iso } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import * as transactionService from '../services/transaction.service';
import { vendorKey, vendorMemoryKey } from '../services/vendor';

let app: FastifyInstance;
let accountId: string;
const createdTxnIds: string[] = [];
const categoryIdByName = new Map<string, string>();

const catId = (name: string): string => {
  const id = categoryIdByName.get(name);
  if (!id) throw new Error(`missing seeded category ${name}`);
  return id;
};

async function createPending(input: {
  vendor: string;
  description: string;
  type?: 'income' | 'expense';
}): Promise<{ id: string; aiSuggestedCategoryId: string | null; aiConfidence: number | null }> {
  const row = await transactionService.create(
    accountId,
    {
      date: iso(new Date()),
      amountCents: 4321,
      type: input.type ?? 'expense',
      description: input.description,
      vendor: input.vendor,
    },
    { source: 'bank', status: 'pending_review', actor: 'system' },
  );
  createdTxnIds.push(row.id);
  return row;
}

beforeAll(async () => {
  app = await buildApp();
  accountId = await getDemoAccountId();
  const categories = await prisma.category.findMany({ where: { isSystem: true } });
  for (const c of categories) categoryIdByName.set(c.name, c.id);
});

afterAll(async () => {
  await prisma.transaction.deleteMany({ where: { id: { in: createdTxnIds } } });
  await prisma.vendorCategoryMemory.deleteMany({ where: { accountId } });
  await app.close();
});

describe('vendorMemoryKey', () => {
  it('strips bank-descriptor noise so the same merchant keys identically', () => {
    expect(vendorMemoryKey('AMZN Mktp US*1A2B3C')).toBe('amzn mktp us');
    expect(vendorMemoryKey('AMZN Mktp US*9Z8Y7X')).toBe('amzn mktp us');
    expect(vendorMemoryKey('HOME DEPOT 4512')).toBe('home depot');
    expect(vendorMemoryKey('  Reyes Plumbing  ')).toBe('reyes plumbing');
  });

  it('keeps at least one token and leaves the plain contractor key untouched', () => {
    expect(vendorMemoryKey('7-Eleven')).toBe('7-eleven');
    expect(vendorKey('  Reyes Plumbing  ')).toBe('reyes plumbing');
  });
});

describe('category learning', () => {
  it('a correction at confirm time writes memory; the next transaction from that vendor gets the learned suggestion', async () => {
    const pending = await createPending({
      vendor: 'AMZN Mktp US*1A2B3C',
      description: 'Household order',
    });
    // Keyword table has no match → fallback Supplies.
    expect(pending.aiSuggestedCategoryId).toBe(catId('Supplies'));

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${pending.id}/confirm`,
      payload: { categoryId: catId('Cleaning & Maintenance') },
    });
    expect(res.statusCode).toBe(200);

    const memory = await prisma.vendorCategoryMemory.findUnique({
      where: {
        accountId_vendorKey_type: { accountId, vendorKey: 'amzn mktp us', type: 'expense' },
      },
    });
    expect(memory?.categoryId).toBe(catId('Cleaning & Maintenance'));
    expect(memory?.hitCount).toBe(1);
    expect(memory?.confidence).toBe(0.95);

    // Same merchant, different descriptor noise → learned suggestion.
    const next = await createPending({
      vendor: 'AMZN MKTP US*9Z8Y7X',
      description: 'Household order',
    });
    expect(next.aiSuggestedCategoryId).toBe(catId('Cleaning & Maintenance'));
    expect(next.aiConfidence).toBe(0.95);

    // The review queue labels it as learned.
    const queue = ReviewQueueResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/transactions/review?q=Household' })).json(),
    );
    const item = queue.items.find((i) => i.id === next.id);
    expect(item?.suggestionSource).toBe('learned');

    // The corrected row itself keeps its category (no retroactive edits).
    const confirmed = await prisma.transaction.findUniqueOrThrow({ where: { id: pending.id } });
    expect(confirmed.categoryId).toBe(catId('Cleaning & Maintenance'));
  });

  it('accepting a learned suggestion reinforces it (hitCount + confidence)', async () => {
    const next = await createPending({
      vendor: 'AMZN Mktp US*5Q6R7S',
      description: 'Household order',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${next.id}/confirm`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const memory = await prisma.vendorCategoryMemory.findUniqueOrThrow({
      where: {
        accountId_vendorKey_type: { accountId, vendorKey: 'amzn mktp us', type: 'expense' },
      },
    });
    expect(memory.hitCount).toBe(2);
    expect(memory.confidence).toBeCloseTo(0.96, 5);
  });

  it('accepting a keyword-table suggestion does NOT mint a memory row', async () => {
    const pending = await createPending({
      vendor: 'Fresh Vendor LLC',
      description: 'Roof repair after storm',
    });
    expect(pending.aiSuggestedCategoryId).toBe(catId('Repairs')); // keyword match
    await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${pending.id}/confirm`,
      payload: {},
    });
    const memory = await prisma.vendorCategoryMemory.findUnique({
      where: {
        accountId_vendorKey_type: { accountId, vendorKey: 'fresh vendor llc', type: 'expense' },
      },
    });
    expect(memory).toBeNull();
  });

  it('recategorizing an already-confirmed row via PATCH is a correction signal too', async () => {
    const created = await transactionService.create(accountId, {
      date: iso(new Date()),
      amountCents: 8800,
      type: 'expense',
      description: 'Monthly service',
      vendor: 'Metro Waste 887',
      categoryId: catId('Supplies'),
    });
    createdTxnIds.push(created.id);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/transactions/${created.id}`,
      payload: { categoryId: catId('Utilities') },
    });
    expect(res.statusCode).toBe(200);
    const memory = await prisma.vendorCategoryMemory.findUnique({
      where: {
        accountId_vendorKey_type: { accountId, vendorKey: 'metro waste', type: 'expense' },
      },
    });
    expect(memory?.categoryId).toBe(catId('Utilities'));
  });

  it('a different vendor is unaffected by learned memory', async () => {
    const pending = await createPending({
      vendor: 'Blue Bottle Coffee',
      description: 'Client meeting',
    });
    expect(pending.aiSuggestedCategoryId).toBe(catId('Supplies')); // fallback, not learned
    expect(pending.aiConfidence).toBe(0.62);
  });

  it('memory is account-scoped', async () => {
    const other = await prisma.account.create({
      data: { name: 'Other Landlord', email: 'vendor-memory-isolation@example.com' },
    });
    try {
      await prisma.vendorCategoryMemory.create({
        data: {
          accountId: other.id,
          vendorKey: 'blue bottle coffee',
          type: 'expense',
          categoryId: catId('Travel'),
        },
      });
      const suggestion = await transactionService.suggestCategory(accountId, {
        type: 'expense',
        description: 'Client meeting',
        vendor: 'Blue Bottle Coffee',
      });
      expect(suggestion?.categoryId).toBe(catId('Supplies')); // demo account never sees it
      expect(suggestion?.source).toBe('fallback');
    } finally {
      await prisma.account.delete({ where: { id: other.id } }); // cascades the memory row
    }
  });
});
