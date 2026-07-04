import type {
  ConfirmTransactionInput,
  CreateTransactionInput,
  ImportTransactionsResponse,
  ReceiptScanResponse,
  ReviewQueueResponse,
  Transaction,
  TransactionListQuery,
  TransactionListResponse,
  TransactionSource,
  TransactionStatus,
  TransactionType,
  UpdateTransactionInput,
} from '@hearth/shared';
import type { Prisma, Transaction as DbTransaction } from '@prisma/client';
import { iso } from '../lib/dates';
import { NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { mockPlaid } from '../integrations/mock/mock-plaid';
import { writeAudit, type AuditActor } from './audit.service';

export function toApiTransaction(t: DbTransaction): Transaction {
  return {
    id: t.id,
    accountId: t.accountId,
    propertyId: t.propertyId,
    unitId: t.unitId,
    categoryId: t.categoryId,
    date: iso(t.date),
    amountCents: t.amountCents,
    type: t.type as TransactionType,
    description: t.description,
    vendor: t.vendor,
    source: t.source as TransactionSource,
    status: t.status as TransactionStatus,
    aiSuggestedCategoryId: t.aiSuggestedCategoryId,
    aiConfidence: t.aiConfidence,
    receiptUrl: t.receiptUrl,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}

// ── list ─────────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50;

export async function list(
  accountId: string,
  query: TransactionListQuery,
): Promise<TransactionListResponse> {
  const limit = query.limit ?? DEFAULT_LIMIT;
  const where: Prisma.TransactionWhereInput = {
    accountId,
    ...(query.propertyId ? { propertyId: query.propertyId } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.from || query.to
      ? {
          date: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lt: new Date(query.to) } : {}),
          },
        }
      : {}),
  };
  const rows = await prisma.transaction.findMany({
    where,
    orderBy: [{ date: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items: items.map(toApiTransaction),
    nextCursor: hasMore && last ? last.id : null,
  };
}

// ── AI category suggestion (mock keyword table — no AI call in this task) ────

const KEYWORD_RULES: Array<{ pattern: RegExp; categoryName: string; confidence: number }> = [
  { pattern: /plumb|roof|repair/i, categoryName: 'Repairs', confidence: 0.84 },
  { pattern: /electric|water|gas/i, categoryName: 'Utilities', confidence: 0.84 },
  { pattern: /insur/i, categoryName: 'Insurance', confidence: 0.84 },
];
const FALLBACK = { categoryName: 'Supplies', confidence: 0.62 };
const INCOME_FALLBACK = { categoryName: 'Rent', confidence: 0.8 };

export async function suggestCategory(
  accountId: string,
  partialTxn: { type: TransactionType; description?: string; vendor?: string | null },
): Promise<{ categoryId: string; confidence: number } | null> {
  const text = `${partialTxn.description ?? ''} ${partialTxn.vendor ?? ''}`;
  let pick: { categoryName: string; confidence: number };
  if (partialTxn.type === 'income') {
    pick = INCOME_FALLBACK;
  } else {
    pick = KEYWORD_RULES.find((r) => r.pattern.test(text)) ?? FALLBACK;
  }
  const category = await prisma.category.findFirst({
    where: {
      name: pick.categoryName,
      type: partialTxn.type,
      OR: [{ isSystem: true }, { accountId }],
    },
  });
  if (!category) return null;
  return { categoryId: category.id, confidence: pick.confidence };
}

// ── create / update / remove ─────────────────────────────────────────────────

export async function create(
  accountId: string,
  input: CreateTransactionInput,
  opts: { source?: TransactionSource; status?: TransactionStatus; actor?: AuditActor } = {},
): Promise<Transaction> {
  let aiSuggestedCategoryId: string | null = null;
  let aiConfidence: number | null = null;
  if (!input.categoryId) {
    const suggestion = await suggestCategory(accountId, {
      type: input.type,
      description: input.description,
      vendor: input.vendor ?? null,
    });
    if (suggestion) {
      aiSuggestedCategoryId = suggestion.categoryId;
      aiConfidence = suggestion.confidence;
    }
  }
  const row = await prisma.transaction.create({
    data: {
      accountId,
      propertyId: input.propertyId ?? null,
      unitId: input.unitId ?? null,
      categoryId: input.categoryId ?? null,
      date: new Date(input.date),
      amountCents: input.amountCents,
      type: input.type,
      description: input.description,
      vendor: input.vendor ?? null,
      source: opts.source ?? 'manual',
      status: opts.status ?? 'confirmed',
      aiSuggestedCategoryId,
      aiConfidence,
      receiptUrl: input.receiptUrl ?? null,
    },
  });
  await writeAudit(accountId, {
    actor: opts.actor ?? 'user',
    action: 'transaction.created',
    entityType: 'transaction',
    entityId: row.id,
    detail: { amountCents: row.amountCents, type: row.type, source: row.source },
  });
  return toApiTransaction(row);
}

async function getOwned(accountId: string, id: string): Promise<DbTransaction> {
  const row = await prisma.transaction.findFirst({ where: { id, accountId } });
  if (!row) throw new NotFoundError('transaction', id);
  return row;
}

export async function update(
  accountId: string,
  id: string,
  input: UpdateTransactionInput,
  actor: AuditActor = 'user',
): Promise<Transaction> {
  const prior = await getOwned(accountId, id);
  const row = await prisma.transaction.update({
    where: { id },
    data: {
      ...(input.date !== undefined ? { date: new Date(input.date) } : {}),
      ...(input.amountCents !== undefined ? { amountCents: input.amountCents } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.propertyId !== undefined ? { propertyId: input.propertyId } : {}),
      ...(input.unitId !== undefined ? { unitId: input.unitId } : {}),
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.vendor !== undefined ? { vendor: input.vendor } : {}),
      ...(input.receiptUrl !== undefined ? { receiptUrl: input.receiptUrl } : {}),
    },
  });
  await writeAudit(accountId, {
    actor,
    action: 'transaction.updated',
    entityType: 'transaction',
    entityId: id,
    detail: {
      priorAmountCents: prior.amountCents,
      priorCategoryId: prior.categoryId,
      amountCents: row.amountCents,
      categoryId: row.categoryId,
    },
  });
  return toApiTransaction(row);
}

export async function remove(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<void> {
  const prior = await getOwned(accountId, id);
  await prisma.transaction.delete({ where: { id } });
  await writeAudit(accountId, {
    actor,
    action: 'transaction.deleted',
    entityType: 'transaction',
    entityId: id,
    detail: { amountCents: prior.amountCents, categoryId: prior.categoryId, type: prior.type },
  });
}

// ── review queue / confirm ───────────────────────────────────────────────────

export async function getReviewQueue(accountId: string): Promise<ReviewQueueResponse> {
  const rows = await prisma.transaction.findMany({
    where: { accountId, status: 'pending_review' },
    orderBy: [{ date: 'desc' }, { id: 'desc' }],
  });
  const categories = await prisma.category.findMany();
  const nameById = new Map(categories.map((c) => [c.id, c.name]));
  return {
    items: rows.map((r) => ({
      ...toApiTransaction(r),
      aiSuggestedCategoryName: r.aiSuggestedCategoryId
        ? (nameById.get(r.aiSuggestedCategoryId) ?? null)
        : null,
    })),
  };
}

export async function confirm(
  accountId: string,
  id: string,
  input: ConfirmTransactionInput = {},
  actor: AuditActor = 'user',
): Promise<Transaction> {
  const existing = await getOwned(accountId, id);
  const usedSuggestion = !input.categoryId && !!existing.aiSuggestedCategoryId;
  const categoryId = input.categoryId ?? existing.aiSuggestedCategoryId ?? existing.categoryId;
  const row = await prisma.transaction.update({
    where: { id },
    data: { status: 'confirmed', categoryId },
  });
  await writeAudit(accountId, {
    // A human confirm that accepts the AI suggestion is the one case that
    // upgrades to 'ai_suggested_user_confirmed'; non-user actors pass through.
    actor: actor === 'user' && usedSuggestion ? 'ai_suggested_user_confirmed' : actor,
    action: 'transaction.confirmed',
    entityType: 'transaction',
    entityId: id,
    detail: { categoryId },
  });
  return toApiTransaction(row);
}

// ── receipt scan (mock fixture parse — pre-fills the form, never saves) ──────

export async function scanReceipt(
  accountId: string,
  _image: Buffer,
): Promise<ReceiptScanResponse> {
  const repairs = await prisma.category.findFirst({ where: { name: 'Repairs', isSystem: true } });
  const firstProperty = await prisma.property.findFirst({
    where: { accountId },
    orderBy: { createdAt: 'asc' },
  });
  return {
    vendor: 'ACE Hardware #2214',
    amountCents: 4327,
    date: iso(new Date()),
    suggestedCategoryId: repairs?.id ?? null,
    suggestedPropertyId: firstProperty?.id ?? null,
    confidence: 0.84,
  };
}

// ── bank import (mock Plaid → pending_review rows) ───────────────────────────

export async function importFromBank(accountId: string): Promise<ImportTransactionsResponse> {
  const pendingReviewCount = await prisma.transaction.count({
    where: { accountId, status: 'pending_review' },
  });
  const incoming = await mockPlaid.fetchNewTransactions(accountId, { pendingReviewCount });
  for (const t of incoming) {
    const suggestion = await suggestCategory(accountId, {
      type: t.type,
      description: t.description,
      vendor: t.vendor,
    });
    const row = await prisma.transaction.create({
      data: {
        accountId,
        date: t.date,
        amountCents: t.amountCents,
        type: t.type,
        description: t.description,
        vendor: t.vendor,
        source: 'bank',
        status: 'pending_review',
        aiSuggestedCategoryId: suggestion?.categoryId ?? null,
        aiConfidence: suggestion?.confidence ?? null,
      },
    });
    await writeAudit(accountId, {
      actor: 'system',
      action: 'transaction.created',
      entityType: 'transaction',
      entityId: row.id,
      detail: { source: 'bank', externalId: t.externalId },
    });
  }
  return { imported: incoming.length };
}
