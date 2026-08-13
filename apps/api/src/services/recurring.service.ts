// Recurring transaction templates (PLAN-REAL-EQUITY §2/§4, Phase 2b). A
// template is a standing instruction, never a ledger row: `draftDue` (called
// per account by the daily jobs loop) writes the most recent due occurrence
// into the review queue as `pending_review` with source `recurring`, and the
// user confirms it. Nothing here ever auto-confirms — a template says what you
// EXPECT to be charged; only the bank says what you actually were.
//
// Two rules carry this file:
//
//  1. **`lastDraftedOccurrence` is the only idempotency guard.** It records the
//     occurrence, not the row, so it survives the drafted transaction being
//     dismissed or deleted — a dismissal is a decision, and re-drafting it the
//     next night would override the user nightly.
//
//  2. **No backfill, ever.** Only the occurrence due *now* is considered, so a
//     template paused for six months and resumed produces one row, not six.
//     Restoring deliberately leaves the marker alone. The marker enforces this
//     as a monotonic floor (`<=`), not an equality check, so a schedule edited
//     to an earlier-computing occurrence can't reach back into a closed month.
//
// The occurrence math itself lives in `lib/recurrence.ts` (calendar dates in
// the account's timezone, day-of-month clamped) so the "next occurrence" this
// service reports and the occurrence it drafts can never disagree.
//
// `anchorDate` crosses the API as a calendar date and is stored as the instant
// of local midnight on that date in the account's timezone — see
// `anchorInstant`/`anchorCalendarDate` below.
import {
  formatUsd,
  type CreateRecurringTemplateInput,
  type RecurrenceCadence,
  type RecurringTemplate,
  type TransactionType,
  type UpdateRecurringTemplateInput,
} from '@hearth/shared';
import type { RecurringTemplate as DbRecurringTemplate } from '@prisma/client';
import { iso, isoOrNull, wallClockParts } from '../lib/dates';
import { BadRequestError, NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { occurrenceInstant, occurrenceOnOrAfter, occurrenceOnOrBefore } from '../lib/recurrence';
import { accountTimezone } from './account.service';
import { writeAudit, type AuditActor } from './audit.service';

/**
 * `YYYY-MM-DD` → the instant to store it at: local midnight of that day in the
 * account's timezone, exactly how every row this template drafts is dated.
 *
 * The anchor is a statement about the landlord's calendar ("the 1st"), and the
 * only faithful way to keep a calendar date in a DateTime column is to pin it
 * to their own midnight. Storing the client's UTC midnight instead is what made
 * a template set to Sep 1 recur on Aug 31: read back in `America/New_York`,
 * `2026-09-01T00:00:00Z` is Aug 31 19:00, so the schedule silently moved to the
 * 31st — the wrong month, with the day then wandering as clamping applied.
 */
function anchorInstant(anchorDate: string, tz: string): Date {
  return occurrenceInstant(anchorDate, tz);
}

/** The mirror: a stored anchor instant → the calendar date it means in `tz`. */
function anchorCalendarDate(anchor: Date, tz: string): string {
  const p = wallClockParts(tz, anchor);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function toApiTemplate(t: DbRecurringTemplate, tz: string, now: Date): RecurringTemplate {
  return {
    id: t.id,
    accountId: t.accountId,
    description: t.description,
    vendor: t.vendor,
    propertyId: t.propertyId,
    unitId: t.unitId,
    categoryId: t.categoryId,
    type: t.type as TransactionType,
    amountCents: t.amountCents,
    cadence: t.cadence as RecurrenceCadence,
    anchorDate: anchorCalendarDate(t.anchorDate, tz),
    mortgageId: t.mortgageId,
    principalCents: t.principalCents,
    lastDraftedOccurrence: t.lastDraftedOccurrence,
    // A paused template has nothing coming: reporting the date it *would* have
    // drafted on would read as a promise the scheduler is not going to keep.
    nextOccurrence: t.archivedAt
      ? null
      : occurrenceOnOrAfter(t.anchorDate, t.cadence as RecurrenceCadence, now, tz),
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
    archivedAt: isoOrNull(t.archivedAt),
  };
}

async function getOwned(accountId: string, id: string): Promise<DbRecurringTemplate> {
  const row = await prisma.recurringTemplate.findFirst({ where: { id, accountId } });
  if (!row) throw new NotFoundError('recurring template', id);
  return row;
}

/**
 * Validate a template's FINAL state — the state the rows it drafts will
 * inherit. Enforced here rather than in the route schema because every drafted
 * row bypasses `transaction.service.create`'s own guards: an unowned property
 * or a principal larger than the payment would otherwise reach the ledger
 * monthly, and the messages are the ledger's own so the same mistake reads the
 * same wherever it is made.
 */
async function assertTemplateValid(
  accountId: string,
  final: {
    type: string;
    amountCents: number;
    propertyId: string | null;
    unitId: string | null;
    categoryId: string | null;
    mortgageId: string | null;
    principalCents: number | null;
  },
): Promise<void> {
  if (final.amountCents <= 0) {
    throw new BadRequestError('a recurring amount must be more than $0');
  }
  if (final.propertyId) {
    const property = await prisma.property.findFirst({
      where: { id: final.propertyId, accountId },
      select: { id: true },
    });
    if (!property) throw new NotFoundError('property', final.propertyId);
  }
  if (final.unitId) {
    const unit = await prisma.unit.findFirst({
      where: { id: final.unitId, property: { accountId } },
      select: { propertyId: true },
    });
    if (!unit) throw new NotFoundError('unit', final.unitId);
    if (final.propertyId && unit.propertyId !== final.propertyId) {
      throw new BadRequestError('unit does not belong to the attributed property');
    }
  }
  if (final.categoryId) {
    // System categories are shared; a custom one must be this account's.
    const category = await prisma.category.findFirst({
      where: { id: final.categoryId, OR: [{ isSystem: true }, { accountId }] },
      select: { id: true },
    });
    if (!category) throw new NotFoundError('category', final.categoryId);
  }
  if (final.mortgageId) {
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
  // Equal is legal: a principal-only payment contributes $0 to P&L and still
  // decrements the mortgage.
  if (final.principalCents < 0 || final.principalCents > final.amountCents) {
    throw new BadRequestError(
      `the principal portion must be between $0 and the payment itself — ${formatUsd(final.principalCents)} principal against a ${formatUsd(final.amountCents)} payment`,
    );
  }
}

/**
 * Draft one template's currently-due occurrence, if any. Returns the occurrence
 * drafted (`YYYY-MM-DD`) or null when there was nothing to do — the single code
 * path behind both the nightly sweep and draft-on-create, so the idempotency
 * rule can't diverge between them.
 */
async function draftTemplate(
  accountId: string,
  t: DbRecurringTemplate,
  tz: string,
  now: Date,
): Promise<string | null> {
  if (t.archivedAt) return null;
  const cadence = t.cadence as RecurrenceCadence;
  const due = occurrenceOnOrBefore(t.anchorDate, cadence, now, tz);
  // Anchor still in the future — scheduled, not started.
  if (due === null) return null;
  // Already handled. The marker outlives the row it drafted, so a dismissed
  // occurrence stays dismissed instead of coming back every night.
  //
  // `<=`, not `===`: the currently-due occurrence can move BACKWARDS under a
  // live template — editing the anchor to a later day in the month, widening
  // the cadence (monthly → annual), or changing the account's timezone all
  // recompute "due now" into a period that has already been drafted, or worse
  // into a month that has closed. Equality only recognises the unchanged
  // schedule and drafts every other case as a backfill. Making the marker a
  // monotonic floor states the actual invariant — nothing at or before it ever
  // drafts again — so it also covers the causes nobody has thought of yet.
  // `YYYY-MM-DD` orders chronologically as a string, so this is just `<=`.
  if (t.lastDraftedOccurrence !== null && due <= t.lastDraftedOccurrence) return null;

  const created = await prisma.$transaction(async (tx) => {
    // Claim the occurrence first, conditional on the marker we read. A second
    // caller (the nightly run racing a draft-on-create) blocks on this row
    // until we commit, then matches nothing and rolls back — one occurrence
    // can only ever mint one ledger row.
    const claim = await tx.recurringTemplate.updateMany({
      where: { id: t.id, lastDraftedOccurrence: t.lastDraftedOccurrence },
      data: { lastDraftedOccurrence: due },
    });
    if (claim.count === 0) return null;
    return tx.transaction.create({
      data: {
        accountId,
        propertyId: t.propertyId,
        unitId: t.unitId,
        categoryId: t.categoryId,
        date: occurrenceInstant(due, tz),
        amountCents: t.amountCents,
        type: t.type,
        description: t.description,
        vendor: t.vendor,
        source: 'recurring',
        // Never auto-confirmed: this is an expectation, and the review queue is
        // where an expectation becomes a fact.
        status: 'pending_review',
        recurringTemplateId: t.id,
        // A mortgage template carries the breakdown the user entered once onto
        // every row it drafts, so it is pre-filled rather than retyped monthly.
        // Still their figures — nothing here is computed (decision D4).
        mortgageId: t.mortgageId,
        principalCents: t.principalCents,
      },
      select: { id: true },
    });
  });
  if (!created) return null;

  await writeAudit(accountId, {
    actor: 'system',
    action: 'transaction.created',
    entityType: 'transaction',
    entityId: created.id,
    detail: {
      source: 'recurring',
      recurringTemplateId: t.id,
      occurrence: due,
      ...(t.principalCents != null
        ? { principalCents: t.principalCents, mortgageId: t.mortgageId }
        : {}),
    },
  });
  return due;
}

/** Non-archived by default; the paused ones are listed only to offer resume. */
export async function list(
  accountId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<RecurringTemplate[]> {
  const rows = await prisma.recurringTemplate.findMany({
    where: { accountId, ...(opts.includeArchived ? {} : { archivedAt: null }) },
    orderBy: { createdAt: 'asc' },
  });
  if (rows.length === 0) return [];
  const tz = await accountTimezone(accountId);
  const now = new Date();
  return rows.map((r) => toApiTemplate(r, tz, now));
}

export async function create(
  accountId: string,
  input: CreateRecurringTemplateInput,
  actor: AuditActor = 'user',
): Promise<RecurringTemplate> {
  await assertTemplateValid(accountId, {
    type: input.type,
    amountCents: input.amountCents,
    propertyId: input.propertyId ?? null,
    unitId: input.unitId ?? null,
    categoryId: input.categoryId ?? null,
    mortgageId: input.mortgageId ?? null,
    principalCents: input.principalCents ?? null,
  });
  const tz = await accountTimezone(accountId);
  const row = await prisma.recurringTemplate.create({
    data: {
      accountId,
      description: input.description,
      vendor: input.vendor ?? null,
      propertyId: input.propertyId ?? null,
      unitId: input.unitId ?? null,
      categoryId: input.categoryId ?? null,
      type: input.type,
      amountCents: input.amountCents,
      cadence: input.cadence,
      anchorDate: anchorInstant(input.anchorDate, tz),
      mortgageId: input.mortgageId ?? null,
      principalCents: input.principalCents ?? null,
    },
  });
  await writeAudit(accountId, {
    actor,
    action: 'recurring_template.created',
    entityType: 'recurring_template',
    entityId: row.id,
    detail: { description: row.description, amountCents: row.amountCents, cadence: row.cadence },
  });
  // Draft-on-create (decision D2): a template added after this period's
  // occurrence date drafts it now. Waiting would leave the feature looking
  // broken for a month; the shared draft path keeps it to one row.
  const now = new Date();
  const drafted = await draftTemplate(accountId, row, tz, now);
  return toApiTemplate(
    { ...row, lastDraftedOccurrence: drafted ?? row.lastDraftedOccurrence },
    tz,
    now,
  );
}

export async function update(
  accountId: string,
  id: string,
  input: UpdateRecurringTemplateInput,
  actor: AuditActor = 'user',
): Promise<RecurringTemplate> {
  const prior = await getOwned(accountId, id);
  const tz = await accountTimezone(accountId);
  // Detaching the mortgage takes its principal with it. Principal without a
  // mortgage is not a valid row, and leaving a stale figure behind is worse
  // than an error: the template would keep stamping principal onto every row it
  // drafts, and each confirmation would pay down a loan this payment no longer
  // belongs to. A patch that clears the mortgage while naming a principal is a
  // contradiction, not a detach, and still fails validation below.
  const principalPatch =
    input.mortgageId === null && input.principalCents === undefined ? null : input.principalCents;
  // `undefined` = "leave it alone", `null` = "clear it". Collapsing the two
  // (the shape a plain `?? prior` gives you) is what made an optional field
  // unclearable: the request reports success and changes nothing.
  const patched = <T>(patch: T | null | undefined, current: T | null): T | null =>
    patch !== undefined ? patch : current;
  // Validate the merged result, not the patch: raising the amount is fine on
  // its own but not against a stored principal it no longer covers, and
  // lowering the amount under the stored principal is the same bug arriving
  // from the other side. Clearing a field is part of that final state too — the
  // row that comes out has to be one the ledger would accept.
  await assertTemplateValid(accountId, {
    type: input.type !== undefined ? input.type : prior.type,
    amountCents: input.amountCents !== undefined ? input.amountCents : prior.amountCents,
    propertyId: patched(input.propertyId, prior.propertyId),
    unitId: patched(input.unitId, prior.unitId),
    categoryId: patched(input.categoryId, prior.categoryId),
    mortgageId: patched(input.mortgageId, prior.mortgageId),
    principalCents: patched(principalPatch, prior.principalCents),
  });
  const row = await prisma.recurringTemplate.update({
    where: { id },
    data: {
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.vendor !== undefined ? { vendor: input.vendor } : {}),
      ...(input.propertyId !== undefined ? { propertyId: input.propertyId } : {}),
      ...(input.unitId !== undefined ? { unitId: input.unitId } : {}),
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.amountCents !== undefined ? { amountCents: input.amountCents } : {}),
      ...(input.cadence !== undefined ? { cadence: input.cadence } : {}),
      ...(input.anchorDate !== undefined
        ? { anchorDate: anchorInstant(input.anchorDate, tz) }
        : {}),
      ...(input.mortgageId !== undefined ? { mortgageId: input.mortgageId } : {}),
      ...(principalPatch !== undefined ? { principalCents: principalPatch } : {}),
    },
  });
  await writeAudit(accountId, {
    actor,
    action: 'recurring_template.updated',
    entityType: 'recurring_template',
    entityId: id,
    detail: { amountCents: row.amountCents, cadence: row.cadence },
  });
  return toApiTemplate(row, tz, new Date());
}

/** Archive = pause. Nothing drafts while archived; the marker is left as-is. */
export async function remove(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<void> {
  await getOwned(accountId, id);
  await prisma.recurringTemplate.update({ where: { id }, data: { archivedAt: new Date() } });
  await writeAudit(accountId, {
    actor,
    action: 'recurring_template.archived',
    entityType: 'recurring_template',
    entityId: id,
  });
}

/**
 * Resume. `lastDraftedOccurrence` is deliberately untouched: the next sweep
 * drafts the occurrence due *now* and nothing else, so six paused months
 * produce one row rather than six.
 */
export async function restore(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<RecurringTemplate> {
  await getOwned(accountId, id);
  const row = await prisma.recurringTemplate.update({
    where: { id },
    data: { archivedAt: null },
  });
  await writeAudit(accountId, {
    actor,
    action: 'recurring_template.restored',
    entityType: 'recurring_template',
    entityId: id,
  });
  return toApiTemplate(row, await accountTimezone(accountId), new Date());
}

export interface DraftDueResult {
  /** Ledger rows actually created — never an estimate, and never lost to a
   *  sibling's failure. */
  drafted: number;
  /** One entry per template that threw. Reported rather than raised so the
   *  count above survives; the jobs loop turns each into a per-account error. */
  errors: Array<{ templateId: string; message: string }>;
}

/**
 * Draft every due occurrence for one account — the daily jobs entry point.
 * Reports how many ledger rows it created (0 on a normal night: a monthly
 * template only drafts once per month) plus whatever failed.
 *
 * Templates are isolated from each other. Throwing on the first failure lost
 * the rows already drafted from the count *and* skipped every later template
 * that night — one template whose property was deleted under it could stall the
 * landlord's whole portfolio indefinitely, silently, because tomorrow's run
 * hits the same template first. Each one's outcome is now its own; drafting is
 * idempotent on the occurrence, so nothing double-drafts on the retry.
 */
export async function draftDue(
  accountId: string,
  tz: string,
  now: Date = new Date(),
): Promise<DraftDueResult> {
  const templates = await prisma.recurringTemplate.findMany({
    where: { accountId, archivedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  const result: DraftDueResult = { drafted: 0, errors: [] };
  for (const t of templates) {
    try {
      if (await draftTemplate(accountId, t, tz, now)) result.drafted += 1;
    } catch (err) {
      result.errors.push({
        templateId: t.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
