// Recurring templates (PLAN-REAL-EQUITY §2/§4, Phase 2b): the service's
// drafting rules, the CRUD routes through the shared schema, and the 'money'
// permission gate.
//
// The drafting tests run on their own throwaway account, not the seeded demo
// one: a drafted row lands in the review queue, and the seed's pinned
// REVIEW_QUEUE_ITEMS count is exactly the kind of figure this feature must not
// move. Everything created here is cleaned up in afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { RecurringTemplateSchema } from '@hearth/shared';
import { buildApp } from '../app';
import { periodOfInTz, wallClockParts } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import { resetAuthServiceCache } from '../services/auth.service';
import * as recurringService from '../services/recurring.service';

const API = '/api/v1';
const TZ = 'America/New_York';
const d = (isoString: string) => new Date(isoString);

let app: FastifyInstance;
/** The seeded demo account — routes resolve to it in demo mode. */
let demoAccountId: string;
/** Fixture account for the drafting tests (its ledger is ours to dirty). */
let accountId: string;
let propertyId: string;
let mortgageId: string;

beforeAll(async () => {
  app = await buildApp();
  demoAccountId = await getDemoAccountId();
  const account = await prisma.account.create({
    data: { name: 'Recurring Co', email: 'recurring@recurringtest.example', timezone: TZ },
  });
  accountId = account.id;
  const property = await prisma.property.create({
    data: { accountId, addressLine1: '5 Standing Order Way', city: 'Springfield', state: 'NY', zip: '10000' },
  });
  propertyId = property.id;
  const mortgage = await prisma.mortgage.create({
    data: {
      accountId,
      propertyId,
      lender: 'Recurring Federal',
      balanceCents: 18_200_000,
      balanceAsOfDate: d('2026-01-01T05:00:00Z'),
    },
  });
  mortgageId = mortgage.id;
});

afterAll(async () => {
  // The demo account survives the suite, so its templates, the rows they
  // drafted and their audit trail all have to go.
  await prisma.auditLog.deleteMany({
    where: { accountId: demoAccountId, entityType: 'recurring_template' },
  });
  const draftedIds = (
    await prisma.transaction.findMany({
      where: { accountId: demoAccountId, source: 'recurring' },
      select: { id: true },
    })
  ).map((t) => t.id);
  await prisma.auditLog.deleteMany({
    where: { accountId: demoAccountId, entityType: 'transaction', entityId: { in: draftedIds } },
  });
  await prisma.transaction.deleteMany({ where: { id: { in: draftedIds } } });
  await prisma.recurringTemplate.deleteMany({ where: { accountId: demoAccountId } });
  // By suffix, not by id: a few tests spin up their own throwaway account so
  // they can assert a whole-account draft count, and a failure mid-test must
  // not leave one behind for the next file's runDailyJobs to sweep.
  await prisma.account.deleteMany({ where: { email: { endsWith: '@recurringtest.example' } } });
  await app.close();
});

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `${API}${url}`, payload: payload as never });
}

/** A template on the fixture account, straight to the DB (no draft-on-create). */
async function seedTemplate(
  overrides: Partial<{
    description: string;
    vendor: string | null;
    propertyId: string | null;
    categoryId: string | null;
    type: string;
    amountCents: number;
    cadence: string;
    anchorDate: Date;
    mortgageId: string | null;
    principalCents: number | null;
    lastDraftedOccurrence: string | null;
    archivedAt: Date | null;
  }> = {},
) {
  return prisma.recurringTemplate.create({
    data: {
      accountId,
      description: 'Standing charge',
      type: 'expense',
      amountCents: 120_000,
      cadence: 'monthly',
      anchorDate: d('2026-01-05T05:00:00Z'),
      ...overrides,
    },
  });
}

