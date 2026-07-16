// Seed script (ARCHITECTURE §10). All dates are computed relative to the run
// date so the demo always looks current — re-running the seed refreshes the
// demo clock. Idempotent: wipes and recreates the demo account.
//
// Run: npm run db:seed -w apps/api
import { randomUUID } from 'node:crypto';
import { createStorageAdapter } from '../src/integrations/factory';
import {
  addDays,
  addMonthsToPeriod,
  currentPeriodInTz,
  localMidnightUtc,
  monthStart,
  monthStartInTz,
  periodOf,
  startOfDayInTz,
  trailingPeriods,
  wallClockParts,
} from '../src/lib/dates';
import { renderTextPdf } from '../src/lib/pdf';
import { prisma } from '../src/lib/prisma';
import { slugify } from '../src/lib/strings';
import * as contractorService from '../src/services/contractor.service';
import { sanitizeFilename } from '../src/services/document.service';
import * as insightService from '../src/services/insight.service';
import {
  AVG_TRAILING_NET_CENTS,
  BIRCH_UTILITIES_BY_MONTH_CENTS,
  COLLECTED_MTD_CENTS,
  CONTRACTOR_COUNT,
  CONTRACTOR_EXPECTED_STATS,
  CURRENT_MONTH_EXPENSES,
  contractorHistoryAnchor,
  DEMO_EMAIL,
  DEMO_GRACE_DAYS,
  DEMO_NAME,
  DEMO_TAX_RATE_PCT,
  DEMO_TIMEZONE,
  EXPENSES_MTD_CENTS,
  OKAFOR_DAYS_LATE,
  PARK_DAYS_LATE,
  PARK_NAME,
  PARK_COTENANT_NAME,
  PARK_SHARE_CENTS,
  OKAFOR_NAME,
  RENT_ROLL_CENTS,
  REVIEW_QUEUE_ITEMS,
  SEED_CATEGORIES,
  SEED_CONTRACTORS,
  SEED_DOCUMENTS,
  SEED_PROPERTIES,
  TOTAL_UNITS,
  TRAILING_EXPENSE_TOTALS_CENTS,
  TRAILING_EXTRA_EXPENSES,
  TRAILING_FIXED_EXPENSES,
  expectedInsightDedupeKeys,
  type SeedExpenseSpec,
} from './seed-constants';

function assertEq(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(`Seed self-check failed: ${label} — expected ${expected}, got ${actual}`);
  }
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

