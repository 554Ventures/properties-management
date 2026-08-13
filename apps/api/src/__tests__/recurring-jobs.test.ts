// Nightly drafting inside runDailyJobs, and the duplicate window it opens
// (PLAN-REAL-EQUITY Phase 2b items 5–6).
//
// Two properties are load-bearing here:
//
//  1. A due template drafts exactly ONE row however many times the nightly run
//     fires, and a template that can't draft costs its account nothing else.
//  2. The row we drafted and the row the bank delivered — both pending, both
//     the same money — find each other DESPITE disagreeing vendors, while two
//     ordinary pending rows at the same amount keep not flagging each other
//     (that regression would flood every existing user's review queue).
//
// The drafting tests run on throwaway accounts, never the seeded demo one: a
// drafted row lands in the review queue, and REVIEW_QUEUE_ITEMS is pinned.
// Everything created here is cleaned up in afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReviewQueueResponseSchema } from '@hearth/shared';
import { addDays } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { occurrenceOnOrBefore } from '../lib/recurrence';
import { getDemoAccountId } from '../plugins/auth';
import { runDailyJobs } from '../services/jobs.service';
import * as transactionService from '../services/transaction.service';

const TZ = 'America/New_York';

let accountId: string;
let propertyId: string;
let demoAccountId: string;
/** Template used only as an FK for hand-made "drafted" rows — stamped at the
 *  occurrence due now, so the jobs runs in this file never draft from it. */
let stampedTemplateId: string;
/** Created inside the failure test; deleted in afterAll even if it fails. */
let brokenAccountId: string | null = null;

const now = new Date();

async function createTemplate(
  over: Record<string, unknown> = {},
): Promise<{ id: string; anchorDate: Date }> {
  return prisma.recurringTemplate.create({
    data: {
      accountId,
      description: 'ZZJOBS standing charge',
      vendor: 'Standing Order Co',
      propertyId,
      type: 'expense',
      amountCents: 111_100,
      cadence: 'monthly',
      // 35 days back: whatever today's date is, a monthly occurrence has come
      // due, so the first nightly run always has exactly one row to draft.
      anchorDate: addDays(now, -35),
      ...over,
    },
    select: { id: true, anchorDate: true },
  });
}

async function createRow(over: Record<string, unknown> = {}) {
  return prisma.transaction.create({
    data: {
      accountId,
      date: now,
      amountCents: 222_200,
      type: 'expense',
      description: 'ZZDUP row',
      source: 'bank',
      status: 'pending_review',
      ...over,
    },
  });
}

/** The review queue for this account, contract-parsed, filtered to one marker. */
async function queue(q: string) {
  return ReviewQueueResponseSchema.parse(await transactionService.getReviewQueue(accountId, { q }));
}

beforeAll(async () => {
  demoAccountId = await getDemoAccountId();
  const account = await prisma.account.create({
    data: { name: 'Nightly Drafting Co', email: 'jobs@recurringjobs.example', timezone: TZ },
  });
  accountId = account.id;
  const property = await prisma.property.create({
    data: {
      accountId,
      addressLine1: '9 Scheduler Row',
      city: 'Springfield',
      state: 'NY',
      zip: '10000',
    },
  });
  propertyId = property.id;
  // Baseline run: any other account with something due drafts it now, so the
  // counters asserted below belong to this file's templates alone.
  await runDailyJobs();
  const anchor = addDays(now, -35);
  const template = await createTemplate({
    anchorDate: anchor,
    lastDraftedOccurrence: occurrenceOnOrBefore(anchor, 'monthly', now, TZ),
    description: 'ZZDUP mortgage payment (template)',
  });
  stampedTemplateId = template.id;
});

afterAll(async () => {
  await prisma.account.delete({ where: { id: accountId } });
  if (brokenAccountId) await prisma.account.delete({ where: { id: brokenAccountId } });
});