describe('routes — round-trip through the shared schema, list, pause/resume', () => {
  it('POST /recurring-templates returns 201 and a RecurringTemplate the contract accepts', async () => {
    const res = await inject('POST', '/recurring-templates', {
      description: 'Landlord insurance',
      vendor: 'Statewide Mutual',
      type: 'expense',
      amountCents: 96_000,
      cadence: 'annual',
      // Future anchor: nothing drafts, so the demo review queue stays as seeded
      // for the rest of this test.
      anchorDate: '2099-03-01',
    });
    expect(res.statusCode).toBe(201);
    const template = RecurringTemplateSchema.parse(res.json());
    expect(template.amountCents).toBe(96_000);
    expect(template.cadence).toBe('annual');
    expect(template.lastDraftedOccurrence).toBeNull();
    // The anchor comes back as the calendar date it went in as — the day the
    // landlord picked, not a zone-shifted instant.
    expect(template.anchorDate).toBe('2099-03-01');
    expect(template.nextOccurrence).toBe('2099-03-01');

    const audit = await prisma.auditLog.findFirst({
      where: {
        accountId: demoAccountId,
        action: 'recurring_template.created',
        entityType: 'recurring_template',
        entityId: template.id,
      },
    });
    expect(audit?.actor).toBe('user');
  });

  it('PATCH edits, DELETE pauses (204, out of the default list), restore resumes', async () => {
    const created = RecurringTemplateSchema.parse(
      (
        await inject('POST', '/recurring-templates', {
          description: 'HOA dues',
          type: 'expense',
          amountCents: 45_000,
          cadence: 'quarterly',
          anchorDate: '2099-01-15',
        })
      ).json(),
    );

    const patched = await inject('PATCH', `/recurring-templates/${created.id}`, {
      amountCents: 47_500,
    });
    expect(patched.statusCode).toBe(200);
    expect(RecurringTemplateSchema.parse(patched.json()).amountCents).toBe(47_500);

    const archiveRes = await inject('DELETE', `/recurring-templates/${created.id}`);
    expect(archiveRes.statusCode).toBe(204);
    const listRes = await inject('GET', '/recurring-templates');
    expect(listRes.statusCode).toBe(200);
    const live = listRes.json().map((r: unknown) => RecurringTemplateSchema.parse(r));
    expect(live.some((t: { id: string }) => t.id === created.id)).toBe(false);

    const withArchived = await inject('GET', '/recurring-templates?includeArchived=true');
    const all = withArchived.json().map((r: unknown) => RecurringTemplateSchema.parse(r));
    const paused = all.find((t: { id: string }) => t.id === created.id);
    expect(paused?.archivedAt).not.toBeNull();
    // A paused template promises nothing, so it reports no next occurrence.
    expect(paused?.nextOccurrence).toBeNull();

    const restoreRes = await inject('POST', `/recurring-templates/${created.id}/restore`);
    expect(restoreRes.statusCode).toBe(200);
    const resumed = RecurringTemplateSchema.parse(restoreRes.json());
    expect(resumed.archivedAt).toBeNull();
    expect(resumed.nextOccurrence).toBe('2099-01-15');
  });

  it('lists non-archived templates createdAt ascending', async () => {
    const first = RecurringTemplateSchema.parse(
      (
        await inject('POST', '/recurring-templates', {
          description: 'Order A',
          type: 'expense',
          amountCents: 1_000,
          cadence: 'monthly',
          anchorDate: '2099-06-01',
        })
      ).json(),
    );
    const second = RecurringTemplateSchema.parse(
      (
        await inject('POST', '/recurring-templates', {
          description: 'Order B',
          type: 'expense',
          amountCents: 2_000,
          cadence: 'monthly',
          anchorDate: '2099-06-02',
        })
      ).json(),
    );
    const ids = (await inject('GET', '/recurring-templates'))
      .json()
      .map((r: { id: string }) => r.id);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
  });
});

