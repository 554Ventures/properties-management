import type {
  ConfirmAllReviewResponse,
  ConfirmTransactionInput,
  CreateTransactionInput,
  CreateTransactionResponse,
  DismissAllReviewResponse,
  ImportTransactionsResponse,
  ReceiptScanResponse,
  RentMatchSuggestion,
  ReviewQueueFilter,
  ReviewQueueQuery,
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
import { formatUsd } from '@hearth/shared';
import {
  createPlaidAdapter,
  createStripeFcAdapter,
  isRealPlaidConfigured,
  isRealStripeFcConfigured,
} from '../integrations/factory';
import type { PlaidBankTransaction } from '../integrations/types';
import { addDays, currentPeriod, iso, periodOf } from '../lib/dates';
import {
  BadRequestError,
  ImportRateLimitedError,
  NotFoundError,
  PlaidNotConnectedError,
} from '../lib/errors';
import { prisma } from '../lib/prisma';
import { isUniqueConstraintError } from '../lib/prisma-errors';
import {
  getConnectedPlaid,
  getConnectedStripeFc,
  persistPlaidCursor,
  persistStripeFcCursors,
} from './integration.service';
import type { UsageLog } from '../ai/agent-loop';
import { createReceiptExtractor, type ReceiptImageMimetype } from '../ai/receipt';
import { writeAudit, type AuditActor } from './audit.service';
import {
  RENT_MATCH_WINDOW_DAYS,
  findRentMatchCandidates,
  materializeExpectedPayments,
  pickRentMatch,
} from './rent.service';
import { vendorMemoryKey } from './vendor';

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

// Whitelisted sort fields → DB columns (guards against arbitrary orderBy).
const SORT_COLUMNS = {
  date: 'date',
  amountCents: 'amountCents',
  description: 'description',
  status: 'status',
} as const;

export async function list(
  accountId: string,
  query: TransactionListQuery,
): Promise<TransactionListResponse> {
  const limit = query.limit ?? DEFAULT_LIMIT;
  const q = query.q?.trim();
  const where: Prisma.TransactionWhereInput = {
    accountId,
    ...(query.propertyId ? { propertyId: query.propertyId } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(q
      ? {
          OR: [
            { description: { contains: q, mode: 'insensitive' } },
            { vendor: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {}),
    ...(query.from || query.to
      ? {
          date: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lt: new Date(query.to) } : {}),
          },
        }
      : {}),
  };

  // Sort by the requested column (tie-broken by id for a stable page order),
  // defaulting to newest-first.
  const orderBy: Prisma.TransactionOrderByWithRelationInput[] = query.sort
    ? [{ [SORT_COLUMNS[query.sort]]: query.dir ?? 'asc' }, { id: 'desc' }]
    : [{ date: 'desc' }, { id: 'desc' }];

  // `offset` selects numbered-page mode; otherwise fall back to cursor mode.
  const useOffset = query.offset != null;
  const rowsPromise = useOffset
    ? prisma.transaction.findMany({ where, orderBy, skip: query.offset, take: limit })
    : prisma.transaction.findMany({
        where,
        orderBy,
        take: limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      });
  const [rows, total] = await Promise.all([rowsPromise, prisma.transaction.count({ where })]);

  if (useOffset) {
    return { items: rows.map(toApiTransaction), nextCursor: null, total };
  }
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items: items.map(toApiTransaction),
    nextCursor: hasMore && last ? last.id : null,
    total,
  };
}

// ── AI category suggestion ───────────────────────────────────────────────────
// Per-account vendor memory first (corrections stick — plan §A), then the
// mock keyword table (no AI call in this path).

const KEYWORD_RULES: Array<{ pattern: RegExp; categoryName: string; confidence: number }> = [
  { pattern: /plumb|roof|repair/i, categoryName: 'Repairs', confidence: 0.84 },
  { pattern: /electric|water|gas/i, categoryName: 'Utilities', confidence: 0.84 },
  { pattern: /insur/i, categoryName: 'Insurance', confidence: 0.84 },
];
const FALLBACK = { categoryName: 'Supplies', confidence: 0.62 };
const INCOME_FALLBACK = { categoryName: 'Rent', confidence: 0.8 };

export type SuggestionSource = 'learned' | 'keyword' | 'fallback';

export async function suggestCategory(
  accountId: string,
  partialTxn: { type: TransactionType; description?: string; vendor?: string | null },
): Promise<{ categoryId: string; confidence: number; source: SuggestionSource } | null> {
  const memoryKey = partialTxn.vendor ? vendorMemoryKey(partialTxn.vendor) : '';
  if (memoryKey) {
    const memory = await prisma.vendorCategoryMemory.findUnique({
      where: {
        accountId_vendorKey_type: { accountId, vendorKey: memoryKey, type: partialTxn.type },
      },
    });
    if (memory) {
      return { categoryId: memory.categoryId, confidence: memory.confidence, source: 'learned' };
    }
  }
  const text = `${partialTxn.description ?? ''} ${partialTxn.vendor ?? ''}`;
  let pick: { categoryName: string; confidence: number };
  let source: SuggestionSource;
  if (partialTxn.type === 'income') {
    pick = INCOME_FALLBACK;
    source = 'fallback';
  } else {
    const rule = KEYWORD_RULES.find((r) => r.pattern.test(text));
    pick = rule ?? FALLBACK;
    source = rule ? 'keyword' : 'fallback';
  }
  const category = await prisma.category.findFirst({
    where: {
      name: pick.categoryName,
      type: partialTxn.type,
      OR: [{ isSystem: true }, { accountId }],
    },
  });
  if (!category) return null;
  return { categoryId: category.id, confidence: pick.confidence, source };
}

// Reinforcement ceiling/steps: a learned pick starts at 0.95 and creeps toward
// (never reaches) certainty as the user keeps agreeing with it.
const MEMORY_BASE_CONFIDENCE = 0.95;
const MEMORY_MAX_CONFIDENCE = 0.99;
const MEMORY_REINFORCE_STEP = 0.01;

/**
 * Best-effort vendor→category learning (plan §A5). `correct` upserts the
 * mapping (a correction to a different category resets the row); `reinforce`
 * only bumps an existing row that already backs `categoryId` — accepting a
 * keyword-table suggestion must not mint a memory, or the 0.62 "Supplies"
 * fallback would lock itself in.
 */
async function recordVendorCategoryChoice(
  accountId: string,
  vendor: string | null,
  type: string,
  categoryId: string | null,
  mode: 'correct' | 'reinforce',
): Promise<void> {
  const key = vendor ? vendorMemoryKey(vendor) : '';
  if (!key || !categoryId) return;
  const where = { accountId_vendorKey_type: { accountId, vendorKey: key, type } };
  const existing = await prisma.vendorCategoryMemory.findUnique({ where });
  if (existing) {
    const agrees = existing.categoryId === categoryId;
    if (!agrees && mode === 'reinforce') return;
    await prisma.vendorCategoryMemory.update({
      where,
      data: agrees
        ? {
            hitCount: { increment: 1 },
            confidence: Math.min(MEMORY_MAX_CONFIDENCE, existing.confidence + MEMORY_REINFORCE_STEP),
          }
        : { categoryId, hitCount: 1, confidence: MEMORY_BASE_CONFIDENCE },
    });
    return;
  }
  if (mode === 'reinforce') return;
  try {
    await prisma.vendorCategoryMemory.create({
      data: { accountId, vendorKey: key, type, categoryId },
    });
  } catch (err) {
    // Lost the check-then-create race — the concurrent writer's row stands.
    if (!isUniqueConstraintError(err)) throw err;
  }
}

// ── create / update / remove ─────────────────────────────────────────────────

/**
 * Attribution integrity: propertyId/unitId must belong to the caller's
 * account, and the unit must sit under the attributed property. Nothing else
 * enforces this — RLS is PostgREST-only (the API role bypasses it), so an
 * unchecked id would leak a foreign property's label into reports and count
 * in KPIs while silently vanishing from per-property rollups.
 */
async function assertAttributionOwned(
  accountId: string,
  propertyId: string | null | undefined,
  unitId: string | null | undefined,
): Promise<void> {
  if (propertyId) {
    const property = await prisma.property.findFirst({
      where: { id: propertyId, accountId },
      select: { id: true },
    });
    if (!property) throw new NotFoundError('property', propertyId);
  }
  if (unitId) {
    const unit = await prisma.unit.findFirst({
      where: { id: unitId, property: { accountId } },
      select: { propertyId: true },
    });
    if (!unit) throw new NotFoundError('unit', unitId);
    if (propertyId && unit.propertyId !== propertyId) {
      throw new BadRequestError('unit does not belong to the attributed property');
    }
  }
}

export async function create(
  accountId: string,
  input: CreateTransactionInput,
  opts: { source?: TransactionSource; status?: TransactionStatus; actor?: AuditActor } = {},
): Promise<CreateTransactionResponse> {
  await assertAttributionOwned(accountId, input.propertyId, input.unitId);
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
  // Manually logged rent otherwise never reaches the tracker (rent matching
  // only ran on the pending_review queue): the unit stays "due" and a later
  // mark-paid would create a second, double-counted ledger row. Surface the
  // same heuristic match so the caller can offer an explicit link.
  const rentMatch =
    row.type === 'income' && row.status === 'confirmed'
      ? ((await computeRentMatches(accountId, [row])).get(row.id) ?? null)
      : null;
  return { ...toApiTransaction(row), rentMatch };
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
  // Validate the row's final attribution: a patch may change either field
  // alone, so check the effective pair, not just what was sent.
  if (input.propertyId !== undefined || input.unitId !== undefined) {
    await assertAttributionOwned(
      accountId,
      input.propertyId !== undefined ? input.propertyId : prior.propertyId,
      input.unitId !== undefined ? input.unitId : prior.unitId,
    );
  }
  // Same desync remove() blocks below: this ledger row may back a `paid`
  // RentPayment, whose amountCents/paidAt would silently stop matching (and a
  // type flip would erase the rent from reports while the tracker shows paid).
  // Category/property/unit edits don't touch the link and stay allowed.
  const changesLinkedFields =
    (input.amountCents !== undefined && input.amountCents !== prior.amountCents) ||
    (input.date !== undefined && new Date(input.date).getTime() !== prior.date.getTime()) ||
    (input.type !== undefined && input.type !== prior.type);
  if (changesLinkedFields) {
    const linkedPayment = await prisma.rentPayment.findUnique({ where: { transactionId: id } });
    if (linkedPayment) {
      throw new BadRequestError(
        `this transaction backs the recorded rent payment for ${linkedPayment.period} — its amount, date, and type can't be changed`,
      );
    }
  }
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
  // Second learning signal (plan §A5): recategorizing an already-saved row is
  // a correction too. Uses the row's effective vendor (the patch may have
  // changed it in the same call).
  if (input.categoryId !== undefined && input.categoryId !== prior.categoryId) {
    await recordVendorCategoryChoice(accountId, row.vendor, row.type, input.categoryId, 'correct');
  }
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
  // A rent-linked ledger row backs a `paid` RentPayment; deleting it would
  // SetNull the link and leave the tracker showing paid rent with no ledger
  // entry (the desync noted in schema.prisma) — block instead.
  const linkedPayment = await prisma.rentPayment.findUnique({ where: { transactionId: id } });
  if (linkedPayment) {
    throw new BadRequestError(
      `this transaction backs the recorded rent payment for ${linkedPayment.period} and cannot be deleted`,
    );
  }
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

const DEFAULT_REVIEW_LIMIT = 20;

function reviewWhere(accountId: string, filter: ReviewQueueFilter): Prisma.TransactionWhereInput {
  return {
    accountId,
    status: 'pending_review',
    ...(filter.propertyId ? { propertyId: filter.propertyId } : {}),
    ...(filter.type ? { type: filter.type } : {}),
    ...(filter.source ? { source: filter.source } : {}),
    ...(filter.q
      ? {
          OR: [
            { description: { contains: filter.q, mode: 'insensitive' } },
            { vendor: { contains: filter.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}

export async function getReviewQueue(
  accountId: string,
  query: ReviewQueueQuery = {},
): Promise<ReviewQueueResponse> {
  const limit = query.limit ?? DEFAULT_REVIEW_LIMIT;
  const where = reviewWhere(accountId, query);
  const [rows, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    }),
    prisma.transaction.count({ where }),
  ]);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const categories = await prisma.category.findMany();
  const nameById = new Map(categories.map((c) => [c.id, c.name]));
  // Rent matches are computed for the returned page only — the bulk paths
  // recompute over their own row set.
  const rentMatches = await computeRentMatches(accountId, items);
  // 'learned' is derived fresh at read time (not stored at import): a memory
  // row written after the import still labels the suggestion, and a memory
  // that has since moved to a different category stops claiming it.
  const memoryKeys = [
    ...new Set(
      items.filter((r) => r.vendor && r.aiSuggestedCategoryId).map((r) => vendorMemoryKey(r.vendor as string)),
    ),
  ].filter(Boolean);
  const memories = memoryKeys.length
    ? await prisma.vendorCategoryMemory.findMany({
        where: { accountId, vendorKey: { in: memoryKeys } },
      })
    : [];
  const memoryCategory = new Map(memories.map((m) => [`${m.vendorKey}|${m.type}`, m.categoryId]));
  const isLearned = (r: DbTransaction): boolean =>
    !!r.vendor &&
    !!r.aiSuggestedCategoryId &&
    memoryCategory.get(`${vendorMemoryKey(r.vendor)}|${r.type}`) === r.aiSuggestedCategoryId;
  const last = items[items.length - 1];
  return {
    items: items.map((r) => ({
      ...toApiTransaction(r),
      aiSuggestedCategoryName: r.aiSuggestedCategoryId
        ? (nameById.get(r.aiSuggestedCategoryId) ?? null)
        : null,
      rentMatch: rentMatches.get(r.id) ?? null,
      ...(isLearned(r) ? { suggestionSource: 'learned' as const } : {}),
    })),
    nextCursor: hasMore && last ? last.id : null,
    total,
  };
}

// Heuristic confidence shown on the rent-match chip; a single exact-amount,
// in-window candidate is a strong but not certain signal.
const RENT_MATCH_CONFIDENCE = 0.9;

/**
 * Computed fresh on every queue load (never stored) so a payment recorded by
 * other means between import and review simply stops being suggested; the
 * confirm path re-validates inside a transaction regardless.
 */
async function computeRentMatches(
  accountId: string,
  rows: DbTransaction[],
): Promise<Map<string, RentMatchSuggestion>> {
  const matches = new Map<string, RentMatchSuggestion>();
  const incomeRows = rows.filter((r) => r.type === 'income');
  if (incomeRows.length === 0) return matches;

  // Expected RentPayment rows only exist once their period is materialized;
  // cover every period a deposit's ±window can reach, but never a future month
  // (early payments for a not-yet-current period are an accepted miss).
  const current = currentPeriod();
  const periods = new Set<string>();
  for (const r of incomeRows) {
    for (const offset of [-RENT_MATCH_WINDOW_DAYS, 0, RENT_MATCH_WINDOW_DAYS]) {
      const period = periodOf(addDays(r.date, offset));
      if (period <= current) periods.add(period);
    }
  }
  for (const period of periods) await materializeExpectedPayments(accountId, period);

  const times = incomeRows.map((r) => r.date.getTime());
  const candidates = await findRentMatchCandidates(accountId, {
    from: addDays(new Date(Math.min(...times)), -RENT_MATCH_WINDOW_DAYS),
    to: addDays(new Date(Math.max(...times)), RENT_MATCH_WINDOW_DAYS),
  });
  for (const r of incomeRows) {
    const match = pickRentMatch({ amountCents: r.amountCents, date: r.date }, candidates);
    if (!match) continue;
    matches.set(r.id, {
      rentPaymentId: match.rentPaymentId,
      leaseId: match.leaseId,
      tenantName: match.tenantName,
      propertyId: match.propertyId,
      propertyLabel: match.propertyLabel,
      unitId: match.unitId,
      unitLabel: match.unitLabel,
      period: match.period,
      dueDate: iso(match.dueDate),
      amountCents: match.amountCents,
      confidence: RENT_MATCH_CONFIDENCE,
    });
  }
  return matches;
}

export async function confirm(
  accountId: string,
  id: string,
  input: ConfirmTransactionInput = {},
  actor: AuditActor = 'user',
): Promise<Transaction> {
  const existing = await getOwned(accountId, id);
  if (input.rentPaymentId) {
    // Attribution comes from the lease itself on this path.
    return confirmWithRentLink(accountId, existing, input.rentPaymentId, input.categoryId, actor);
  }
  if (input.propertyId !== undefined || input.unitId !== undefined) {
    await assertAttributionOwned(
      accountId,
      input.propertyId !== undefined ? input.propertyId : existing.propertyId,
      input.unitId !== undefined ? input.unitId : existing.unitId,
    );
  }
  const usedSuggestion = !input.categoryId && !!existing.aiSuggestedCategoryId;
  const categoryId = input.categoryId ?? existing.aiSuggestedCategoryId ?? existing.categoryId;
  const row = await prisma.transaction.update({
    where: { id },
    data: {
      status: 'confirmed',
      categoryId,
      ...(input.propertyId !== undefined ? { propertyId: input.propertyId } : {}),
      ...(input.unitId !== undefined ? { unitId: input.unitId } : {}),
    },
  });
  // Learning signal (plan §A5): an explicit category that disagrees with the
  // suggestion is a correction; agreeing (explicitly or by accepting the
  // suggestion) reinforces an existing memory only.
  if (input.categoryId) {
    await recordVendorCategoryChoice(
      accountId,
      existing.vendor,
      existing.type,
      input.categoryId,
      input.categoryId === existing.aiSuggestedCategoryId ? 'reinforce' : 'correct',
    );
  } else if (usedSuggestion) {
    await recordVendorCategoryChoice(
      accountId,
      existing.vendor,
      existing.type,
      existing.aiSuggestedCategoryId,
      'reinforce',
    );
  }
  await writeAudit(accountId, {
    // A human confirm that accepts the AI suggestion is the one case that
    // upgrades to 'ai_suggested_user_confirmed'; non-user actors pass through.
    actor: actor === 'user' && usedSuggestion ? 'ai_suggested_user_confirmed' : actor,
    action: 'transaction.confirmed',
    entityType: 'transaction',
    entityId: id,
    detail: { categoryId, propertyId: row.propertyId, unitId: row.unitId },
  });
  return toApiTransaction(row);
}

/**
 * Confirm an imported income transaction as the ledger entry backing an
 * expected rent payment: the transaction gets the lease's property/unit and
 * the Rent category, and the RentPayment flips to paid with the link set —
 * the same `RentPayment.transactionId` link recordPayment creates, just
 * pointing at the bank row instead of a new manual one.
 */
async function confirmWithRentLink(
  accountId: string,
  existing: DbTransaction,
  rentPaymentId: string,
  categoryIdOverride: string | undefined,
  actor: AuditActor,
): Promise<Transaction> {
  if (existing.type !== 'income') {
    throw new BadRequestError('only an income transaction can be linked to a rent payment');
  }
  const payment = await prisma.rentPayment.findFirst({
    where: { id: rentPaymentId, lease: { unit: { property: { accountId } } } },
    include: { lease: { include: { unit: true } } },
  });
  if (!payment) throw new NotFoundError('rent payment', rentPaymentId);
  // The heuristic only ever suggests exact-amount matches, but the endpoint
  // accepts any rentPaymentId — a mismatched link would mark a partial (or
  // unrelated) deposit as rent paid in full. Mirrors recordPayment's guard.
  if (existing.amountCents !== payment.amountCents) {
    throw new BadRequestError(
      `transaction of ${formatUsd(existing.amountCents)} doesn't match the ${formatUsd(payment.amountCents)} due for ${payment.period} — only an exact-amount transaction can be linked to a rent payment`,
    );
  }
  // Scoped like suggestCategory: never pick up another account's custom "Rent".
  const rentCategory = await prisma.category.findFirst({
    where: { name: 'Rent', type: 'income', OR: [{ isSystem: true }, { accountId }] },
    orderBy: { isSystem: 'desc' },
  });
  // Bank deposits link with method 'bank'; a manually logged income row that
  // matched an expected rent links as 'manual'.
  const method = existing.source === 'bank' ? 'bank' : 'manual';

  // Confirm + link commit or roll back together; the status re-check inside
  // the transaction makes the double-pay guard hold under concurrent requests
  // (mirrors recordPayment).
  const { row, updatedPayment } = await prisma.$transaction(async (tx) => {
    const fresh = await tx.rentPayment.findUniqueOrThrow({ where: { id: payment.id } });
    if (fresh.status === 'paid') {
      throw new BadRequestError(`rent for ${payment.period} is already recorded as paid`);
    }
    const confirmedRow = await tx.transaction.update({
      where: { id: existing.id },
      data: {
        status: 'confirmed',
        categoryId: categoryIdOverride ?? rentCategory?.id ?? existing.categoryId,
        propertyId: payment.lease.unit.propertyId,
        unitId: payment.lease.unitId,
      },
    });
    const linkedPayment = await tx.rentPayment.update({
      where: { id: payment.id },
      data: {
        status: 'paid',
        method,
        paidAt: existing.date,
        transactionId: existing.id,
      },
    });
    return { row: confirmedRow, updatedPayment: linkedPayment };
  });

  // Accepting the rent-match suggestion is accepting AI-suggested content.
  const auditActor = actor === 'user' ? 'ai_suggested_user_confirmed' : actor;
  await writeAudit(accountId, {
    actor: auditActor,
    action: 'transaction.confirmed',
    entityType: 'transaction',
    entityId: row.id,
    detail: { categoryId: row.categoryId, rentPaymentId: updatedPayment.id },
  });
  await writeAudit(accountId, {
    actor: auditActor,
    action: 'rent_payment.recorded',
    entityType: 'rent_payment',
    entityId: updatedPayment.id,
    detail: {
      period: updatedPayment.period,
      amountCents: updatedPayment.amountCents,
      method,
      via: existing.source === 'bank' ? 'bank_import' : 'transaction_link',
    },
  });
  return toApiTransaction(row);
}

// ── dismiss / bulk review actions ────────────────────────────────────────────

/**
 * Deny a pending-review item: keep the row (so bank-import dedup by externalId
 * still holds and the audit trail stays intact) but mark it `dismissed`, which
 * excludes it from reports/dashboards the same way `pending_review` is.
 */
export async function dismiss(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<Transaction> {
  const existing = await getOwned(accountId, id);
  if (existing.status !== 'pending_review') {
    throw new BadRequestError('only a pending-review transaction can be dismissed');
  }
  const row = await prisma.transaction.update({ where: { id }, data: { status: 'dismissed' } });
  await writeAudit(accountId, {
    actor,
    action: 'transaction.dismissed',
    entityType: 'transaction',
    entityId: id,
    detail: { amountCents: row.amountCents, type: row.type, source: row.source },
  });
  return toApiTransaction(row);
}

/**
 * Confirm every filtered pending item with its AI-suggested category. Items
 * with no suggestion are skipped (they'd land in reports uncategorized), and
 * items with a rent match are skipped too — linking a deposit to a rent
 * payment is an explicit per-item action, never applied in bulk.
 */
export async function confirmAllInReview(
  accountId: string,
  filter: ReviewQueueFilter = {},
  actor: AuditActor = 'user',
): Promise<ConfirmAllReviewResponse> {
  const rows = await prisma.transaction.findMany({
    where: reviewWhere(accountId, filter),
    orderBy: [{ date: 'desc' }, { id: 'desc' }],
  });
  const rentMatches = await computeRentMatches(accountId, rows);
  let confirmed = 0;
  let skipped = 0;
  for (const r of rows) {
    if (!r.aiSuggestedCategoryId || rentMatches.has(r.id)) {
      skipped += 1;
      continue;
    }
    await confirm(accountId, r.id, {}, actor);
    confirmed += 1;
  }
  return { confirmed, skipped };
}

export async function dismissAllInReview(
  accountId: string,
  filter: ReviewQueueFilter = {},
  actor: AuditActor = 'user',
): Promise<DismissAllReviewResponse> {
  const rows = await prisma.transaction.findMany({
    where: reviewWhere(accountId, filter),
    select: { id: true },
  });
  for (const r of rows) await dismiss(accountId, r.id, actor);
  return { dismissed: rows.length };
}

// ── receipt scan (pre-fills the form, never saves) ───────────────────────────
// Real Anthropic vision extraction when ANTHROPIC_API_KEY is set; the
// deterministic mock fixture otherwise. The extractor returns candidate
// *names*; ids are resolved here against the account's own rows so the model
// can never point at another account's data.

/** Case-insensitive exact match of an extracted name against candidate rows. */
export function resolveByName<T extends { id: string }>(
  name: string | null,
  candidates: Array<T & { name: string }>,
): string | null {
  if (!name) return null;
  const lower = name.trim().toLowerCase();
  return candidates.find((c) => c.name.toLowerCase() === lower)?.id ?? null;
}

export function resolveByLabel<T extends { id: string }>(
  label: string | null,
  candidates: Array<T & { label: string }>,
): string | null {
  if (!label) return null;
  const lower = label.trim().toLowerCase();
  return candidates.find((c) => c.label.toLowerCase() === lower)?.id ?? null;
}

export async function scanReceipt(
  accountId: string,
  image: Buffer,
  mimetype: ReceiptImageMimetype,
  log?: UsageLog,
): Promise<ReceiptScanResponse> {
  const categories = await prisma.category.findMany({
    where: { type: 'expense', OR: [{ isSystem: true }, { accountId }] },
    select: { id: true, name: true },
  });
  const properties = await prisma.property.findMany({
    where: { accountId, archivedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, nickname: true, addressLine1: true },
  });
  const propertyCandidates = properties.map((p) => ({
    id: p.id,
    label: p.nickname ?? p.addressLine1,
  }));

  const extractor = createReceiptExtractor();
  const extraction = await extractor.extract({
    accountId,
    image,
    mimetype,
    categories: categories.map((c) => ({ name: c.name })),
    properties: propertyCandidates.map((p) => ({ label: p.label })),
    log,
  });

  return {
    vendor: extraction.vendor,
    amountCents: extraction.amountCents,
    date: extraction.date,
    suggestedCategoryId: resolveByName(extraction.categoryName, categories),
    suggestedPropertyId: resolveByLabel(extraction.propertyLabel, propertyCandidates),
    confidence: extraction.confidence,
  };
}

// ── bank import (Plaid / Stripe FC → pending_review rows) ────────────────────

/**
 * Server-side import cooldown. Bank pulls are metered (Plaid per-sync,
 * Stripe FC per-refresh), so real mode defaults to once per hour; mock mode
 * defaults to no cooldown so the offline demo (import → review → import
 * again) stays frictionless. The env var overrides both (minutes; 0 disables).
 */
function importCooldownMs(): number {
  const raw = process.env.HEARTH_IMPORT_COOLDOWN_MINUTES;
  const realMode = isRealPlaidConfigured() || isRealStripeFcConfigured();
  const minutes = raw !== undefined && raw !== '' ? Number(raw) : realMode ? 60 : 0;
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
}

/** Insert one synced bank transaction unless its externalId is already present. */
async function createBankTransaction(
  accountId: string,
  t: PlaidBankTransaction,
): Promise<'imported' | 'skipped'> {
  // Dedup guard: Plaid's sync can redeliver the same transaction_id on
  // retries; the mock replays fixed ids across cursorless imports too. The
  // pre-check keeps us from burning a suggestCategory pass on known rows.
  const existing = await prisma.transaction.findFirst({
    where: { accountId, externalId: t.externalId },
  });
  if (existing) return 'skipped';

  const suggestion = await suggestCategory(accountId, {
    type: t.type,
    description: t.description,
    vendor: t.vendor,
  });
  let row: DbTransaction;
  try {
    row = await prisma.transaction.create({
      data: {
        accountId,
        date: t.date,
        amountCents: t.amountCents,
        type: t.type,
        description: t.description,
        vendor: t.vendor,
        externalId: t.externalId,
        source: 'bank',
        status: 'pending_review',
        aiSuggestedCategoryId: suggestion?.categoryId ?? null,
        aiConfidence: suggestion?.confidence ?? null,
      },
    });
  } catch (err) {
    // A concurrent import won the @@unique([accountId, externalId]) race.
    if (isUniqueConstraintError(err)) return 'skipped';
    throw err;
  }
  await writeAudit(accountId, {
    actor: 'system',
    action: 'transaction.created',
    entityType: 'transaction',
    entityId: row.id,
    detail: { source: 'bank', externalId: t.externalId },
  });
  return 'imported';
}

interface BankSyncBatch {
  added: PlaidBankTransaction[];
  modified: PlaidBankTransaction[];
  removed: string[];
}

/**
 * Apply one provider's added/modified/removed batch to the ledger.
 * `provider` only flavors the audit-trail reason strings
 * (`plaid_modified`, `stripe_fc_removed`, …).
 */
async function applySyncBatch(
  accountId: string,
  provider: 'plaid' | 'stripe_fc',
  { added, modified, removed }: BankSyncBatch,
  counts: ImportTransactionsResponse,
): Promise<void> {
  for (const t of added) {
    counts[await createBankTransaction(accountId, t)] += 1;
  }

  for (const t of modified) {
    const existing = await prisma.transaction.findFirst({
      where: { accountId, externalId: t.externalId },
    });
    if (!existing) {
      // Plaid delivers `modified` as full replacements, so an id we've never
      // stored imports as new.
      counts[await createBankTransaction(accountId, t)] += 1;
      continue;
    }
    // Only machine-owned rows are machine-mutable: once the user confirms (or
    // dismisses) a transaction it's their vouched ledger — a bank-side tweak
    // must not silently rewrite it.
    if (existing.status !== 'pending_review') continue;
    const suggestion = await suggestCategory(accountId, {
      type: t.type,
      description: t.description,
      vendor: t.vendor,
    });
    await prisma.transaction.update({
      where: { id: existing.id },
      data: {
        date: t.date,
        amountCents: t.amountCents,
        type: t.type,
        description: t.description,
        vendor: t.vendor,
        aiSuggestedCategoryId: suggestion?.categoryId ?? null,
        aiConfidence: suggestion?.confidence ?? null,
      },
    });
    await writeAudit(accountId, {
      actor: 'system',
      action: 'transaction.updated',
      entityType: 'transaction',
      entityId: existing.id,
      detail: { source: 'bank', externalId: t.externalId, reason: `${provider}_modified` },
    });
    counts.updated += 1;
  }

  for (const externalId of removed) {
    const existing = await prisma.transaction.findFirst({ where: { accountId, externalId } });
    // Same ownership rule as `modified`: only still-pending rows are deleted.
    if (!existing || existing.status !== 'pending_review') continue;
    await prisma.transaction.delete({ where: { id: existing.id } });
    await writeAudit(accountId, {
      actor: 'system',
      action: 'transaction.deleted',
      entityType: 'transaction',
      entityId: existing.id,
      detail: { source: 'bank', externalId, reason: `${provider}_removed` },
    });
    counts.removed += 1;
  }
}

async function syncPlaidFeed(
  accountId: string,
  plaidState: Awaited<ReturnType<typeof getConnectedPlaid>>,
  counts: ImportTransactionsResponse,
): Promise<void> {
  const adapter = createPlaidAdapter();
  const accessToken = plaidState?.accessToken ?? 'mock-access-token';
  const cursor = plaidState?.cursor ?? null;
  const { added, modified, removed, nextCursor } = await adapter.syncTransactions(
    accessToken,
    cursor,
  );

  await applySyncBatch(accountId, 'plaid', { added, modified, removed }, counts);

  if (plaidState) {
    await persistPlaidCursor(
      plaidState.integrationId,
      plaidState.itemId,
      plaidState.accessTokenEncrypted,
      nextCursor,
    );
  }
  // "Last imported" display + cooldown anchor. Sync metadata, not a money
  // write, so it isn't audited. updateMany no-ops for accounts with no row.
  await prisma.integration.updateMany({
    where: { accountId, type: 'plaid' },
    data: { lastSyncedAt: new Date() },
  });
}

async function syncStripeFcFeed(
  accountId: string,
  state: NonNullable<Awaited<ReturnType<typeof getConnectedStripeFc>>>,
  counts: ImportTransactionsResponse,
): Promise<void> {
  const adapter = createStripeFcAdapter();
  const fcAccountIds = state.config.accounts.map((a) => a.id);
  const { added, modified, removed, nextCursors } = await adapter.syncTransactions(
    fcAccountIds,
    state.config.cursors ?? {},
  );

  await applySyncBatch(accountId, 'stripe_fc', { added, modified, removed }, counts);

  await persistStripeFcCursors(state.integrationId, state.config, nextCursors);
  await prisma.integration.updateMany({
    where: { accountId, type: 'stripe_fc' },
    data: { lastSyncedAt: new Date() },
  });
}

export async function importFromBank(accountId: string): Promise<ImportTransactionsResponse> {
  const realPlaid = isRealPlaidConfigured();
  const realStripeFc = isRealStripeFcConfigured();
  const anyReal = realPlaid || realStripeFc;

  const plaidState = await getConnectedPlaid(accountId);
  const fcState = await getConnectedStripeFc(accountId);

  // Eligibility rules:
  //  - A real-configured provider syncs only when its integration row is
  //    connected.
  //  - Once ANY real provider is configured, unconfigured providers are
  //    skipped entirely — their mock adapters must never leak demo rows into
  //    a ledger that also holds real bank data (e.g. real Stripe keys set,
  //    Plaid left unconfigured).
  //  - With nothing real configured (pure offline demo), mock Plaid keeps its
  //    historical stateless behavior (no Integration row required; a
  //    connected row just persists the mock cursor), while mock Stripe FC
  //    requires a connected row created via its session/complete flow.
  const plaidEligible = realPlaid ? plaidState !== null : !anyReal;
  const fcEligible = (realStripeFc || !anyReal) && fcState !== null;

  if (anyReal && !plaidEligible && !fcEligible) throw new PlaidNotConnectedError();

  const cooldownMs = importCooldownMs();
  const counts: ImportTransactionsResponse = { imported: 0, skipped: 0, updated: 0, removed: 0 };

  const feeds: { eligible: boolean; lastSyncedAt: Date | null; run: () => Promise<void> }[] = [
    {
      eligible: plaidEligible,
      lastSyncedAt: plaidState?.lastSyncedAt ?? null,
      run: () => syncPlaidFeed(accountId, plaidState, counts),
    },
    {
      eligible: fcEligible,
      lastSyncedAt: fcState?.lastSyncedAt ?? null,
      run: () => syncStripeFcFeed(accountId, fcState!, counts),
    },
  ];

  const eligible = feeds.filter((f) => f.eligible);
  const nextAllowedAt = (f: (typeof feeds)[number]) =>
    f.lastSyncedAt ? f.lastSyncedAt.getTime() + cooldownMs : 0;
  // A feed inside its cooldown window is skipped silently as long as another
  // one can still sync; only when every eligible feed is cooling down does the
  // import surface a rate-limit error (with the soonest retry time).
  const due =
    cooldownMs > 0 ? eligible.filter((f) => Date.now() >= nextAllowedAt(f)) : eligible;
  if (eligible.length > 0 && due.length === 0) {
    throw new ImportRateLimitedError(new Date(Math.min(...eligible.map(nextAllowedAt))));
  }

  for (const feed of due) await feed.run();

  return counts;
}
