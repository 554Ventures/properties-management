import type {
  BankDiscrepancyKind,
  BankDiscrepancyListResponse,
  BankDiscrepancyResolution,
  BankDiscrepancyRow,
  BankDiscrepancyStatus,
  BankSyncProvider,
  ConfirmAllReviewResponse,
  ConfirmTransactionInput,
  CreateTransactionInput,
  CreateTransactionResponse,
  DismissAllReviewResponse,
  DuplicateSuggestion,
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
import type {
  Prisma,
  Transaction as DbTransaction,
  TransactionSplit as DbTransactionSplit,
} from '@prisma/client';
import { BankDiscrepancyDataSchema, formatUsd } from '@hearth/shared';
import {
  createPlaidAdapter,
  createStripeFcAdapter,
  isRealPlaidConfigured,
  isRealStripeFcConfigured,
} from '../integrations/factory';
import type { PlaidBankTransaction } from '../integrations/types';
import { addDays, calendarDaysBetween, currentPeriod, iso, isoOrNull, periodOf } from '../lib/dates';
import {
  BadRequestError,
  ImportRateLimitedError,
  NotFoundError,
  PlaidNotConnectedError,
} from '../lib/errors';
import { prisma } from '../lib/prisma';
import { isUniqueConstraintError } from '../lib/prisma-errors';
import { NON_RENTAL_INCOME_CATEGORY, NON_RENTAL_INCOME_RULES } from '../lib/schedule-e';
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
import { matchContractorId, vendorKey, vendorMemoryKey } from './vendor';

/** Every producer of an API transaction reads the split lines with it, so
 *  `splits` is never guessed at (empty array = an unsplit row). */
type DbTransactionWithSplits = DbTransaction & { splits: DbTransactionSplit[] };

/** Fetch the split lines alongside the row (Prisma include, reused verbatim). */
const withSplits = { splits: true } as const;

export function toApiTransaction(t: DbTransactionWithSplits): Transaction {
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
    classification: t.classification as Transaction['classification'],
    aiSuggestedCategoryId: t.aiSuggestedCategoryId,
    aiConfidence: t.aiConfidence,
    receiptUrl: t.receiptUrl,
    mortgageId: t.mortgageId,
    principalCents: t.principalCents,
    // Provenance for a scheduler-drafted row. The review queue reads this to
    // badge it "Auto-drafted" and to word the duplicate warning correctly, so
    // it has to survive the mapping — the field is optional in the schema, so
    // omitting it parses fine and simply makes the badge never appear.
    recurringTemplateId: t.recurringTemplateId,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
    splits: t.splits.map((s) => ({
      id: s.id,
      categoryId: s.categoryId,
      amountCents: s.amountCents,
    })),
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
    // Portfolio-level (unassigned) rows only — wins over propertyId if both are
    // passed (contradictory filters yield no rows, as expected).
    ...(query.unassigned ? { propertyId: null } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.status ? { status: query.status } : {}),
    // A category filter must also find rows that reach that category through a
    // split line. Nested under AND so it can't collide with the `q` OR below.
    ...(query.categoryId
      ? {
          AND: [
            {
              OR: [
                { categoryId: query.categoryId },
                { splits: { some: { categoryId: query.categoryId } } },
              ],
            },
          ],
        }
      : {}),
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
    ? prisma.transaction.findMany({
        where,
        orderBy,
        skip: query.offset,
        take: limit,
        include: withSplits,
      })
    : prisma.transaction.findMany({
        where,
        orderBy,
        take: limit + 1,
        include: withSplits,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      });
  const [rows, total] = await Promise.all([rowsPromise, prisma.transaction.count({ where })]);

  const hasMore = !useOffset && rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const ids = items.map((r) => r.id);
  const [rentLinkedIds, docCounts] = await Promise.all([
    rentLinkedTransactionIds(ids),
    documentCountsByTransactionId(accountId, ids),
  ]);
  const toItem = (r: DbTransactionWithSplits): Transaction => {
    const documentCount = docCounts.get(r.id) ?? 0;
    return {
      ...toApiTransaction(r),
      ...(rentLinkedIds.has(r.id) ? { rentLinked: true } : {}),
      ...(documentCount > 0 ? { documentCount } : {}),
    };
  };

  if (useOffset) {
    return { items: items.map(toItem), nextCursor: null, total };
  }
  const last = items[items.length - 1];
  return {
    items: items.map(toItem),
    nextCursor: hasMore && last ? last.id : null,
    total,
  };
}

/** Which of these transactions back a rent deposit (or legacy paid link). */
async function rentLinkedTransactionIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const [deposits, legacy] = await Promise.all([
    prisma.rentPaymentDeposit.findMany({
      where: { transactionId: { in: ids } },
      select: { transactionId: true },
    }),
    prisma.rentPayment.findMany({
      where: { transactionId: { in: ids } },
      select: { transactionId: true },
    }),
  ]);
  return new Set([
    ...deposits.map((d) => d.transactionId),
    ...legacy.map((p) => p.transactionId as string),
  ]);
}