describe('nightly drafting inside runDailyJobs', () => {
  it('drafts a due occurrence once, counts it, and never drafts it again', async () => {
    const template = await createTemplate({ description: 'ZZJOBS monthly service' });

    const first = await runDailyJobs();
    expect(first.recurringDrafted).toBe(1);
    const drafted = await prisma.transaction.findMany({
      where: { recurringTemplateId: template.id },
    });
    expect(drafted).toHaveLength(1);
    expect(drafted[0]).toMatchObject({
      accountId,
      status: 'pending_review',
      source: 'recurring',
      amountCents: 111_100,
    });

    // Second night, same occurrence: nothing new, and the counter says so.
    const second = await runDailyJobs();
    expect(second.recurringDrafted).toBe(0);
    expect(await prisma.transaction.count({ where: { recurringTemplateId: template.id } })).toBe(1);
  });

  it('leaves the seeded demo template alone (its occurrence is already stamped)', async () => {
    expect(
      await prisma.transaction.count({ where: { accountId: demoAccountId, source: 'recurring' } }),
    ).toBe(0);
  });

  it('records a template failure per account without costing that account its other jobs', async () => {
    const account = await prisma.account.create({
      data: { name: 'Broken Template Co', email: 'broken@recurringjobs.example', timezone: TZ },
    });
    brokenAccountId = account.id;
    // A property deleted out from under the template: the drafted row's FK no
    // longer resolves, so drafting throws where the rest of the night must not.
    const template = await prisma.recurringTemplate.create({
      data: {
        accountId: account.id,
        description: 'ZZJOBS orphaned template',
        propertyId: 'property-that-does-not-exist',
        type: 'expense',
        amountCents: 90_000,
        cadence: 'monthly',
        anchorDate: addDays(now, -35),
      },
    });

    const result = await runDailyJobs();
    const errors = result.errors.filter((e) => e.accountId === account.id);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('recurring drafting');
    // Named, because "one template failed" is only actionable if you know which.
    expect(errors[0]?.message).toContain(template.id);
    // …and the account still got its monthly review and its insight refresh.
    expect(
      await prisma.report.findFirst({ where: { accountId: account.id, type: 'monthly_review' } }),
    ).not.toBeNull();
    expect(result.accountsProcessed).toBeGreaterThan(1);
  });
});

describe('the duplicate window a drafted row opens', () => {
  it('flags a drafted row against the bank row for the same payment, in both directions, despite disagreeing vendors', async () => {
    const draftedRow = await createRow({
      amountCents: 386_000,
      date: addDays(now, -1),
      description: 'ZZMTG Mortgage payment — 12 Maple St',
      vendor: 'First Federal Bank',
      source: 'recurring',
      recurringTemplateId: stampedTemplateId,
    });
    const bankRow = await createRow({
      amountCents: 386_000,
      description: 'ZZMTG FIRST FEDERAL BANK MTG PMT 0923',
      vendor: 'FIRST FEDERAL BANK MTG PMT 0923',
      aiSuggestedCategoryId: (
        await prisma.category.findFirstOrThrow({
          where: { name: 'Mortgage Interest', type: 'expense', isSystem: true },
        })
      ).id,
      aiConfidence: 0.92,
    });

    const items = (await queue('ZZMTG')).items;
    expect(items).toHaveLength(2);
    // The bank row names the auto-drafted row (source tells the web which is
    // which)…
    expect(items.find((i) => i.id === bankRow.id)?.possibleDuplicate).toMatchObject({
      transactionId: draftedRow.id,
      source: 'recurring',
    });
    // …and the drafted row names the bank row, so the pair is visible from
    // whichever side the landlord is looking at.
    expect(items.find((i) => i.id === draftedRow.id)?.possibleDuplicate).toMatchObject({
      transactionId: bankRow.id,
      source: 'bank',
    });

    // The double-count this exists to prevent: bulk confirm takes neither.
    const bulk = await transactionService.confirmAllInReview(accountId, { q: 'ZZMTG' });
    expect(bulk).toEqual({ confirmed: 0, skipped: 2 });

    await prisma.transaction.deleteMany({ where: { id: { in: [draftedRow.id, bankRow.id] } } });
  });

  it('does NOT flag two ordinary pending rows at the same amount', async () => {
    const first = await createRow({
      amountCents: 444_400,
      description: 'ZZPAIR HD SUPPLY #443',
      vendor: 'HD Supply',
    });
    const second = await createRow({
      amountCents: 444_400,
      date: addDays(now, -1),
      description: 'ZZPAIR HD SUPPLY #518',
      vendor: 'HD Supply',
    });

    const items = (await queue('ZZPAIR')).items;
    expect(items).toHaveLength(2);
    for (const item of items) expect(item.possibleDuplicate).toBeUndefined();

    await prisma.transaction.deleteMany({ where: { id: { in: [first.id, second.id] } } });
  });

  it('leaves the confirmed-row path exactly as it was', async () => {
    const confirmed = await createRow({
      amountCents: 555_500,
      date: addDays(now, -1),
      description: 'ZZCONF hardware run (logged by hand)',
      source: 'manual',
      status: 'confirmed',
      vendor: null,
    });
    const pending = await createRow({
      amountCents: 555_500,
      description: 'ZZCONF HD SUPPLY #443',
      vendor: 'HD Supply',
    });
    // Vendor absent on one side: still a match, as before.
    expect(
      (await queue('ZZCONF')).items.find((i) => i.id === pending.id)?.possibleDuplicate,
    ).toMatchObject({ transactionId: confirmed.id, source: 'manual' });

    // Vendors that disagree with no template on either side: still suppressed.
    await prisma.transaction.update({
      where: { id: confirmed.id },
      data: { vendor: 'Summit Roofing' },
    });
    expect(
      (await queue('ZZCONF')).items.find((i) => i.id === pending.id)?.possibleDuplicate,
    ).toBeUndefined();

    await prisma.transaction.deleteMany({ where: { id: { in: [confirmed.id, pending.id] } } });
  });
});