describe('the anchor is a calendar date, not an instant', () => {
  // The defect this exists to catch: the client sent "Sep 1" as
  // 2026-09-01T00:00:00Z, which in America/New_York is Aug 31 19:00. The
  // schedule silently became "the 31st" — a month early, with the day then
  // wandering 30/31 as clamping applied, so a confirmed row landed in the wrong
  // month's P&L. Every assertion below is about the 1st.
  it('a template anchored 2026-09-01 on a non-UTC account recurs on the 1st, not the 31st', async () => {
    const created = await recurringService.create(accountId, {
      description: 'Calendar anchor',
      type: 'expense',
      amountCents: 25_000,
      cadence: 'monthly',
      anchorDate: '2026-09-01',
    });
    // Out and back unchanged: the day the landlord picked.
    expect(created.anchorDate).toBe('2026-09-01');
    expect(created.nextOccurrence).toMatch(/-01$/);

    // Persisted as the instant of local midnight in the account's timezone
    // (EDT, UTC−4) — the same anchoring every row it drafts is dated at.
    const stored = await prisma.recurringTemplate.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.anchorDate.toISOString()).toBe('2026-09-01T04:00:00.000Z');
  });

  it('drafts the 1st, in the month the 1st belongs to', async () => {
    // Anchored the 1st of a past month, so draft-on-create produces the row
    // this claim is about. Times are the real clock, so the assertions are on
    // the shape of the occurrence, not on one hard-coded date.
    const created = await recurringService.create(accountId, {
      description: 'Calendar anchor drafting',
      type: 'expense',
      amountCents: 26_000,
      cadence: 'monthly',
      anchorDate: '2026-03-01',
    });
    expect(created.lastDraftedOccurrence).toMatch(/-01$/);

    const row = await prisma.transaction.findFirstOrThrow({
      where: { recurringTemplateId: created.id },
    });
    // Local midnight of the 1st in the account's timezone…
    expect(wallClockParts(TZ, row.date)).toMatchObject({ day: 1, hour: 0, minute: 0 });
    // …and the month the marker names, which is the month the confirmed row
    // will be counted in.
    expect(periodOfInTz(row.date, TZ)).toBe(created.lastDraftedOccurrence!.slice(0, 7));
  });
});

describe('nextOccurrence — derived per cadence in the account timezone', () => {
  it('reports the next date on or after today for monthly, quarterly and annual', async () => {
    // Anchored on the 20th; "today" for the service is the real clock, so the
    // expectation is computed the same way the UI would read it.
    const anchor = d('2026-01-20T05:00:00Z');
    for (const [cadence, monthStep] of [
      ['monthly', 1],
      ['quarterly', 3],
      ['annual', 12],
    ] as const) {
      const template = await seedTemplate({ cadence, anchorDate: anchor, description: `next-${cadence}` });
      const listed = (await recurringService.list(accountId)).find((t) => t.id === template.id);
      expect(listed?.nextOccurrence).toBeTruthy();
      const next = listed!.nextOccurrence as string;
      const [year, month, day] = next.split('-').map(Number);
      // Day-of-month is preserved (January has 31 days, so no clamping here),
      // and the gap from the anchor is a whole number of cadence periods.
      expect(day).toBe(20);
      const monthsFromAnchor = (year! - 2026) * 12 + (month! - 1);
      expect(monthsFromAnchor % monthStep).toBe(0);
      expect(new Date(`${next}T12:00:00Z`).getTime()).toBeGreaterThan(
        Date.now() - 36 * 60 * 60 * 1000,
      );
      // These anchors are already due; leaving them behind would draft rows
      // into the counts the next block asserts.
      await prisma.recurringTemplate.delete({ where: { id: template.id } });
    }
  });
});