/** Attached-document counts for a page of transactions (one groupBy). */
async function documentCountsByTransactionId(
  accountId: string,
  ids: string[],
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const groups = await prisma.document.groupBy({
    by: ['entityId'],
    where: { accountId, entityType: 'transaction', entityId: { in: ids } },
    _count: true,
  });
  return new Map(groups.map((g) => [g.entityId, g._count]));
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
// Deliberately below BULK_CONFIRM_MIN_CONFIDENCE (plan §D1): "every income is
// Rent" is a guess — refunds, transfers, security deposits, laundry income all
// arrive as income. It must never ride a bulk confirm, and at 0.5 the review
// card shows the low-confidence warning too.
const INCOME_FALLBACK = { categoryName: 'Rent', confidence: 0.5 };
// Income keyword rules. Expenses have a vendor to reason about; on income the
// bank descriptor IS the signal. Without these, an IRS refund or an interest
// deposit rides INCOME_FALLBACK onto Schedule E Line 3 as "Rent" — the
// suggester actively proposing a tax error. Patterns and their confidence split
// live in lib/schedule-e.ts, shared with the misfiled_income insight.
const INCOME_KEYWORD_RULES = NON_RENTAL_INCOME_RULES.map((r) => ({
  pattern: r.pattern,
  categoryName: NON_RENTAL_INCOME_CATEGORY,
  confidence: r.confidence,
}));

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
    const rule = INCOME_KEYWORD_RULES.find((r) => r.pattern.test(text));
    pick = rule ?? INCOME_FALLBACK;
    source = rule ? 'keyword' : 'fallback';
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

/**
 * A refund is money coming back — always an income-type row (the amount stays
 * positive; aggregation nets it against expenses). Classifying an expense row
 * as a refund would double-subtract, so reject the combination outright.
 */
function assertClassificationValid(
  classification: string | null | undefined,
  type: string,
): void {
  if (classification === 'refund' && type !== 'income') {
    throw new BadRequestError('a refund is recorded as an income transaction (money coming back)');
  }
}

// ── mortgage-payment breakdown (PLAN-REAL-EQUITY §3) ─────────────────────────
// A mortgage payment is ONE ledger row per bank debit with an integer
// `principalCents` carve-out: the principal repays a liability (it buys
// nothing), so `lib/pnl.ts` subtracts it from the row's contribution and the
// mortgage's derived balance drops by it. Every figure here is the user's —
// decision D4 (2026-08-10) rejected computing the principal/interest split from
// the rate and balance outright, so nothing in this file derives, infers or
// defaults a principal amount.

/**
 * Validate a row's FINAL breakdown state (§3). Enforced in the service rather
 * than the route schema on purpose: chat and MCP compose their own input shapes
 * off the shared Create/Update schemas, so a route-only guard is bypassable —
 * and a bogus carve-out silently understates expenses everywhere.
 */
async function assertMortgageBreakdownValid(
  accountId: string,
  final: {
    mortgageId: string | null;
    principalCents: number | null;
    type: string;
    amountCents: number;
    classification: string | null;
  },
): Promise<void> {
  if (final.mortgageId) {
    // A foreign (or invented) id must not attach: it would decrement another
    // account's loan balance and pull this payment into their equity.
    const mortgage = await prisma.mortgage.findFirst({
      where: { id: final.mortgageId, accountId },
      select: { id: true },
    });
    if (!mortgage) throw new NotFoundError('mortgage', final.mortgageId);
  }
  if (final.principalCents == null) return;
  if (!final.mortgageId) {
    throw new BadRequestError(
      'a principal amount needs the mortgageId of the loan it repays — principal is only meaningful against a mortgage',
    );
  }
  if (final.type !== 'expense') {
    throw new BadRequestError('only an expense transaction can carry a mortgage principal portion');
  }
  // A principal-bearing row is neither transfer nor refund: classification is
  // all-or-nothing per row, while a real payment is *partly* deductible.
  if (final.classification) {
    throw new BadRequestError(
      `a mortgage payment with a principal portion can't also be classified as a ${final.classification.replace('_', ' ')}`,
    );
  }
  // Equal is legal: a principal-only payment contributes $0 to P&L and still
  // decrements the mortgage.
  if (final.principalCents < 0 || final.principalCents > final.amountCents) {
    throw new BadRequestError(
      `the principal portion must be between $0 and the payment itself — ${formatUsd(final.principalCents)} principal against a ${formatUsd(final.amountCents)} payment`,
    );
  }
}

/**
 * The mortgage a payment's vendor names: exactly one NON-ARCHIVED mortgage
 * whose lender shares the vendorKey — zero or several match nothing, mirroring
 * `matchContractorId` (ambiguity suppresses rather than guesses).
 *
 * Detection is deliberately inert: it only says "this looks like a mortgage
 * payment" so the UI can *offer* the breakdown editor. It never sets
 * `principalCents`, never touches categorization, and therefore never changes
 * what the row contributes to any money aggregate (per D4 the numbers are
 * always the user's).
 */
async function matchMortgageId(
  accountId: string,
  vendor: string | null | undefined,
): Promise<string | null> {
  if (!vendor) return null;
  const key = vendorKey(vendor);
  const mortgages = await prisma.mortgage.findMany({
    where: { accountId, archivedAt: null },
    select: { id: true, lender: true },
  });
  const matches = mortgages.filter((m) => vendorKey(m.lender) === key);
  return matches.length === 1 ? matches[0]!.id : null;
}

/**
 * The account's seeded "Mortgage Interest" expense category, scoped like
 * `suggestCategory` so another account's custom one can never be picked. Null
 * when the account has none — the caller then leaves the row uncategorized
 * rather than inventing a category behind the user's back.
 */
async function mortgageInterestCategoryId(accountId: string): Promise<string | null> {
  const category = await prisma.category.findFirst({
    where: { name: 'Mortgage Interest', type: 'expense', OR: [{ isSystem: true }, { accountId }] },
    orderBy: { isSystem: 'desc' },
  });
  return category?.id ?? null;
}

export async function create(
  accountId: string,
  input: CreateTransactionInput,
  opts: {
    source?: TransactionSource;
    status?: TransactionStatus;
    actor?: AuditActor;
    // Explicit contractor link (contractor.service logJob) — skips the
    // vendor-name match, which would null out on an ambiguous directory name.
    contractorId?: string;
  } = {},
): Promise<CreateTransactionResponse> {
  await assertAttributionOwned(accountId, input.propertyId, input.unitId);
  assertClassificationValid(input.classification, input.type);
  await assertMortgageBreakdownValid(accountId, {
    mortgageId: input.mortgageId ?? null,
    principalCents: input.principalCents ?? null,
    type: input.type,
    amountCents: input.amountCents,
    classification: input.classification ?? null,
  });
  // An explicit mortgageId (the user's, or a recurring template's) always wins;
  // the vendor match only fills the gap, and only on expense rows.
  const mortgageId =
    input.mortgageId ??
    (input.type === 'expense' ? await matchMortgageId(accountId, input.vendor) : null);
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
      contractorId: opts.contractorId ?? (await matchContractorId(accountId, input.vendor)),
      source: opts.source ?? 'manual',
      status: opts.status ?? 'confirmed',
      classification: input.classification ?? null,
      aiSuggestedCategoryId,
      aiConfidence,
      receiptUrl: input.receiptUrl ?? null,
      mortgageId,
      principalCents: input.principalCents ?? null,
    },
    include: withSplits,
  });
  await writeAudit(accountId, {
    actor: opts.actor ?? 'user',
    action: 'transaction.created',
    entityType: 'transaction',
    entityId: row.id,
    detail: {
      amountCents: row.amountCents,
      type: row.type,
      source: row.source,
      // The carve-out is money the books won't see as an expense — record it.
      // A bare mortgageId (detection) changes no figure, so it stays out.
      ...(row.principalCents != null
        ? { principalCents: row.principalCents, mortgageId: row.mortgageId }
        : {}),
    },
  });
  // Manually logged rent otherwise never reaches the tracker (rent matching
  // only ran on the pending_review queue): the unit stays "due" and a later
  // mark-paid would create a second, double-counted ledger row. Surface the
  // same heuristic match so the caller can offer an explicit link.
  const rentMatch =
    row.type === 'income' && row.status === 'confirmed' && !row.classification
      ? ((await computeRentMatches(accountId, [row])).get(row.id) ?? null)
      : null;
  return { ...toApiTransaction(row), rentMatch };
}

