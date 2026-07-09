import type {
  ConfirmAllReviewResponse,
  ConfirmTransactionInput,
  CreateTransactionInput,
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
import { createPlaidAdapter, isRealPlaidConfigured } from '../integrations/factory';
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
import { getConnectedPlaid, persistPlaidCursor } from './integration.service';
import type { UsageLog } from '../ai/agent-loop';
import { createReceiptExtractor, type ReceiptImageMimetype } from '../ai/receipt';
import { writeAudit, type AuditActor } from './audit.service';
import {
  RENT_MATCH_WINDOW_DAYS,
  findRentMatchCandidates,
  materializeExpectedPayments,
  pickRentMatch,
} from './rent.service';

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
  const last = items[items.length - 1];
  return {
    items: items.map((r) => ({
      ...toApiTransaction(r),
      aiSuggestedCategoryName: r.aiSuggestedCategoryId
        ? (nameById.get(r.aiSuggestedCategoryId) ?? null)
        : null,
      rentMatch: rentMatches.get(r.id) ?? null,
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
    return confirmWithRentLink(accountId, existing, input.rentPaymentId, input.categoryId, actor);
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
  const rentCategory = await prisma.category.findFirst({
    where: { name: 'Rent', type: 'income' },
  });

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
        method: 'bank',
        paidAt: existing.date,
        amountCents: existing.amountCents,
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
      method: 'bank',
      via: 'bank_import',
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

// ── bank import (Plaid → pending_review rows) ────────────────────────────────

/**
 * Server-side import cooldown. Plaid pulls are metered, so real mode defaults
 * to once per hour; mock mode defaults to no cooldown so the offline demo
 * (import → review → import again) stays frictionless. The env var overrides
 * both (minutes; 0 disables).
 */
function importCooldownMs(): number {
  const raw = process.env.HEARTH_IMPORT_COOLDOWN_MINUTES;
  const minutes = raw !== undefined && raw !== '' ? Number(raw) : isRealPlaidConfigured() ? 60 : 0;
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

export async function importFromBank(accountId: string): Promise<ImportTransactionsResponse> {
  const adapter = createPlaidAdapter();

  // Real mode requires an already-connected Plaid item. Mock mode uses a
  // connected row when one exists (so the cursor advances through the mock
  // script) and otherwise stays stateless (no Integration row required).
  const plaidState = await getConnectedPlaid(accountId);
  if (isRealPlaidConfigured() && !plaidState) throw new PlaidNotConnectedError();

  const cooldownMs = importCooldownMs();
  if (cooldownMs > 0 && plaidState?.lastSyncedAt) {
    const nextAllowedAt = plaidState.lastSyncedAt.getTime() + cooldownMs;
    if (Date.now() < nextAllowedAt) throw new ImportRateLimitedError(new Date(nextAllowedAt));
  }

  const accessToken = plaidState?.accessToken ?? 'mock-access-token';
  const cursor = plaidState?.cursor ?? null;
  const { added, modified, removed, nextCursor } = await adapter.syncTransactions(
    accessToken,
    cursor,
  );

  const counts = { imported: 0, skipped: 0, updated: 0, removed: 0 };

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
      detail: { source: 'bank', externalId: t.externalId, reason: 'plaid_modified' },
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
      detail: { source: 'bank', externalId, reason: 'plaid_removed' },
    });
    counts.removed += 1;
  }

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

  return counts;
}