async function main(): Promise<void> {
  const now = new Date();
  // WS4: the demo account lives in DEMO_TIMEZONE (America/New_York), and every
  // service now buckets periods/KPIs/rent on that local calendar. The seed
  // pins its month-boundary + days-late math to the same tz so seeded dates
  // land in-month under the tz interpretation and all pinned constants survive
  // (NY local midnight of the 1st = 04/05:00 UTC on the 1st — still the 1st in
  // UTC too, so nothing straddles a boundary either way).
  const period = currentPeriodInTz(DEMO_TIMEZONE, now);
  const currentMonthStart = monthStartInTz(period, DEMO_TIMEZONE);
  const nowParts = wallClockParts(DEMO_TIMEZONE, now);

  // ── wipe (idempotent: cascade delete of the demo account + system categories)
  const existing = await prisma.account.findUnique({ where: { email: DEMO_EMAIL } });
  if (existing) await prisma.account.delete({ where: { id: existing.id } });
  await prisma.category.deleteMany({ where: { isSystem: true } });

  // ── account + categories
  const account = await prisma.account.create({
    data: {
      name: DEMO_NAME,
      email: DEMO_EMAIL,
      timezone: DEMO_TIMEZONE,
      taxRatePct: DEMO_TAX_RATE_PCT,
      graceDays: DEMO_GRACE_DAYS,
    },
  });
  const categoryIds = new Map<string, string>();
  for (const c of SEED_CATEGORIES) {
    const row = await prisma.category.create({
      data: { name: c.name, type: c.type, irsScheduleELine: c.irsScheduleELine, isSystem: true },
    });
    categoryIds.set(c.name, row.id);
  }
  const categoryId = (name: string): string => {
    const id = categoryIds.get(name);
    if (!id) throw new Error(`seed: unknown category ${name}`);
    return id;
  };

  // ── properties / units / tenants / leases
  const propertyIdByKey = new Map<string, string>();
  interface SeededLease {
    leaseId: string;
    unitId: string;
    propertyId: string;
    tenantName: string;
    rentCents: number;
    payment: 'online' | 'manual' | number;
  }
  const leases: SeededLease[] = [];

  for (const spec of SEED_PROPERTIES) {
    const property = await prisma.property.create({
      data: {
        accountId: account.id,
        addressLine1: spec.addressLine1,
        city: spec.city,
        state: spec.state,
        zip: spec.zip,
        acquisitionDate: new Date(Date.UTC(spec.acquisitionYear, 4, 15)),
        acquisitionCostCents: spec.acquisitionCostCents,
      },
    });
    propertyIdByKey.set(spec.key, property.id);

    for (const u of spec.units) {
      const unit = await prisma.unit.create({
        data: {
          propertyId: property.id,
          label: u.label,
          bedrooms: u.bedrooms,
          bathrooms: u.bathrooms,
          marketRentCents: u.marketRentCents,
        },
      });
      const tenant = await prisma.tenant.create({
        data: { accountId: account.id, fullName: u.tenantName, email: u.tenantEmail },
      });
      const startDate = monthStartInTz(addMonthsToPeriod(period, -u.leaseStartMonthsAgo), DEMO_TIMEZONE);
      const lease = await prisma.lease.create({
        data: {
          unitId: unit.id,
          rentCents: u.rentCents,
          dueDay: 1,
          startDate,
          endDate: addDays(startOfDayInTz(now, DEMO_TIMEZONE), u.leaseEndDaysFromToday),
          status: 'active',
          ...(u.esignSigned
            ? { esignEnvelopeId: 'env_mock_seed_okafor', esignStatus: 'signed' }
            : {}),
          leaseTenants: { create: [{ tenantId: tenant.id, isPrimary: true }] },
        },
      });
      leases.push({
        leaseId: lease.id,
        unitId: unit.id,
        propertyId: property.id,
        tenantName: u.tenantName,
        rentCents: u.rentCents,
        payment: u.payment,
      });
    }
  }
  assertEq(leases.length, TOTAL_UNITS, 'unit count');
  assertEq(
    leases.reduce((s, l) => s + l.rentCents, 0),
    RENT_ROLL_CENTS,
    'rent roll',
  );

  // Co-tenant fixture (plan §C4): Park's lease is shared, half the rent each.
  // Park stays primary (tenantName-keyed derivations unchanged); no KPI moves.
  const parkLease = leases.find((l) => l.tenantName === PARK_NAME);
  if (!parkLease) throw new Error('seed: Park lease missing for co-tenant fixture');
  const cotenant = await prisma.tenant.create({
    data: {
      accountId: account.id,
      fullName: PARK_COTENANT_NAME,
      email: `${slugify(PARK_COTENANT_NAME)}@example.com`,
    },
  });
  await prisma.leaseTenant.create({
    data: {
      leaseId: parkLease.leaseId,
      tenantId: cotenant.id,
      isPrimary: false,
      shareCents: PARK_SHARE_CENTS,
    },
  });
  await prisma.leaseTenant.updateMany({
    where: { leaseId: parkLease.leaseId, isPrimary: true },
    data: { shareCents: PARK_SHARE_CENTS },
  });

  const createExpense = async (spec: SeedExpenseSpec, base: Date, amountOverride?: number) => {
    const date = minDate(addDays(base, spec.day - 1), now);
    await prisma.transaction.create({
      data: {
        accountId: account.id,
        propertyId: spec.propertyKey ? (propertyIdByKey.get(spec.propertyKey) ?? null) : null,
        categoryId: categoryId(spec.categoryName),
        date,
        amountCents: amountOverride ?? spec.amountCents,
        type: 'expense',
        description: spec.description,
        vendor: spec.vendor,
        source: 'manual',
        status: 'confirmed',
      },
    });
  };

  const createPaidRent = async (
    lease: SeededLease,
    p: string,
    dueDate: Date,
    paidAt: Date,
    method: 'online' | 'manual',
  ) => {
    const txn = await prisma.transaction.create({
      data: {
        accountId: account.id,
        propertyId: lease.propertyId,
        unitId: lease.unitId,
        categoryId: categoryId('Rent'),
        date: paidAt,
        amountCents: lease.rentCents,
        type: 'income',
        description: `Rent — ${lease.tenantName} — ${p}`,
        source: 'manual',
        status: 'confirmed',
      },
    });
    await prisma.rentPayment.create({
      data: {
        leaseId: lease.leaseId,
        period: p,
        dueDate,
        amountCents: lease.rentCents,
        paidCents: lease.rentCents, // paid in full — deposits sum to the charge
        method,
        status: 'paid',
        paidAt,
        externalRef: method === 'online' ? `pi_mock_seed_${lease.leaseId.slice(-6)}_${p}` : null,
        transactionId: txn.id,
        deposits: {
          create: { transactionId: txn.id, amountCents: lease.rentCents, method, paidAt },
        },
      },
    });
  };

  // ── contractor directory: 6 contractors + synthetic vendor history (§10).
  // History txns run monthly BACKWARDS from contractorHistoryAnchor(now), so
  // every one is in a prior calendar year AND ≥7 full months back — the pinned
  // MTD / trailing-6-month / tax-target figures and insight rules never see
  // them. "Summit Roofing" and "GreenScape Co." deliberately match existing
  // vendor rows (M−1 roof repair; monthly grounds service) so their derived
  // stats blend both; the existing "Apex Handyman" vendor deliberately does
  // NOT match the "Apex Services" contractor.
  const contractorAnchorPeriod = periodOf(contractorHistoryAnchor(now));
  for (const spec of SEED_CONTRACTORS) {
    await prisma.contractor.create({
      data: {
        accountId: account.id,
        name: spec.name,
        trade: spec.trade,
        rating: spec.rating,
        website: spec.website,
      },
    });
    for (let i = 0; i < spec.historyAmountsCents.length; i++) {
      await prisma.transaction.create({
        data: {
          accountId: account.id,
          categoryId: categoryId('Repairs'),
          date: addDays(monthStart(addMonthsToPeriod(contractorAnchorPeriod, -i)), 14),
          amountCents: spec.historyAmountsCents[i] as number,
          type: 'expense',
          description: `${spec.trade} work — ${spec.name}`,
          vendor: spec.name,
          source: 'manual',
          status: 'confirmed',
        },
      });
    }
  }

  // ── trailing 6 full months: full rent roll paid + pinned expense totals
  const trailing = trailingPeriods(period, 7).slice(0, 6); // M−6 … M−1
  for (let i = 0; i < trailing.length; i++) {
    const p = trailing[i] as string;
    const mStart = monthStartInTz(p, DEMO_TIMEZONE);
    for (let j = 0; j < leases.length; j++) {
      const lease = leases[j] as SeededLease;
      const method = lease.payment === 'manual' ? 'manual' : 'online';
      const paidAt = new Date(addDays(mStart, 1).getTime() + j * 3_600_000);
      await createPaidRent(lease, p, mStart, paidAt, method);
    }
    for (const spec of TRAILING_FIXED_EXPENSES) await createExpense(spec, mStart);
    await createExpense(
      {
        categoryName: 'Utilities',
        amountCents: BIRCH_UTILITIES_BY_MONTH_CENTS[i] as number,
        vendor: 'City of Springfield Utilities',
        description: 'Water & electric service',
        propertyKey: 'birch',
        day: 9,
      },
      mStart,
    );
    for (const spec of TRAILING_EXTRA_EXPENSES[i] as SeedExpenseSpec[]) {
      await createExpense(spec, mStart);
    }
  }

  // ── current month: 12 paid (first 2 days; 9 online / 3 manual) + 2 late
  let paidIndex = 0;
  for (const lease of leases) {
    if (typeof lease.payment === 'number') {
      // Late rows get their dueDate pinned to N local days before today so
      // "days late" is exact under the tz-aware tracker regardless of run date
      // (§10, WS4): local midnight of (today − N) in DEMO_TIMEZONE. Building it
      // from the local calendar date (not `now − N×24h`) keeps it robust across
      // DST — calendarDaysBetweenInTz(dueDate, today) then reads exactly N.
      await prisma.rentPayment.create({
        data: {
          leaseId: lease.leaseId,
          period,
          dueDate: localMidnightUtc(
            nowParts.year,
            nowParts.month,
            nowParts.day - lease.payment,
            DEMO_TIMEZONE,
          ),
          amountCents: lease.rentCents,
          status: 'due',
        },
      });
      continue;
    }
    const paidAt = minDate(
      new Date(addDays(currentMonthStart, paidIndex % 2).getTime() + 9 * 3_600_000),
      now,
    );
    await createPaidRent(lease, period, currentMonthStart, paidAt, lease.payment);
    paidIndex++;
  }

  // ── current-month expenses ($3,110 itemized)
  for (const spec of CURRENT_MONTH_EXPENSES) await createExpense(spec, currentMonthStart);

  // ── review queue: 3 pending bank transactions in the last 5 days
  for (const item of REVIEW_QUEUE_ITEMS) {
    await prisma.transaction.create({
      data: {
        accountId: account.id,
        date: addDays(now, -item.daysAgo),
        amountCents: item.amountCents,
        type: 'expense',
        description: item.description,
        vendor: item.vendor,
        source: 'bank',
        status: 'pending_review',
        aiSuggestedCategoryId: categoryId(item.suggestedCategoryName),
        aiConfidence: item.confidence,
      },
    });
  }

  // ── integrations (4 mock rows)
  for (const [type, name] of [
    ['plaid', 'Plaid (bank import)'],
    ['stripe', 'Stripe (rent payments)'],
    ['docusign', 'Docusign (e-sign)'],
    ['email', 'Email (reminders & reports)'],
  ] as const) {
    await prisma.integration.create({
      data: { accountId: account.id, type, name, status: 'mock', scopesJson: '[]' },
    });
  }

  // ── documents (2 placeholder PDFs through the storage adapter)
  // Wiping the account cascade-deletes the Document rows, but storage keys
  // embed each row's cuid (new every seed) — so old mock files accumulate in
  // uploads/ across re-seeds. Harmless (gitignored locally; x-upsert covers
  // real Supabase overwrites) — never a re-run failure.
  const storage = createStorageAdapter();
  const createSeedDocument = async (
    spec: { name: string; type: string },
    entityType: string,
    entityId: string,
  ) => {
    const bytes = renderTextPdf(spec.name, [`Seed document — attached to ${entityType}.`]);
    const row = await prisma.document.create({
      data: {
        accountId: account.id,
        entityType,
        entityId,
        type: spec.type,
        name: spec.name,
        // Placeholder unique key first — the real key embeds the row's cuid.
        storageKey: `pending/${randomUUID()}`,
        mimeType: 'application/pdf',
        sizeBytes: bytes.length,
        uploadedByActor: 'user', // seed data represents the demo user's uploads
      },
    });
    const storageKey = `${account.id}/${row.id}/${sanitizeFilename(spec.name)}`;
    await prisma.document.update({ where: { id: row.id }, data: { storageKey } });
    await storage.put(storageKey, bytes, 'application/pdf');
  };
  const firstPropertyId = propertyIdByKey.get(SEED_PROPERTIES[0]!.key);
  if (!firstPropertyId) throw new Error('seed: first property missing');
  await createSeedDocument(SEED_DOCUMENTS.insurancePolicy, 'property', firstPropertyId);
  const okaforLease = leases.find((l) => l.tenantName === OKAFOR_NAME);
  if (!okaforLease) throw new Error('seed: Okafor lease missing');
  await createSeedDocument(SEED_DOCUMENTS.signedLease, 'lease', okaforLease.leaseId);

  // ── insights (via the real rules) + last month's monthly review
  const created = await insightService.generateInsights(account.id);
  await insightService.generateMonthlyReview(account.id, addMonthsToPeriod(period, -1));

  // ── self-checks against the pinned constants ────────────────────────────────
  const sums = async (from: Date, to: Date) => {
    const grouped = await prisma.transaction.groupBy({
      by: ['type'],
      where: { accountId: account.id, status: 'confirmed', date: { gte: from, lt: to } },
      _sum: { amountCents: true },
    });
    return {
      income: grouped.find((g) => g.type === 'income')?._sum.amountCents ?? 0,
      expense: grouped.find((g) => g.type === 'expense')?._sum.amountCents ?? 0,
    };
  };
  const mtd = await sums(currentMonthStart, addDays(now, 1));
  assertEq(mtd.income, COLLECTED_MTD_CENTS, 'collected MTD');
  assertEq(mtd.expense, EXPENSES_MTD_CENTS, 'expenses MTD');
  let trailingNet = 0;
  for (let i = 0; i < trailing.length; i++) {
    const p = trailing[i] as string;
    const m = await sums(
      monthStartInTz(p, DEMO_TIMEZONE),
      monthStartInTz(addMonthsToPeriod(p, 1), DEMO_TIMEZONE),
    );
    assertEq(m.expense, TRAILING_EXPENSE_TOTALS_CENTS[i] as number, `expenses ${p}`);
    assertEq(m.income, RENT_ROLL_CENTS, `income ${p}`);
    trailingNet += m.income - m.expense;
  }
  assertEq(Math.round(trailingNet / 6), AVG_TRAILING_NET_CENTS, 'avg trailing net');
  const contractorRows = await contractorService.list(account.id);
  assertEq(contractorRows.length, CONTRACTOR_COUNT, 'contractor count');
  for (const row of contractorRows) {
    const expected = CONTRACTOR_EXPECTED_STATS[row.name];
    if (!expected) throw new Error(`Seed self-check failed: unexpected contractor ${row.name}`);
    assertEq(row.jobsCount, expected.jobsCount, `${row.name} jobsCount`);
    assertEq(row.avgCostCents ?? -1, expected.avgCostCents ?? -1, `${row.name} avgCostCents`);
  }
  const keys = expectedInsightDedupeKeys(period);
  for (const key of Object.values(keys)) {
    const found = created.find((c) => c.dedupeKey === key);
    if (!found) throw new Error(`Seed self-check failed: expected insight ${key} was not generated`);
  }
  // The 4th insight is the review-queue card for REVIEW_QUEUE_ITEMS; its
  // dedupeKey carries the newest pending transaction's generated id, so only
  // the prefix is assertable.
  const reviewInsight = created.find((c) =>
    c.dedupeKey.startsWith('transactions_pending_review:'),
  );
  const expectedReviewTitle = `${REVIEW_QUEUE_ITEMS.length} imported transactions are waiting for review`;
  if (!reviewInsight || reviewInsight.title !== expectedReviewTitle) {
    throw new Error(
      `Seed self-check failed: expected review-queue insight titled "${expectedReviewTitle}", got ${reviewInsight ? `"${reviewInsight.title}"` : 'none'}`,
    );
  }
  if (created.length !== 4) {
    throw new Error(
      `Seed self-check failed: expected exactly 4 insights, got ${created.length}: ${created.map((c) => c.dedupeKey).join(', ')}`,
    );
  }

  console.log(
    `Seeded demo account ${DEMO_EMAIL}: ${SEED_PROPERTIES.length} properties, ${TOTAL_UNITS} units, ` +
      `period ${period} (Okafor ${OKAFOR_DAYS_LATE}d late, Park ${PARK_DAYS_LATE}d late), 4 insights, 1 monthly review.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