describe('draftDue — one row per due occurrence, never a backfill', () => {
  it('drafts the current occurrence as a pending_review recurring row and stamps the marker', async () => {
    const template = await seedTemplate({
      description: 'Lawn service',
      vendor: 'GreenScape',
      propertyId,
      amountCents: 15_000,
      anchorDate: d('2026-03-10T05:00:00Z'),
    });

    const drafted = await recurringService.draftDue(accountId, TZ, d('2026-08-15T12:00:00Z'));
    expect(drafted).toEqual({ drafted: 1, errors: [] });

    const rows = await prisma.transaction.findMany({ where: { recurringTemplateId: template.id } });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe('pending_review');
    expect(row.source).toBe('recurring');
    expect(row.amountCents).toBe(15_000);
    expect(row.description).toBe('Lawn service');
    expect(row.vendor).toBe('GreenScape');
    expect(row.propertyId).toBe(propertyId);
    // Dated at local midnight of the occurrence in the account's timezone.
    expect(row.date.toISOString()).toBe('2026-08-10T04:00:00.000Z');

    expect(
      (await prisma.recurringTemplate.findUniqueOrThrow({ where: { id: template.id } }))
        .lastDraftedOccurrence,
    ).toBe('2026-08-10');

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, entityType: 'transaction', entityId: row.id, action: 'transaction.created' },
    });
    expect(audit?.actor).toBe('system');
    expect(JSON.parse(audit!.detailJson as string)).toMatchObject({
      source: 'recurring',
      recurringTemplateId: template.id,
      occurrence: '2026-08-10',
    });
  });

  it('is idempotent: a second run at the same moment creates nothing', async () => {
    const template = await seedTemplate({ description: 'Idempotent', anchorDate: d('2026-02-08T05:00:00Z') });
    const now = d('2026-08-15T12:00:00Z');

    expect((await recurringService.draftDue(accountId, TZ, now)).drafted).toBeGreaterThanOrEqual(1);
    const afterFirst = await prisma.transaction.count({ where: { recurringTemplateId: template.id } });
    expect(afterFirst).toBe(1);

    await recurringService.draftDue(accountId, TZ, now);
    expect(await prisma.transaction.count({ where: { recurringTemplateId: template.id } })).toBe(1);
  });

  it('does not re-draft an occurrence whose row the user dismissed', async () => {
    // The marker records the occurrence, not the row: a dismissal is a decision
    // and must survive the next nightly run.
    const template = await seedTemplate({ description: 'Dismissed', anchorDate: d('2026-02-12T05:00:00Z') });
    const now = d('2026-08-20T12:00:00Z');
    await recurringService.draftDue(accountId, TZ, now);
    const row = await prisma.transaction.findFirstOrThrow({
      where: { recurringTemplateId: template.id },
    });
    await prisma.transaction.update({ where: { id: row.id }, data: { status: 'dismissed' } });

    await recurringService.draftDue(accountId, TZ, now);
    expect(await prisma.transaction.count({ where: { recurringTemplateId: template.id } })).toBe(1);
    expect(
      (await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } })).status,
    ).toBe('dismissed');
  });

  it('drafts nothing while the anchor is still in the future', async () => {
    const template = await seedTemplate({ description: 'Not started', anchorDate: d('2027-01-05T05:00:00Z') });
    await recurringService.draftDue(accountId, TZ, d('2026-08-15T12:00:00Z'));
    expect(await prisma.transaction.count({ where: { recurringTemplateId: template.id } })).toBe(0);
  });

  it('drafts nothing while paused, and resuming after six months backfills nothing', async () => {
    const template = await seedTemplate({ description: 'Paused', anchorDate: d('2026-01-03T05:00:00Z') });
    await recurringService.remove(accountId, template.id);

    // Six months pass.
    for (const now of ['2026-03-15', '2026-05-15', '2026-07-15']) {
      await recurringService.draftDue(accountId, TZ, d(`${now}T12:00:00Z`));
    }
    expect(await prisma.transaction.count({ where: { recurringTemplateId: template.id } })).toBe(0);

    await recurringService.restore(accountId, template.id);
    expect(
      (await recurringService.draftDue(accountId, TZ, d('2026-08-15T12:00:00Z'))).drafted,
    ).toBeGreaterThanOrEqual(1);
    const rows = await prisma.transaction.findMany({ where: { recurringTemplateId: template.id } });
    expect(rows).toHaveLength(1); // one row, not six
    expect(rows[0]!.date.toISOString()).toBe('2026-08-03T04:00:00.000Z');
  });

  it('a mortgage template stamps mortgageId and principalCents onto the drafted row', async () => {
    const template = await seedTemplate({
      description: 'Mortgage payment',
      vendor: 'Recurring Federal',
      propertyId,
      amountCents: 240_000,
      mortgageId,
      principalCents: 80_000,
      anchorDate: d('2026-04-01T04:00:00Z'),
    });
    await recurringService.draftDue(accountId, TZ, d('2026-08-15T12:00:00Z'));
    const row = await prisma.transaction.findFirstOrThrow({
      where: { recurringTemplateId: template.id },
    });
    expect(row.mortgageId).toBe(mortgageId);
    expect(row.principalCents).toBe(80_000);
    expect(row.status).toBe('pending_review');

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { accountId, entityType: 'transaction', entityId: row.id },
    });
    expect(JSON.parse(audit.detailJson as string)).toMatchObject({
      principalCents: 80_000,
      mortgageId,
    });
  });

  it('drafts on create when this period’s occurrence has already passed (D2)', async () => {
    // Anchored on the 1st of a past month, so the current occurrence is due the
    // moment the template is saved — the feature has to visibly do something.
    const created = await recurringService.create(accountId, {
      description: 'Draft on create',
      type: 'expense',
      amountCents: 33_000,
      cadence: 'monthly',
      anchorDate: '2026-01-01',
    });
    expect(created.lastDraftedOccurrence).not.toBeNull();
    const rows = await prisma.transaction.findMany({ where: { recurringTemplateId: created.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending_review');
    expect(rows[0]!.source).toBe('recurring');

    // And the sweep does not double it.
    await recurringService.draftDue(accountId, TZ, new Date());
    expect(await prisma.transaction.count({ where: { recurringTemplateId: created.id } })).toBe(1);
  });
});

describe('the marker is monotonic — a schedule edit never backfills a closed month', () => {
  it('moving the anchor day forward drafts nothing for the period it skipped', async () => {
    // Anchored the 5th, this month's occurrence already drafted and confirmed.
    const template = await seedTemplate({
      description: 'Anchor moved forward',
      anchorDate: d('2026-01-05T05:00:00Z'),
      lastDraftedOccurrence: '2026-08-05',
    });
    // Mid-month, the landlord moves the charge to the 20th. "Currently due" now
    // computes as JULY 20 — a month that has closed and been reported on.
    await recurringService.update(accountId, template.id, { anchorDate: '2026-08-20' });
    await recurringService.draftDue(accountId, TZ, d('2026-08-13T12:00:00Z'));
    expect(await prisma.transaction.count({ where: { recurringTemplateId: template.id } })).toBe(0);
    expect(
      (await prisma.recurringTemplate.findUniqueOrThrow({ where: { id: template.id } }))
        .lastDraftedOccurrence,
    ).toBe('2026-08-05');

    // The 20th arrives and it drafts exactly once — the edit is respected going
    // forward, it just can't reach backwards.
    await recurringService.draftDue(accountId, TZ, d('2026-08-20T12:00:00Z'));
    const rows = await prisma.transaction.findMany({
      where: { recurringTemplateId: template.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date.toISOString()).toBe('2026-08-20T04:00:00.000Z');
  });

  it('widening the cadence backfills nothing either', async () => {
    // monthly → annual on a January anchor: "currently due" jumps seven months
    // back to the January occurrence, which was drafted and closed long ago.
    const widened = await seedTemplate({
      description: 'Cadence widened',
      anchorDate: d('2026-01-15T05:00:00Z'),
      lastDraftedOccurrence: '2026-08-15',
    });
    await recurringService.update(accountId, widened.id, { cadence: 'annual' });
    await recurringService.draftDue(accountId, TZ, d('2026-08-16T12:00:00Z'));
    expect(await prisma.transaction.count({ where: { recurringTemplateId: widened.id } })).toBe(0);
  });

  it('nor does the account moving timezone', async () => {
    // Its own account, because this sweep runs the whole account under a
    // different zone. Ten hours further west, an anchor stored at New York's
    // midnight on the 1st reads as the previous month's last day.
    const account = await prisma.account.create({
      data: { name: 'Relocated Co', email: 'relocated@recurringtest.example', timezone: TZ },
    });
    try {
      const moved = await prisma.recurringTemplate.create({
        data: {
          accountId: account.id,
          description: 'Timezone moved',
          type: 'expense',
          amountCents: 50_000,
          cadence: 'monthly',
          anchorDate: d('2026-08-01T04:00:00Z'),
          lastDraftedOccurrence: '2026-08-01',
        },
      });
      const result = await recurringService.draftDue(
        account.id,
        'Pacific/Honolulu',
        d('2026-08-16T12:00:00Z'),
      );
      expect(result).toEqual({ drafted: 0, errors: [] });
      expect(await prisma.transaction.count({ where: { recurringTemplateId: moved.id } })).toBe(0);
    } finally {
      await prisma.account.delete({ where: { id: account.id } });
    }
  });
});

describe('an explicit null clears a field; an omitted key leaves it alone', () => {
  it('detaching the mortgage clears the principal too, and stops stamping it', async () => {
    const template = await seedTemplate({
      description: 'Detachable mortgage',
      propertyId,
      amountCents: 240_000,
      mortgageId,
      principalCents: 80_000,
      anchorDate: d('2026-06-25T04:00:00Z'),
    });

    const detached = await recurringService.update(accountId, template.id, { mortgageId: null });
    // Principal without a mortgage is not a valid row, and a stale attachment
    // would keep stamping principal onto every draft — each confirmation paying
    // down a loan this payment no longer belongs to.
    expect(detached.mortgageId).toBeNull();
    expect(detached.principalCents).toBeNull();
    const stored = await prisma.recurringTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(stored.mortgageId).toBeNull();
    expect(stored.principalCents).toBeNull();

    await recurringService.draftDue(accountId, TZ, d('2026-08-26T12:00:00Z'));
    const row = await prisma.transaction.findFirstOrThrow({
      where: { recurringTemplateId: template.id },
    });
    expect(row.mortgageId).toBeNull();
    expect(row.principalCents).toBeNull();
  });

  it('rejects a patch that clears the mortgage while naming a principal', async () => {
    const template = await seedTemplate({
      description: 'Contradictory detach',
      amountCents: 240_000,
      mortgageId,
      principalCents: 80_000,
      anchorDate: d('2099-02-05T05:00:00Z'),
    });
    await expect(
      recurringService.update(accountId, template.id, { mortgageId: null, principalCents: 50_000 }),
    ).rejects.toThrow(/principal is only meaningful against a mortgage/);
    // Nothing moved on disk.
    const after = await prisma.recurringTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.mortgageId).toBe(mortgageId);
    expect(after.principalCents).toBe(80_000);
  });

  it('clears vendor, property and category on null, and leaves omitted keys alone', async () => {
    const category = await prisma.category.findFirstOrThrow({
      where: { isSystem: true, type: 'expense' },
    });
    const template = await seedTemplate({
      description: 'Clearable',
      vendor: 'Statewide Mutual',
      propertyId,
      categoryId: category.id,
      anchorDate: d('2099-02-05T05:00:00Z'),
    });

    // Omission is not a clear: a patch that only touches the amount leaves the
    // rest exactly where it was.
    const amountOnly = await recurringService.update(accountId, template.id, {
      amountCents: 130_000,
    });
    expect(amountOnly).toMatchObject({
      amountCents: 130_000,
      vendor: 'Statewide Mutual',
      propertyId,
      categoryId: category.id,
    });

    const cleared = await recurringService.update(accountId, template.id, {
      vendor: null,
      propertyId: null,
      categoryId: null,
    });
    expect(cleared).toMatchObject({
      vendor: null,
      propertyId: null,
      categoryId: null,
      // Untouched by the clear.
      description: 'Clearable',
      amountCents: 130_000,
    });
  });
});

describe('one failing template never costs the others their night', () => {
  it('drafts every healthy sibling, counts them, and reports the failure', async () => {
    // Its own account: the count below is the whole account's, and it has to be
    // exactly the two rows that could be written.
    const account = await prisma.account.create({
      data: { name: 'Sibling Co', email: 'siblings@recurringtest.example', timezone: TZ },
    });
    try {
      const template = (description: string, over: Record<string, unknown> = {}) =>
        prisma.recurringTemplate.create({
          data: {
            accountId: account.id,
            description,
            type: 'expense',
            amountCents: 50_000,
            cadence: 'monthly',
            anchorDate: d('2026-05-18T04:00:00Z'),
            ...over,
          },
        });
      const first = await template('Sibling A');
      // A property deleted out from under it: the row it drafts carries an FK
      // that no longer resolves, so this one throws where the others must not.
      const broken = await template('Sibling broken', {
        propertyId: 'property-that-does-not-exist',
      });
      const last = await template('Sibling B');

      const result = await recurringService.draftDue(
        account.id,
        TZ,
        d('2026-08-18T12:00:00Z'),
      );
      // The failure is the SECOND template: the count must survive it and the
      // third must still be reached.
      expect(result.drafted).toBe(2);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.templateId).toBe(broken.id);
      expect(result.errors[0]?.message).toBeTruthy();

      for (const id of [first.id, last.id]) {
        expect(await prisma.transaction.count({ where: { recurringTemplateId: id } })).toBe(1);
      }
      // The failed claim rolled back with its row, so tomorrow can retry it.
      expect(
        (await prisma.recurringTemplate.findUniqueOrThrow({ where: { id: broken.id } }))
          .lastDraftedOccurrence,
      ).toBeNull();
    } finally {
      await prisma.account.delete({ where: { id: account.id } });
    }
  });
});

describe('validation lives in the service, so no adapter can bypass it', () => {
  const base = {
    description: 'Validation',
    type: 'expense' as const,
    amountCents: 200_000,
    cadence: 'monthly' as const,
    anchorDate: '2099-01-05',
  };

  it('rejects principalCents without a mortgageId', async () => {
    await expect(
      recurringService.create(accountId, { ...base, principalCents: 50_000 }),
    ).rejects.toThrow(/principal is only meaningful against a mortgage/);
  });

  it('rejects principalCents on an income template', async () => {
    await expect(
      recurringService.create(accountId, {
        ...base,
        type: 'income',
        mortgageId,
        principalCents: 50_000,
      }),
    ).rejects.toThrow(/only an expense transaction/);
  });

  it('rejects principalCents greater than the amount', async () => {
    await expect(
      recurringService.create(accountId, { ...base, mortgageId, principalCents: 200_001 }),
    ).rejects.toThrow(/between \$0 and the payment itself/);
  });

  it('rejects a non-positive amount', async () => {
    await expect(recurringService.create(accountId, { ...base, amountCents: 0 })).rejects.toThrow(
      /more than \$0/,
    );
  });

  it('rejects a mortgage, property, unit or category belonging to another account', async () => {
    const foreignProperty = await prisma.property.findFirstOrThrow({
      where: { accountId: demoAccountId },
    });
    const foreignUnit = await prisma.unit.findFirstOrThrow({
      where: { property: { accountId: demoAccountId } },
    });
    const foreignCategory = await prisma.category.create({
      data: { accountId: demoAccountId, name: 'Foreign Only', type: 'expense', isSystem: false },
    });
    const foreignMortgage = await prisma.mortgage.create({
      data: {
        accountId: demoAccountId,
        propertyId: foreignProperty.id,
        lender: 'Elsewhere Bank',
        balanceCents: 1_000_000,
        balanceAsOfDate: d('2026-01-01T05:00:00Z'),
      },
    });

    await expect(
      recurringService.create(accountId, { ...base, propertyId: foreignProperty.id }),
    ).rejects.toThrow(/not found/);
    await expect(
      recurringService.create(accountId, { ...base, unitId: foreignUnit.id }),
    ).rejects.toThrow(/not found/);
    await expect(
      recurringService.create(accountId, { ...base, categoryId: foreignCategory.id }),
    ).rejects.toThrow(/not found/);
    await expect(
      recurringService.create(accountId, { ...base, mortgageId: foreignMortgage.id }),
    ).rejects.toThrow(/not found/);

    await prisma.mortgage.delete({ where: { id: foreignMortgage.id } });
    await prisma.category.delete({ where: { id: foreignCategory.id } });
    // Nothing was persisted by the rejected creates.
    expect(
      await prisma.recurringTemplate.count({ where: { accountId, description: 'Validation' } }),
    ).toBe(0);
  });

  it('an amount edit revalidates the stored principal', async () => {
    const template = await recurringService.create(accountId, {
      ...base,
      mortgageId,
      principalCents: 80_000,
    });
    await expect(
      recurringService.update(accountId, template.id, { amountCents: 70_000 }),
    ).rejects.toThrow(/between \$0 and the payment itself/);
    // Unchanged on disk.
    expect(
      (await prisma.recurringTemplate.findUniqueOrThrow({ where: { id: template.id } })).amountCents,
    ).toBe(200_000);
  });
});

describe('cross-account isolation — a foreign id 404s, never leaks', () => {
  it('404s on PATCH, DELETE and restore of another account’s template', async () => {
    const foreign = await seedTemplate({ description: 'Foreign template' });
    for (const [method, url, payload] of [
      ['PATCH', `/recurring-templates/${foreign.id}`, { amountCents: 1 }],
      ['DELETE', `/recurring-templates/${foreign.id}`, undefined],
      ['POST', `/recurring-templates/${foreign.id}/restore`, undefined],
    ] as const) {
      const res = await inject(method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    }
    // Untouched.
    const after = await prisma.recurringTemplate.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(after.amountCents).toBe(120_000);
    expect(after.archivedAt).toBeNull();
  });

  it('list never returns another account’s templates', async () => {
    const foreign = await seedTemplate({ description: 'Not yours' });
    const ids = (await recurringService.list(demoAccountId)).map((t) => t.id);
    expect(ids).not.toContain(foreign.id);
  });
});

describe("write routes are gated on the 'money' member permission", () => {
  const TEST_SECRET = 'test-jwt-secret-with-at-least-32-characters!';
  let authzApp: FastifyInstance;
  let authzAccountId: string;
  let templateId: string;

  beforeAll(async () => {
    process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
    resetAuthServiceCache();
    authzApp = await buildApp();

    const account = await prisma.account.create({
      data: { name: 'Recurring Authz Co', email: 'recurring-authz@recurringtest.example' },
    });
    authzAccountId = account.id;
    await prisma.user.create({
      data: {
        accountId: authzAccountId,
        supabaseUserId: 'recurring-authz-member',
        email: 'recurring-authz-member@example.com',
        role: 'member',
        permissionsJson: JSON.stringify(['properties']), // deliberately missing 'money'
      },
    });
    const template = await prisma.recurringTemplate.create({
      data: {
        accountId: authzAccountId,
        description: 'Guarded template',
        type: 'expense',
        amountCents: 100_000,
        cadence: 'monthly',
        anchorDate: d('2099-01-05T05:00:00Z'),
      },
    });
    templateId = template.id;
  });

  afterAll(async () => {
    await prisma.account.delete({ where: { id: authzAccountId } });
    delete process.env.SUPABASE_JWT_SECRET;
    resetAuthServiceCache();
    await authzApp.close();
  });

  async function memberToken(): Promise<string> {
    return new SignJWT({ email: 'recurring-authz-member@example.com', aud: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('recurring-authz-member')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(TEST_SECRET));
  }

  it("403s a member without 'money' on every write, and still allows the read", async () => {
    // A guard missing from PATCH/DELETE/restore is exactly as bad as one missing
    // from POST, and each is a separate registration.
    const headers = { authorization: `Bearer ${await memberToken()}` };
    for (const [method, url, payload] of [
      [
        'POST',
        `${API}/recurring-templates`,
        {
          description: 'Denied',
          type: 'expense',
          amountCents: 1_000,
          cadence: 'monthly',
          anchorDate: '2099-01-05',
        },
      ],
      ['PATCH', `${API}/recurring-templates/${templateId}`, { amountCents: 2_000 }],
      ['DELETE', `${API}/recurring-templates/${templateId}`, undefined],
      ['POST', `${API}/recurring-templates/${templateId}/restore`, undefined],
    ] as const) {
      const res = await authzApp.inject({ method, url, headers, payload: payload as never });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.code).toBe('forbidden');
    }
    // Reads stay open to any member.
    const listRes = await authzApp.inject({ method: 'GET', url: `${API}/recurring-templates`, headers });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().map((r: unknown) => RecurringTemplateSchema.parse(r))).toHaveLength(1);
    // Nothing moved.
    const after = await prisma.recurringTemplate.findUniqueOrThrow({ where: { id: templateId } });
    expect(after.amountCents).toBe(100_000);
    expect(after.archivedAt).toBeNull();
  });
});