async function getOwned(accountId: string, id: string): Promise<DbTransactionWithSplits> {
  const row = await prisma.transaction.findFirst({
    where: { id, accountId },
    include: withSplits,
  });
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
  // Same desync remove() blocks below: this ledger row may back a rent
  // deposit whose amountCents contributes to a charge's paidCents (and a
  // type flip would erase the rent from reports while the tracker shows paid).
  // Property/unit edits don't touch the link and stay allowed (see the
  // changesLinkedFields comment below).
  assertClassificationValid(
    input.classification !== undefined ? input.classification : prior.classification,
    input.type !== undefined ? input.type : prior.type,
  );
  // Classifying a rent-backing deposit out of P&L would erase rent income
  // from reports while the tracker shows the period paid — same divergence
  // the amount/date/type guard prevents, so it rides the same check.
  // Recategorizing it is the same divergence: the Money↔Rent link is keyed on
  // this row remaining a Rent-categorized deposit, so swapping the category
  // would desync the two surfaces exactly like an amount/date/type edit would.
  // Property/unit are deliberately left out of this guard — reattributing a
  // deposit to the correct property/unit is a legitimate fix (e.g. it landed
  // on the wrong unit) that doesn't touch amount/date/type/category/
  // classification, so it can't create that divergence.
  const changesLinkedFields =
    (input.amountCents !== undefined && input.amountCents !== prior.amountCents) ||
    (input.date !== undefined && new Date(input.date).getTime() !== prior.date.getTime()) ||
    (input.type !== undefined && input.type !== prior.type) ||
    (input.categoryId !== undefined && input.categoryId !== prior.categoryId) ||
    // Splitting a deposit across categories is the same recategorization
    // divergence (clearing splits isn't: a rent-linked row can never have any).
    input.splits != null ||
    (input.classification !== undefined && input.classification !== prior.classification);
  if (changesLinkedFields) {
    const period = await rentLinkPeriod(id);
    if (period) {
      throw new BadRequestError(
        `this transaction backs a recorded rent payment for ${period} — its amount, date, type, category, and classification can't be changed; unlink the deposit on the Rent page first`,
      );
    }
  }
  // A principal carve-out and a rent link are mutually exclusive (§3): rent is
  // a tenant's money coming in, never a debt payment going out. Checked before
  // the expense-only rule so the error names the actual conflict.
  if (input.principalCents != null) {
    const period = await rentLinkPeriod(id);
    if (period) {
      throw new BadRequestError(
        `this transaction backs the recorded rent payment for ${period} — it can't also carry a mortgage principal portion; unlink the deposit on the Rent page first`,
      );
    }
  }
  // The row's FINAL breakdown state: a patch may move the amount alone, which
  // has to revalidate against the principal already stored (an edit down to
  // less than the carve-out would otherwise leave negative expense).
  await assertMortgageBreakdownValid(accountId, {
    mortgageId: (input.mortgageId !== undefined ? input.mortgageId : prior.mortgageId) ?? null,
    principalCents:
      (input.principalCents !== undefined ? input.principalCents : prior.principalCents) ?? null,
    type: input.type !== undefined ? input.type : prior.type,
    amountCents: input.amountCents !== undefined ? input.amountCents : prior.amountCents,
    classification:
      input.classification !== undefined ? input.classification : prior.classification,
  });
  const splitPlan = await planSplits(accountId, prior, input);
  // Editing the vendor re-derives the contractor link (vendor is the signal:
  // moving the row to another contractor's name moves the job; a non-matching
  // vendor unlinks). Untouched vendor → untouched link, so a contractor
  // rename can't orphan history through unrelated edits.
  const relink =
    input.vendor !== undefined
      ? { contractorId: await matchContractorId(accountId, input.vendor) }
      : {};
  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.transaction.update({
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
        ...relink,
        ...(input.receiptUrl !== undefined ? { receiptUrl: input.receiptUrl } : {}),
        ...(input.classification !== undefined ? { classification: input.classification } : {}),
        // Correcting a payment's breakdown after the fact (the ledger's edit
        // modal reopens the same editor the confirm card uses).
        ...(input.mortgageId !== undefined ? { mortgageId: input.mortgageId } : {}),
        ...(input.principalCents !== undefined ? { principalCents: input.principalCents } : {}),
        // Splits ARE the categorization: the parent's single category goes.
        ...(splitPlan.action === 'replace' ? { categoryId: null } : {}),
      },
      include: withSplits,
    });
    if (splitPlan.action === 'none') return updated;
    await tx.transactionSplit.deleteMany({ where: { transactionId: id } });
    if (splitPlan.action === 'replace') {
      await tx.transactionSplit.createMany({
        data: splitPlan.lines.map((s) => ({
          transactionId: id,
          categoryId: s.categoryId,
          amountCents: s.amountCents,
        })),
      });
    }
    return tx.transaction.findUniqueOrThrow({ where: { id }, include: withSplits });
  });
  // Second learning signal (plan §A5): recategorizing an already-saved row is
  // a correction too. Uses the row's effective vendor (the patch may have
  // changed it in the same call). Split lines deliberately teach nothing —
  // vendor memory maps a vendor to ONE category, and a split has no single
  // answer to remember.
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
      // Correcting a payment's principal moves what the books count as expense,
      // so the before/after pair belongs in the trail.
      ...(input.principalCents !== undefined || input.mortgageId !== undefined
        ? {
            priorPrincipalCents: prior.principalCents,
            principalCents: row.principalCents,
            mortgageId: row.mortgageId,
          }
        : {}),
      ...(splitPlan.action === 'none'
        ? {}
        : {
            splits: row.splits.map((s) => ({
              categoryId: s.categoryId,
              amountCents: s.amountCents,
            })),
            priorSplitCount: prior.splits.length,
          }),
    },
  });
  return toApiTransaction(row);
}

/**
 * What this PATCH does to the row's split lines, validated against the row's
 * FINAL state (a patch may move the amount/type in the same call):
 *   `replace` — write these lines and null the parent category
 *   `clear`   — delete the lines (explicit `splits: null`, or a new single
 *               category, which supersedes them)
 *   `none`    — leave them alone
 * Every rejection is a 400: splits are a user-facing editing decision, and a
 * silently-repaired split would put the category breakdown out of step with
 * the row's own amount.
 */
async function planSplits(
  accountId: string,
  prior: DbTransactionWithSplits,
  input: UpdateTransactionInput,
): Promise<
  | { action: 'none' }
  | { action: 'clear' }
  | { action: 'replace'; lines: Array<{ categoryId: string; amountCents: number }> }
> {
  const hasPriorSplits = prior.splits.length > 0;
  // Mutual exclusion holds in BOTH orders: classifying a row that's already
  // split would give it negative (refund) or zero (transfer) P&L totals while
  // its split lines still read as positive expenses. Clearing the splits in
  // the same PATCH is the sanctioned way out.
  if (input.classification && hasPriorSplits && input.splits !== null) {
    throw new BadRequestError(
      `a transaction split across categories can't be classified as a ${input.classification.replace('_', ' ')} — clear the split first (splits: null)`,
    );
  }
  if (input.splits != null) {
    if (input.categoryId != null) {
      throw new BadRequestError(
        'a transaction has either one category or split lines, not both — omit categoryId when sending splits',
      );
    }
    const classification =
      input.classification !== undefined ? input.classification : prior.classification;
    if (classification) {
      throw new BadRequestError(
        `a ${classification.replace('_', ' ')} transaction can't be split across categories`,
      );
    }
    // Splits are confirmed-only: the bank sync rewrites amount/type on
    // pending_review rows in place (applySyncBatch), which would silently
    // leave the split lines summing to the old amount.
    if (prior.status !== 'confirmed') {
      throw new BadRequestError(
        'confirm the transaction before splitting it across categories',
      );
    }
    await assertSplitLinesValid(accountId, input.splits, {
      type: input.type ?? prior.type,
      amountCents: input.amountCents ?? prior.amountCents,
      principalCents:
        (input.principalCents !== undefined ? input.principalCents : prior.principalCents) ?? 0,
    });
    return { action: 'replace', lines: input.splits };
  }
  if (input.splits === null) return hasPriorSplits ? { action: 'clear' } : { action: 'none' };
  if (!hasPriorSplits) return { action: 'none' };
  // Splits left in place: they must still describe the row afterwards, so a
  // move of the amount (their sum) or the type (their categories' type) has to
  // come with the new lines — or with `splits: null` to drop them.
  if (input.amountCents !== undefined && input.amountCents !== prior.amountCents) {
    throw new BadRequestError(
      "this transaction is split across categories — send the new splits in the same update (or splits: null to clear them) when you change its amount",
    );
  }
  // Moving the principal carve-out moves the money the lines describe just as
  // an amount edit does (§3): the remainder is what they sum to.
  if (input.principalCents !== undefined && input.principalCents !== prior.principalCents) {
    throw new BadRequestError(
      "this transaction is split across categories — send the new splits in the same update (or splits: null to clear them) when you change its principal portion",
    );
  }
  if (input.type !== undefined && input.type !== prior.type) {
    throw new BadRequestError(
      "this transaction is split across categories — send the new splits in the same update (or splits: null to clear them) when you change its type",
    );
  }
  // A new single category supersedes the split (same intent as picking one
  // category in the UI).
  return input.categoryId != null ? { action: 'clear' } : { action: 'none' };
}

/**
 * Category and sum invariants for a set of split lines, shared by PATCH and
 * confirm. The lines describe the row's *categorizable* money — its amount less
 * any mortgage-principal carve-out (§3) — because principal repays a liability
 * and belongs to no category; requiring the lines to sum to the gross debit
 * would make a real mortgage payment unsplittable.
 */
async function assertSplitLinesValid(
  accountId: string,
  lines: Array<{ categoryId: string; amountCents: number }>,
  row: { type: string; amountCents: number; principalCents: number },
): Promise<void> {
  const categoryIds = [...new Set(lines.map((s) => s.categoryId))];
  const categories = await prisma.category.findMany({
    where: { id: { in: categoryIds }, OR: [{ isSystem: true }, { accountId }] },
    select: { id: true, type: true },
  });
  const byId = new Map(categories.map((c) => [c.id, c]));
  for (const categoryId of categoryIds) {
    const category = byId.get(categoryId);
    if (!category) throw new NotFoundError('category', categoryId);
    if (category.type !== row.type) {
      throw new BadRequestError(
        `every split category must be an ${row.type} category — ${categoryId} is not`,
      );
    }
  }
  const targetCents = row.amountCents - row.principalCents;
  const sumCents = lines.reduce((sum, s) => sum + s.amountCents, 0);
  if (sumCents === targetCents) return;
  // With a carve-out the mismatch is almost never arithmetic — it's the
  // principal the user forgot to leave out, so the message shows the
  // subtraction rather than a bare pair of totals.
  throw new BadRequestError(
    row.principalCents > 0
      ? `splits must add up to the transaction amount after its mortgage principal — ${formatUsd(sumCents)} split against ${formatUsd(targetCents)} (${formatUsd(row.amountCents)} paid less ${formatUsd(row.principalCents)} principal)`
      : `splits must add up to the transaction amount — ${formatUsd(sumCents)} split against ${formatUsd(row.amountCents)}`,
  );
}

/**
 * Period of the rent charge this transaction backs, or null. Checks both link
 * shapes: the deposit ledger (source of truth) and the legacy single-payment
 * RentPayment.transactionId — deleting either through the DB cascade/SetNull
 * would silently corrupt paidCents or leave paid rent with no ledger entry.
 */
async function rentLinkPeriod(transactionId: string): Promise<string | null> {
  const deposit = await prisma.rentPaymentDeposit.findUnique({
    where: { transactionId },
    include: { rentPayment: { select: { period: true } } },
  });
  if (deposit) return deposit.rentPayment.period;
  const linkedPayment = await prisma.rentPayment.findUnique({
    where: { transactionId },
    select: { period: true },
  });
  return linkedPayment?.period ?? null;
}

export async function remove(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<void> {
  const prior = await getOwned(accountId, id);
  // A rent-linked ledger row backs a deposit (or legacy paid link); deleting
  // it would cascade the deposit away leaving paidCents stale — block and
  // point at the sanctioned path (unlink first).
  const period = await rentLinkPeriod(id);
  if (period) {
    throw new BadRequestError(
      `this transaction backs a recorded rent payment for ${period} and cannot be deleted — unlink the deposit on the Rent page first`,
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
      include: withSplits,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    }),
    prisma.transaction.count({ where }),
  ]);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const categories = await prisma.category.findMany();
  const nameById = new Map(categories.map((c) => [c.id, c.name]));
  // Rent matches and duplicate flags are computed for the returned page only —
  // the bulk paths recompute over their own row set.
  const rentMatches = await computeRentMatches(accountId, items);
  const duplicates = await computeDuplicates(accountId, items);
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
      ...(duplicates.has(r.id) ? { possibleDuplicate: duplicates.get(r.id) } : {}),
    })),
    nextCursor: hasMore && last ? last.id : null,
    total,
  };
}

// Heuristic confidence shown on the rent-match chip; a single exact-amount,
// in-window candidate is a strong but not certain signal. The descriptor
// naming a lease tenant strengthens it; a name that broke an amount/date tie
// is weaker than an uncontested exact match. All three sit at or above the
// BULK_CONFIRM_MIN_CONFIDENCE=0.7 gate, but rent matches are excluded from
// bulk confirm as a class (linking is always an explicit per-item action), so
// a disambiguated match can never be mass-applied.
const RENT_MATCH_CONFIDENCE = 0.9; // exact amount + window (unchanged baseline)
const RENT_MATCH_NAME_CONFIDENCE = 0.95; // …and descriptor names a lease tenant
const RENT_MATCH_DISAMBIGUATED_CONFIDENCE = 0.85; // name broke an amount/date tie

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
  // Deliberately UTC (WS4): this is the ±14-day rent-match heuristic (a pure
  // day-distance window, left UTC per plan). The ±14-day spread already reaches
  // the adjacent month either way, so a ±1-day tz bucketing wobble at a month
  // boundary can't drop a candidate period — both months materialize regardless.
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
    const match = pickRentMatch(
      { amountCents: r.amountCents, date: r.date, description: r.description, vendor: r.vendor },
      candidates,
    );
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
      paidCents: match.paidCents,
      confidence: match.disambiguatedByName
        ? RENT_MATCH_DISAMBIGUATED_CONFIDENCE
        : match.matchedName
          ? RENT_MATCH_NAME_CONFIDENCE
          : RENT_MATCH_CONFIDENCE,
      matchedName: match.matchedName,
    });
  }
  return matches;
}

// How far apart two transactions can be dated and still look like the same
// money (a hand-logged check vs. its later bank import; two feeds covering
// the same account).
const DUPLICATE_WINDOW_DAYS = 3;

/**
 * Content-fingerprint duplicate detection (plan §D2): a pending item is
 * flagged when a CONFIRMED transaction of the same type and exact amount sits
 * within ±3 days — with vendors either agreeing (memory-key match) or absent
 * on one side (manual entries and Stripe FC rows carry no vendor, and those
 * are precisely the cross-source cases). Never auto-merged: the flag renders
 * as a warning with a dismiss-as-duplicate path, and bulk confirm skips it.
 * Computed fresh per queue load, like rent matches.
 *
 * One narrow extension for recurring templates (PLAN-REAL-EQUITY Phase 2b item
 * 6): a bank-connected landlord with a mortgage template gets TWO rows for one
 * payment — the one we drafted and the one the bank delivered — and both are
 * `pending_review`, so under the confirmed-only rule neither is ever a
 * candidate for the other and the queue invites a double-count. A
 * template-drafted row therefore also acts as a candidate, and the pair is
 * matched in both directions. The widening is bounded by ONE condition
 * everywhere below: **exactly one side is template-drafted**. Two ordinary
 * pending rows at the same amount (two $50 invoices paid the same afternoon)
 * stay unflagged, as they always have.
 */
async function computeDuplicates(
  accountId: string,
  rows: DbTransaction[],
): Promise<Map<string, DuplicateSuggestion>> {
  const matches = new Map<string, DuplicateSuggestion>();
  if (rows.length === 0) return matches;
  const times = rows.map((r) => r.date.getTime());
  // Ordinary pending rows are pulled in only when a drafted row is actually on
  // this page and needs something to match against; otherwise the pending half
  // of the candidate set is just the drafted rows themselves.
  const anyDrafted = rows.some((r) => r.recurringTemplateId != null);
  const candidates = await prisma.transaction.findMany({
    where: {
      accountId,
      OR: [
        { status: 'confirmed' },
        anyDrafted
          ? { status: 'pending_review' }
          : { status: 'pending_review', recurringTemplateId: { not: null } },
      ],
      amountCents: { in: [...new Set(rows.map((r) => r.amountCents))] },
      date: {
        gte: addDays(new Date(Math.min(...times)), -DUPLICATE_WINDOW_DAYS),
        lte: addDays(new Date(Math.max(...times)), DUPLICATE_WINDOW_DAYS),
      },
    },
    include: {
      rentDeposit: { include: { rentPayment: { select: { period: true } } } },
      rentPayment: { select: { period: true } },
    },
    orderBy: { date: 'desc' },
  });
  for (const r of rows) {
    const rKey = r.vendor ? vendorMemoryKey(r.vendor) : null;
    const hit = candidates.find((c) => {
      if (c.id === r.id || c.type !== r.type || c.amountCents !== r.amountCents) return false;
      // Deliberately UTC (WS4): the ±3-day duplicate window is a pure
      // day-distance heuristic, not a period/late boundary — a tz wobble is
      // immaterial against a 3-day tolerance.
      if (Math.abs(calendarDaysBetween(c.date, r.date)) > DUPLICATE_WINDOW_DAYS) return false;
      // The template-draft pairing: one side drafted from a template, the other
      // not. Both halves of the extension hang off it.
      const acrossDraft = (c.recurringTemplateId != null) !== (r.recurringTemplateId != null);
      // A pending candidate only counts across a draft — never two ordinary
      // pending rows, which would flood every existing queue with false
      // positives.
      if (c.status !== 'confirmed' && !acrossDraft) return false;
      // Vendors legitimately disagree across a draft: the template carries what
      // the landlord typed ("First Federal Bank") and the feed carries the
      // bank's descriptor ("FIRST FEDERAL BANK MTG PMT 0923"). Letting that
      // disagreement hide the match is exactly how the double-count gets
      // through, so the vendor rule doesn't apply to this pairing.
      if (acrossDraft) return true;
      const cKey = c.vendor ? vendorMemoryKey(c.vendor) : null;
      return !rKey || !cKey || rKey === cKey;
    });
    if (!hit) continue;
    const rentPeriod = hit.rentDeposit?.rentPayment.period ?? hit.rentPayment?.period ?? undefined;
    matches.set(r.id, {
      transactionId: hit.id,
      description: hit.description,
      date: iso(hit.date),
      source: hit.source as TransactionSource,
      ...(rentPeriod ? { rentPeriod } : {}),
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
    // A rent deposit is a tenant's money coming in; a mortgage payment is money
    // going out against a loan. Rejected rather than silently ignored — the
    // breakdown figures are the user's typed input (§3).
    if (input.mortgageId || input.principalCents != null) {
      throw new BadRequestError(
        "a transaction backing a rent payment can't also carry a mortgage principal portion",
      );
    }
    // Attribution comes from the lease itself on this path; a rent deposit is
    // ordinary income by definition, so any classification input is ignored.
    return confirmWithRentLink(
      accountId,
      existing,
      input.rentPaymentId,
      input.categoryId,
      actor,
      input.linkSource === 'manual',
    );
  }
  assertClassificationValid(input.classification, existing.type);
  if (input.classification && existing.splits.length > 0) {
    throw new BadRequestError(
      `a transaction split across categories can't be classified as a ${input.classification.replace('_', ' ')} — clear the split first`,
    );
  }
  if (input.propertyId !== undefined || input.unitId !== undefined) {
    await assertAttributionOwned(
      accountId,
      input.propertyId !== undefined ? input.propertyId : existing.propertyId,
      input.unitId !== undefined ? input.unitId : existing.unitId,
    );
  }
  // Review time is when a mortgage payment gets its breakdown (§3). An explicit
  // mortgageId — the user's, or one a recurring template stamped — always wins;
  // the vendor↔lender match only fills a gap, and only to make the UI offer the
  // editor. It never supplies a number: `principalCents` is whatever the user
  // entered, and stays null when they entered nothing (D4).
  const mortgageId =
    input.mortgageId ??
    existing.mortgageId ??
    (existing.type === 'expense' ? await matchMortgageId(accountId, existing.vendor) : null);
  const principalCents = input.principalCents ?? existing.principalCents ?? null;
  await assertMortgageBreakdownValid(accountId, {
    mortgageId,
    principalCents,
    type: existing.type,
    amountCents: existing.amountCents,
    classification:
      input.classification !== undefined ? input.classification : existing.classification,
  });
  // A split row is already categorized (by its lines): an explicit category
  // supersedes the split exactly like it does on PATCH, and with no explicit
  // category the suggestion is not applied over it. New lines sent with the
  // confirm (the mortgage remainder across interest/taxes/insurance) replace
  // whatever was there.
  const newSplits = input.splits ?? null;
  if (newSplits) {
    if (input.categoryId) {
      throw new BadRequestError(
        'a transaction has either one category or split lines, not both — omit categoryId when sending splits',
      );
    }
    const classification =
      input.classification !== undefined ? input.classification : existing.classification;
    if (classification) {
      throw new BadRequestError(
        `a ${classification.replace('_', ' ')} transaction can't be split across categories`,
      );
    }
    await assertSplitLinesValid(accountId, newSplits, {
      type: existing.type,
      amountCents: existing.amountCents,
      principalCents: principalCents ?? 0,
    });
  }
  const hasSplits = existing.splits.length > 0 || !!newSplits;
  const clearsSplits = existing.splits.length > 0 && (!!input.categoryId || !!newSplits);
  // The remainder of a mortgage payment is interest, so a principal-bearing row
  // confirmed with neither a category nor splits lands on the seeded "Mortgage
  // Interest" category (Schedule E Line 12) instead of whatever the keyword
  // table guessed from the vendor. Nothing is created if the account has no such
  // category — uncategorized beats invented. A principal-only payment has no
  // remainder to categorize.
  const mortgageRemainderCategoryId =
    principalCents != null &&
    existing.amountCents - principalCents > 0 &&
    !input.categoryId &&
    !hasSplits
      ? await mortgageInterestCategoryId(accountId)
      : null;
  const usedSuggestion =
    !input.categoryId &&
    !hasSplits &&
    !mortgageRemainderCategoryId &&
    !!existing.aiSuggestedCategoryId;
  const categoryId = hasSplits
    ? (input.categoryId ?? null)
    : (input.categoryId ??
      mortgageRemainderCategoryId ??
      existing.aiSuggestedCategoryId ??
      existing.categoryId);
  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.transaction.update({
      where: { id },
      data: {
        status: 'confirmed',
        categoryId,
        ...(input.propertyId !== undefined ? { propertyId: input.propertyId } : {}),
        ...(input.unitId !== undefined ? { unitId: input.unitId } : {}),
        ...(input.classification !== undefined ? { classification: input.classification } : {}),
        mortgageId,
        principalCents,
      },
      include: withSplits,
    });
    if (!clearsSplits && !newSplits) return updated;
    await tx.transactionSplit.deleteMany({ where: { transactionId: id } });
    if (newSplits) {
      await tx.transactionSplit.createMany({
        data: newSplits.map((s) => ({
          transactionId: id,
          categoryId: s.categoryId,
          amountCents: s.amountCents,
        })),
      });
    }
    return tx.transaction.findUniqueOrThrow({ where: { id }, include: withSplits });
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
    detail: {
      categoryId,
      propertyId: row.propertyId,
      unitId: row.unitId,
      // The carve-out is money the books stop seeing as an expense — record it.
      // A bare mortgageId (detection) moves no figure, so it stays out.
      ...(row.principalCents != null
        ? { principalCents: row.principalCents, mortgageId: row.mortgageId }
        : {}),
      ...(newSplits
        ? { splits: row.splits.map((s) => ({ categoryId: s.categoryId, amountCents: s.amountCents })) }
        : {}),
    },
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
  existing: DbTransactionWithSplits,
  rentPaymentId: string,
  categoryIdOverride: string | undefined,
  actor: AuditActor,
  manualLink = false,
): Promise<Transaction> {
  if (existing.type !== 'income') {
    throw new BadRequestError('only an income transaction can be linked to a rent payment');
  }
  // A deposit backing a rent charge is Rent income, whole — the link is keyed
  // on that single category (see the update() guard), so a row split across
  // categories can't back one.
  if (existing.splits.length > 0) {
    throw new BadRequestError(
      "a transaction split across categories can't back a rent payment — clear the split first",
    );
  }
  const payment = await prisma.rentPayment.findFirst({
    where: { id: rentPaymentId, lease: { unit: { property: { accountId } } } },
    include: { lease: { include: { unit: true } } },
  });
  if (!payment) throw new NotFoundError('rent payment', rentPaymentId);
  // The heuristic only ever suggests exact-remaining matches, but the endpoint
  // accepts any rentPaymentId — a deposit may undershoot the remaining balance
  // (partial payment) but never overshoot it. Mirrors recordPayment's guard.
  // Remaining is against totalDue = charge + any applied late fee (WS7).
  const totalDueCents = payment.amountCents + payment.lateFeeCents;
  if (payment.paidCents >= totalDueCents) {
    throw new BadRequestError(`rent for ${payment.period} is already recorded as paid`);
  }
  if (existing.amountCents > totalDueCents - payment.paidCents) {
    throw new BadRequestError(
      `transaction of ${formatUsd(existing.amountCents)} exceeds the ${formatUsd(totalDueCents - payment.paidCents)} remaining for ${payment.period} — ` +
        `it can't be linked to this rent payment`,
    );
  }
  // Scoped like suggestCategory: never pick up another account's custom "Rent".
  const rentCategory = await prisma.category.findFirst({
    where: { name: 'Rent', type: 'income', OR: [{ isSystem: true }, { accountId }] },
    orderBy: { isSystem: 'desc' },
  });
  // A deposit linked when the base rent is already covered is pure fee money →
  // 'Late Fees' (WS7); a blended one covering base + fee stays 'Rent'.
  const lateFeeCategory = await prisma.category.findFirst({
    where: { name: 'Late Fees', type: 'income', OR: [{ isSystem: true }, { accountId }] },
    orderBy: { isSystem: 'desc' },
  });
  // Bank deposits link with method 'bank'; a manually logged income row that
  // matched an expected rent links as 'manual'.
  const method = existing.source === 'bank' ? 'bank' : 'manual';

  // Confirm + deposit + charge update commit or roll back together; the
  // re-read inside the transaction makes the double-pay/over-remaining guards
  // hold under concurrent requests (mirrors recordPayment).
  const { row, updatedPayment } = await prisma.$transaction(async (tx) => {
    const fresh = await tx.rentPayment.findUniqueOrThrow({ where: { id: payment.id } });
    const freshTotalDue = fresh.amountCents + fresh.lateFeeCents;
    if (fresh.status === 'paid' || fresh.paidCents >= freshTotalDue) {
      throw new BadRequestError(`rent for ${payment.period} is already recorded as paid`);
    }
    if (existing.amountCents > freshTotalDue - fresh.paidCents) {
      throw new BadRequestError(
        `transaction of ${formatUsd(existing.amountCents)} exceeds the ${formatUsd(freshTotalDue - fresh.paidCents)} remaining for ${payment.period}`,
      );
    }
    // Base rent already covered before this deposit → this is fee money (WS7).
    const feeOnly = fresh.paidCents >= fresh.amountCents;
    const confirmedRow = await tx.transaction.update({
      where: { id: existing.id },
      data: {
        status: 'confirmed',
        categoryId:
          categoryIdOverride ?? (feeOnly ? lateFeeCategory : rentCategory)?.id ?? existing.categoryId,
        propertyId: payment.lease.unit.propertyId,
        unitId: payment.lease.unitId,
      },
      include: withSplits,
    });
    await tx.rentPaymentDeposit.create({
      data: {
        rentPaymentId: payment.id,
        transactionId: existing.id,
        amountCents: existing.amountCents,
        method,
        paidAt: existing.date,
      },
    });
    const newPaidCents = fresh.paidCents + existing.amountCents;
    const covered = newPaidCents >= freshTotalDue;
    const linkedPayment = await tx.rentPayment.update({
      where: { id: payment.id },
      data: {
        paidCents: newPaidCents,
        ...(covered
          ? {
              status: 'paid',
              method,
              paidAt: existing.date,
              ...(fresh.paidCents === 0 ? { transactionId: existing.id } : {}),
            }
          : {}),
      },
    });
    return { row: confirmedRow, updatedPayment: linkedPayment };
  });

  // Accepting the rent-match suggestion is accepting AI-suggested content; a
  // hand-picked charge (picker modal, ambiguous-deposit select) is the user's
  // own call and stays 'user'.
  const auditActor = actor === 'user' && !manualLink ? 'ai_suggested_user_confirmed' : actor;
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
      amountCents: existing.amountCents,
      paidCents: updatedPayment.paidCents,
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
  const row = await prisma.transaction.update({
    where: { id },
    data: { status: 'dismissed' },
    include: withSplits,
  });
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
 * Undo a dismiss: puts a dismissed transaction back into the review queue.
 * Only dismissed rows are eligible — a confirmed or already-pending row has
 * no "restore" to do (the confirm/dismiss actions are how you'd move it).
 */
export async function restore(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<Transaction> {
  const existing = await getOwned(accountId, id);
  if (existing.status !== 'dismissed') {
    throw new BadRequestError('only a dismissed transaction can be restored');
  }
  const row = await prisma.transaction.update({
    where: { id },
    data: { status: 'pending_review' },
    include: withSplits,
  });
  await writeAudit(accountId, {
    actor,
    action: 'transaction.restored',
    entityType: 'transaction',
    entityId: id,
    detail: { source: row.source, amountCents: row.amountCents, vendor: row.vendor },
  });
  return toApiTransaction(row);
}

/**
 * Minimum suggestion confidence a bulk confirm will act on (plan §D1 —
 * resolves the WHATS_NEXT §6.2 threshold decision). Matches the review UI's
 * low-confidence warning cue: anything the UI flags for a human eye is never
 * mass-confirmed. Per-item confirm is unaffected — a human is looking.
 */
export const BULK_CONFIRM_MIN_CONFIDENCE = 0.7;

/**
 * Confirm every filtered pending item with its AI-suggested category. Skipped
 * (left for per-item review): items with no suggestion (they'd land in
 * reports uncategorized), items below BULK_CONFIRM_MIN_CONFIDENCE, items with
 * a rent match (linking a deposit is an explicit per-item action), and items
 * flagged as possible duplicates (never auto-merged or auto-counted).
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
  const duplicates = await computeDuplicates(accountId, rows);
  let confirmed = 0;
  let skipped = 0;
  for (const r of rows) {
    if (
      !r.aiSuggestedCategoryId ||
      (r.aiConfidence ?? 0) < BULK_CONFIRM_MIN_CONFIDENCE ||
      rentMatches.has(r.id) ||
      duplicates.has(r.id)
    ) {
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
        contractorId: await matchContractorId(accountId, t.vendor),
        // Stamped at IMPORT, not just at confirm: the review-queue card decides
        // whether to offer the principal/interest/escrow breakdown from this
        // field, and a mortgage payment arrives here as a bank row — detecting
        // it only at confirm would mean the breakdown is never offered where
        // it's actually needed. Inert: it sets no amount and changes no
        // categorization, and balance derivation counts confirmed rows only.
        mortgageId: t.type === 'expense' ? await matchMortgageId(accountId, t.vendor) : null,
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
    // must not silently rewrite it. Instead record the restated values as a
    // pending discrepancy for the user to accept or keep their version (WS5:
    // a bank restatement after confirm otherwise left stale P&L with no notice).
    if (existing.status !== 'pending_review') {
      await recordSyncDiscrepancy(
        accountId,
        provider,
        'modified',
        t.externalId,
        existing.id,
        {
          date: iso(t.date),
          amountCents: t.amountCents,
          type: t.type,
          description: t.description,
          vendor: t.vendor,
        },
        counts,
      );
      continue;
    }
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
        contractorId: await matchContractorId(accountId, t.vendor),
        // Keep an existing link rather than re-deriving it: a user who already
        // entered a breakdown has `principalCents` depending on `mortgageId`,
        // and a lender rename (or a second mortgage making the name ambiguous)
        // would otherwise null the link out from under it.
        mortgageId:
          existing.mortgageId ??
          (t.type === 'expense' ? await matchMortgageId(accountId, t.vendor) : null),
        // This path rewrites amount and type behind the breakdown validator, so
        // it has to keep the invariant itself. A restatement the stored
        // principal no longer fits (the bank says $2,200 against an $800/$2,400
        // breakdown, or flips the row to income) would otherwise persist an
        // impossible row that `confirm` then rejects forever — and one such row
        // fails the whole bulk confirm, since it has no per-row isolation.
        // The user's own figures no longer describe this payment, so drop them
        // and let them re-enter against the amount that actually cleared.
        principalCents:
          existing.principalCents !== null &&
          t.type === 'expense' &&
          existing.principalCents <= t.amountCents
            ? existing.principalCents
            : null,
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
    // Never stored this id (or already gone) — nothing to delete or flag.
    if (!existing) continue;
    // Same ownership rule as `modified`: a confirmed/dismissed row is the
    // user's vouched ledger — don't delete it silently; flag the bank's void
    // as a pending discrepancy instead.
    if (existing.status !== 'pending_review') {
      await recordSyncDiscrepancy(accountId, provider, 'removed', externalId, existing.id, null, counts);
      continue;
    }
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

// ── bank-sync discrepancies (post-confirm bank corrections, WS5) ─────────────

/**
 * A bank `modified`/`removed` change hit a row the user already
 * confirmed/dismissed. Record it as a pending discrepancy instead of silently
 * skipping it. Keyed on (accountId, externalId, kind, status 'pending') so a
 * nightly mock-adapter replay refreshes the single open row (and its restated
 * bankData) rather than accreting duplicates. Audited once, on create only —
 * a replay refresh must not spam the trail. `bankData` is the restated fields
 * for a 'modified' change; null for a 'removed' void.
 */
async function recordSyncDiscrepancy(
  accountId: string,
  provider: BankSyncProvider,
  kind: BankDiscrepancyKind,
  externalId: string,
  transactionId: string,
  bankData: { date: string; amountCents: number; type: TransactionType; description: string; vendor: string | null } | null,
  counts: ImportTransactionsResponse,
): Promise<void> {
  const bankDataJson = bankData ? JSON.stringify(bankData) : null;
  counts.flaggedForReview = (counts.flaggedForReview ?? 0) + 1;
  const existing = await prisma.bankSyncDiscrepancy.findFirst({
    where: { accountId, externalId, kind, status: 'pending' },
  });
  if (existing) {
    await prisma.bankSyncDiscrepancy.update({
      where: { id: existing.id },
      data: { bankDataJson, transactionId, provider },
    });
    return;
  }
  const row = await prisma.bankSyncDiscrepancy.create({
    data: { accountId, transactionId, externalId, provider, kind, bankDataJson, status: 'pending' },
  });
  await writeAudit(accountId, {
    actor: 'system',
    action: 'bank_discrepancy.recorded',
    entityType: 'bank_discrepancy',
    entityId: row.id,
    detail: { externalId, kind, provider, transactionId },
  });
}

function parseBankData(json: string | null): BankDiscrepancyRow['bankData'] {
  if (!json) return null;
  const parsed = BankDiscrepancyDataSchema.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : null;
}

/**
 * Rent-link context (deposit shape preferred, legacy single-payment link as a
 * fallback) for the given ledger rows — powers the frontend's guided
 * "unlink deposit, then accept" flow. Mirrors the two link shapes
 * `rentLinkPeriod` checks.
 */
async function rentLinkContextForTransactions(
  ids: string[],
): Promise<Map<string, { rentPaymentId: string; depositId?: string; period: string }>> {
  const out = new Map<string, { rentPaymentId: string; depositId?: string; period: string }>();
  if (ids.length === 0) return out;
  const deposits = await prisma.rentPaymentDeposit.findMany({
    where: { transactionId: { in: ids } },
    include: { rentPayment: { select: { id: true, period: true } } },
  });
  for (const d of deposits) {
    out.set(d.transactionId, {
      rentPaymentId: d.rentPayment.id,
      depositId: d.id,
      period: d.rentPayment.period,
    });
  }
  const legacy = await prisma.rentPayment.findMany({
    where: { transactionId: { in: ids } },
    select: { id: true, period: true, transactionId: true },
  });
  for (const p of legacy) {
    if (p.transactionId && !out.has(p.transactionId)) {
      out.set(p.transactionId, { rentPaymentId: p.id, period: p.period });
    }
  }
  return out;
}

/** Pending bank-sync discrepancies with their local-row summary + rent-link context. */
export async function listBankDiscrepancies(
  accountId: string,
): Promise<BankDiscrepancyListResponse> {
  const rows = await prisma.bankSyncDiscrepancy.findMany({
    where: { accountId, status: 'pending' },
    orderBy: { createdAt: 'desc' },
  });
  if (rows.length === 0) return { items: [] };

  const txnIds = rows.map((r) => r.transactionId).filter((id): id is string => !!id);
  const txns = txnIds.length
    ? await prisma.transaction.findMany({
        where: { id: { in: txnIds }, accountId },
        include: withSplits,
      })
    : [];
  const txnById = new Map(txns.map((t) => [t.id, t]));
  const categoryIds = [
    ...new Set(txns.map((t) => t.categoryId).filter((id): id is string => !!id)),
  ];
  const categories = categoryIds.length
    ? await prisma.category.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } })
    : [];
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const rentLinks = await rentLinkContextForTransactions(txnIds);

  const items: BankDiscrepancyRow[] = rows.map((r) => {
    const txn = r.transactionId ? (txnById.get(r.transactionId) ?? null) : null;
    const link = r.transactionId ? rentLinks.get(r.transactionId) : undefined;
    return {
      id: r.id,
      provider: r.provider as BankSyncProvider,
      kind: r.kind as BankDiscrepancyKind,
      externalId: r.externalId,
      bankData: parseBankData(r.bankDataJson),
      createdAt: iso(r.createdAt),
      transaction: txn
        ? {
            id: txn.id,
            description: txn.description,
            vendor: txn.vendor,
            amountCents: txn.amountCents,
            date: iso(txn.date),
            type: txn.type as TransactionType,
            status: txn.status as TransactionStatus,
            categoryName:
              txn.splits.length > 0
                ? `Split across ${txn.splits.length} categories`
                : txn.categoryId
                  ? (categoryName.get(txn.categoryId) ?? null)
                  : null,
          }
        : null,
      ...(link
        ? {
            rentPaymentId: link.rentPaymentId,
            ...(link.depositId ? { depositId: link.depositId } : {}),
            rentPeriod: link.period,
          }
        : {}),
    };
  });
  return { items };
}

function toResolution(row: {
  id: string;
  status: string;
  resolvedAt: Date | null;
}): BankDiscrepancyResolution {
  return {
    id: row.id,
    status: row.status as BankDiscrepancyStatus,
    resolvedAt: isoOrNull(row.resolvedAt),
  };
}

/**
 * Apply the bank's version: a 'modified' change routes through the existing
 * `update()`, a 'removed' change through `remove()` — so the rent-link guards
 * hold and their 400s bubble to the caller untouched (the discrepancy stays
 * pending until the user unlinks the deposit). Only on success is the row
 * marked accepted.
 */
export async function acceptBankDiscrepancy(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<BankDiscrepancyResolution> {
  const disc = await prisma.bankSyncDiscrepancy.findFirst({ where: { id, accountId } });
  if (!disc) throw new NotFoundError('bank discrepancy', id);
  if (disc.status !== 'pending') {
    throw new BadRequestError('this bank change has already been resolved');
  }
  if (!disc.transactionId) {
    throw new BadRequestError(
      'the local transaction no longer exists — dismiss this bank change instead',
    );
  }
  let clearedSplits = false;
  if (disc.kind === 'removed') {
    await remove(accountId, disc.transactionId, actor);
  } else {
    const bankData = parseBankData(disc.bankDataJson);
    if (!bankData) throw new BadRequestError('this bank change is missing its restated values');
    // The restated amount/type invalidates any split (its lines summed to the
    // old figure), and update() rightly refuses to guess new ones — so the
    // bank's version lands with the split dropped. The row comes back
    // uncategorized rather than silently mis-split; the user re-splits it.
    clearedSplits = !!(await prisma.transactionSplit.findFirst({
      where: { transactionId: disc.transactionId },
      select: { id: true },
    }));
    await update(
      accountId,
      disc.transactionId,
      {
        date: bankData.date,
        amountCents: bankData.amountCents,
        type: bankData.type,
        description: bankData.description,
        ...(clearedSplits ? { splits: null } : {}),
        // vendor can't be cleared through the update contract; only restate it
        // when the bank gave a concrete value (amount/date/type are what fix P&L).
        ...(bankData.vendor != null ? { vendor: bankData.vendor } : {}),
      },
      actor,
    );
  }
  const resolved = await prisma.bankSyncDiscrepancy.update({
    where: { id },
    data: { status: 'accepted', resolvedAt: new Date() },
  });
  await writeAudit(accountId, {
    actor,
    action: 'bank_discrepancy.accepted',
    entityType: 'bank_discrepancy',
    entityId: id,
    detail: {
      externalId: disc.externalId,
      kind: disc.kind,
      transactionId: disc.transactionId,
      ...(clearedSplits ? { clearedSplits: true } : {}),
    },
  });
  return toResolution(resolved);
}

/** Keep the user's version: mark the discrepancy dismissed (terminal). */
export async function dismissBankDiscrepancy(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<BankDiscrepancyResolution> {
  const disc = await prisma.bankSyncDiscrepancy.findFirst({ where: { id, accountId } });
  if (!disc) throw new NotFoundError('bank discrepancy', id);
  if (disc.status !== 'pending') {
    throw new BadRequestError('this bank change has already been resolved');
  }
  const resolved = await prisma.bankSyncDiscrepancy.update({
    where: { id },
    data: { status: 'dismissed', resolvedAt: new Date() },
  });
  await writeAudit(accountId, {
    actor,
    action: 'bank_discrepancy.dismissed',
    entityType: 'bank_discrepancy',
    entityId: id,
    detail: { externalId: disc.externalId, kind: disc.kind },
  });
  return toResolution(resolved);
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
  // A successful sync also clears any recorded sync-failure health (WS5).
  await prisma.integration.updateMany({
    where: { accountId, type: 'plaid' },
    data: { lastSyncedAt: new Date(), syncFailureCount: 0, lastSyncError: null, lastSyncErrorAt: null },
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
  // A successful sync also clears any recorded sync-failure health (WS5).
  await prisma.integration.updateMany({
    where: { accountId, type: 'stripe_fc' },
    data: { lastSyncedAt: new Date(), syncFailureCount: 0, lastSyncError: null, lastSyncErrorAt: null },
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
