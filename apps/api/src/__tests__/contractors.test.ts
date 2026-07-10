// Contractor directory: derived usage stats against the pinned seed constants
// (jobsCount/avgCostCents/lastUsedAt from confirmed expense txns matched by
// vendor name, ARCHITECTURE §4), vendor-match folding across casing/whitespace
// variants, route CRUD with the shared schemas, and audit actor attribution.
// Everything created here is cleaned up so the seeded portfolio stays pristine.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  ContractorDetailResponseSchema,
  ContractorListResponseSchema,
  ContractorSchema,
  LogContractorJobResponseSchema,
} from '@hearth/shared';
import {
  CONTRACTOR_COUNT,
  CONTRACTOR_EXPECTED_STATS,
  SEED_CONTRACTORS,
  contractorHistoryAnchor,
} from '../../prisma/seed-constants';
import { findServiceTool } from '../ai/tools';
import { buildApp } from '../app';
import { addDays, addMonthsToPeriod, currentPeriod, periodOf } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import * as contractorService from '../services/contractor.service';

let app: FastifyInstance;
let accountId: string;

const createdContractorIds: string[] = [];
const createdTransactionIds: string[] = [];

const API = '/api/v1';

beforeAll(async () => {
  app = await buildApp();
  accountId = await getDemoAccountId();
});

afterAll(async () => {
  await prisma.transaction.deleteMany({ where: { id: { in: createdTransactionIds } } });
  await prisma.contractor.deleteMany({ where: { id: { in: createdContractorIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: createdContractorIds } } });
  await app.close();
});

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `${API}${url}`, payload: payload as never });
}

describe('contractorService.list — derived stats equal the pinned seed constants', () => {
  it('returns 6 rows whose jobsCount/avgCostCents match CONTRACTOR_EXPECTED_STATS', async () => {
    const rows = await contractorService.list(accountId);
    expect(rows).toHaveLength(CONTRACTOR_COUNT);
    for (const row of rows) {
      const expected = CONTRACTOR_EXPECTED_STATS[row.name];
      expect(expected, row.name).toBeDefined();
      expect(row.jobsCount, `${row.name} jobsCount`).toBe(expected!.jobsCount);
      expect(row.avgCostCents, `${row.name} avgCostCents`).toBe(expected!.avgCostCents);
    }
  });

  it('Summit Roofing blends the existing M−1 roof repair: 4 jobs, avg 115000, lastUsed previous month', async () => {
    const rows = await contractorService.list(accountId);
    const summit = rows.find((r) => r.name === 'Summit Roofing')!;
    expect(summit.jobsCount).toBe(4);
    expect(summit.avgCostCents).toBe(115000); // (115000+115000+110000+120000)/4
    expect(periodOf(new Date(summit.lastUsedAt!))).toBe(addMonthsToPeriod(currentPeriod(), -1));
  });

  it('GreenScape Co. derives entirely from existing landscaping rows: lastUsed in the current month', async () => {
    const rows = await contractorService.list(accountId);
    const greenscape = rows.find((r) => r.name === 'GreenScape Co.')!;
    expect(greenscape.jobsCount).toBe(7); // 6 trailing fixed + 1 current month
    expect(greenscape.avgCostCents).toBe(31000);
    expect(periodOf(new Date(greenscape.lastUsedAt!))).toBe(currentPeriod());
  });

  it('QuickFix Home has exactly one job at 18500; no-history contractors are 0/null/null', async () => {
    const rows = await contractorService.list(accountId);
    const quickfix = rows.find((r) => r.name === 'QuickFix Home')!;
    expect(quickfix.jobsCount).toBe(1);
    expect(quickfix.avgCostCents).toBe(18500);
    expect(periodOf(new Date(quickfix.lastUsedAt!))).toBe(periodOf(contractorHistoryAnchor()));
  });

  it('list rows carry the seeded website values (bare domains, null where unset)', async () => {
    const rows = ContractorListResponseSchema.parse((await inject('GET', '/contractors')).json());
    for (const spec of SEED_CONTRACTORS) {
      expect(rows.find((r) => r.name === spec.name)!.website, spec.name).toBe(spec.website);
    }
  });

  it('matches vendors case/whitespace-insensitively (folding casing variants into one bucket)', async () => {
    // Same amount as Rivera's history so the pinned avg is unchanged; dated at
    // the history anchor so no pinned MTD/trailing figure moves either.
    const txn = await prisma.transaction.create({
      data: {
        accountId,
        date: contractorHistoryAnchor(),
        amountCents: 21000,
        type: 'expense',
        description: 'Casing-variant plumbing job',
        vendor: '  rivera plumbing ',
        source: 'manual',
        status: 'confirmed',
      },
    });
    createdTransactionIds.push(txn.id);

    const rows = await contractorService.list(accountId);
    const rivera = rows.find((r) => r.name === 'Rivera Plumbing')!;
    expect(rivera.jobsCount).toBe(24); // 23 seeded + the casing variant
    expect(rivera.avgCostCents).toBe(21000);

    // Remove it again so later list assertions see the pristine seed.
    await prisma.transaction.delete({ where: { id: txn.id } });
    createdTransactionIds.splice(createdTransactionIds.indexOf(txn.id), 1);
    const after = await contractorService.list(accountId);
    expect(after.find((r) => r.name === 'Rivera Plumbing')!.jobsCount).toBe(23);
  });
});

describe('GET /contractors/:id — derived job history agrees with the list stats', () => {
  it('Rivera Plumbing: 23 jobs newest-first at 21000 each, stats equal to the list row', async () => {
    const rows = ContractorListResponseSchema.parse((await inject('GET', '/contractors')).json());
    const riveraRow = rows.find((r) => r.name === 'Rivera Plumbing')!;

    const res = await inject('GET', `/contractors/${riveraRow.id}`);
    expect(res.statusCode).toBe(200);
    const detail = ContractorDetailResponseSchema.parse(res.json());

    expect(detail.contractor.id).toBe(riveraRow.id);
    expect(detail.contractor.website).toBe('riveraplumbing.com');
    expect(detail.jobsCount).toBe(23);
    expect(detail.jobs).toHaveLength(23);
    for (const job of detail.jobs) expect(job.amountCents).toBe(21000);
    const dates = detail.jobs.map((j) => new Date(j.date).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
    // Seeded history txns are portfolio-level (no propertyId) → labels null.
    expect(detail.jobs.every((j) => j.propertyLabel === null)).toBe(true);

    // Detail stats derive from the same matched set as the list row —
    // the two surfaces must always agree.
    expect(detail.jobsCount).toBe(riveraRow.jobsCount);
    expect(detail.avgCostCents).toBe(riveraRow.avgCostCents);
    expect(detail.lastUsedAt).toBe(riveraRow.lastUsedAt);
  });

  it('resolves propertyLabel from the transaction propertyId relation', async () => {
    const property = await prisma.property.findFirst({ where: { accountId } });
    expect(property).not.toBeNull();
    // Same amount/date as Rivera's history so no pinned figure moves; deleted
    // again below so later assertions see the pristine seed.
    const txn = await prisma.transaction.create({
      data: {
        accountId,
        propertyId: property!.id,
        date: contractorHistoryAnchor(),
        amountCents: 21000,
        type: 'expense',
        description: 'Property-scoped plumbing job',
        vendor: 'Rivera Plumbing',
        source: 'manual',
        status: 'confirmed',
      },
    });
    createdTransactionIds.push(txn.id);

    const rows = await contractorService.list(accountId);
    const rivera = rows.find((r) => r.name === 'Rivera Plumbing')!;
    const detail = await contractorService.detail(accountId, rivera.id);
    const job = detail.jobs.find((j) => j.id === txn.id)!;
    expect(job.propertyLabel).toBe(property!.nickname ?? property!.addressLine1);

    await prisma.transaction.delete({ where: { id: txn.id } });
    createdTransactionIds.splice(createdTransactionIds.indexOf(txn.id), 1);
    expect((await contractorService.detail(accountId, rivera.id)).jobsCount).toBe(23);
  });

  it('returns the 404 envelope for an unknown id', async () => {
    const res = await inject('GET', '/contractors/nonexistent-contractor-id');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});

describe('contractor routes — CRUD with soft-archive/restore and user attribution', () => {
  it('POST → PATCH → DELETE → restore round-trip, audited with actor user', async () => {
    const createRes = await inject('POST', '/contractors', {
      name: 'Testable Electric',
      trade: 'Electrical',
      rating: 4.2,
      phone: '555-0100',
      email: 'testable@example.com',
      website: 'testableelectric.com',
      notes: 'Created by contractors.test.ts',
    });
    expect(createRes.statusCode).toBe(201);
    const contractor = ContractorSchema.parse(createRes.json());
    createdContractorIds.push(contractor.id);
    expect(contractor.name).toBe('Testable Electric');
    expect(contractor.website).toBe('testableelectric.com');
    expect(contractor.archivedAt).toBeNull();

    const patchRes = await inject('PATCH', `/contractors/${contractor.id}`, { rating: 4.6 });
    expect(patchRes.statusCode).toBe(200);
    expect(ContractorSchema.parse(patchRes.json()).rating).toBe(4.6);

    // Website is free text — a bare domain replaces the old value.
    const websiteRes = await inject('PATCH', `/contractors/${contractor.id}`, {
      website: 'testable-electric.co',
    });
    expect(websiteRes.statusCode).toBe(200);
    expect(ContractorSchema.parse(websiteRes.json()).website).toBe('testable-electric.co');

    // Explicit null clears an optional field; omitted fields stay unchanged.
    const clearRes = await inject('PATCH', `/contractors/${contractor.id}`, {
      phone: null,
      website: null,
    });
    expect(clearRes.statusCode).toBe(200);
    const cleared = ContractorSchema.parse(clearRes.json());
    expect(cleared.phone).toBeNull();
    expect(cleared.website).toBeNull();
    expect(cleared.email).toBe('testable@example.com');

    // No expense history → derived stats are zero/null on the list row.
    const listed = ContractorListResponseSchema.parse((await inject('GET', '/contractors')).json());
    const row = listed.find((r) => r.id === contractor.id)!;
    expect(row.jobsCount).toBe(0);
    expect(row.avgCostCents).toBeNull();
    expect(row.lastUsedAt).toBeNull();

    // Soft-archive hides it from GET /contractors; restore brings it back.
    expect((await inject('DELETE', `/contractors/${contractor.id}`)).statusCode).toBe(204);
    const afterDelete = ContractorListResponseSchema.parse(
      (await inject('GET', '/contractors')).json(),
    );
    expect(afterDelete.some((r) => r.id === contractor.id)).toBe(false);

    // The detail endpoint still serves archived contractors (a restore
    // surface can live there).
    const archivedDetail = await inject('GET', `/contractors/${contractor.id}`);
    expect(archivedDetail.statusCode).toBe(200);
    expect(
      ContractorDetailResponseSchema.parse(archivedDetail.json()).contractor.archivedAt,
    ).not.toBeNull();

    const restoreRes = await inject('POST', `/contractors/${contractor.id}/restore`);
    expect(restoreRes.statusCode).toBe(200);
    expect(ContractorSchema.parse(restoreRes.json()).archivedAt).toBeNull();
    const afterRestore = ContractorListResponseSchema.parse(
      (await inject('GET', '/contractors')).json(),
    );
    expect(afterRestore.some((r) => r.id === contractor.id)).toBe(true);

    for (const action of ['create', 'update', 'archive', 'restore']) {
      const audit = await prisma.auditLog.findFirst({
        where: { accountId, action, entityType: 'contractor', entityId: contractor.id },
      });
      expect(audit?.actor, `${action} audit`).toBe('user');
    }
  });

  it('rejects invalid bodies with the validation envelope', async () => {
    const res = await inject('POST', '/contractors', { name: 'No Trade', rating: 9 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });
});

describe('POST /contractors/:id/jobs — manually log a job (creates a real confirmed expense)', () => {
  it('creates a confirmed expense transaction, audited, and bumps jobsCount', async () => {
    const rows = ContractorListResponseSchema.parse((await inject('GET', '/contractors')).json());
    const rivera = rows.find((r) => r.name === 'Rivera Plumbing')!;
    const jobsCountBefore = rivera.jobsCount;

    // Far outside any seeded history so it can't collide with an existing txn.
    const date = new Date(Date.UTC(2015, 0, 15)).toISOString();
    const res = await inject('POST', `/contractors/${rivera.id}/jobs`, {
      date,
      description: 'Emergency pipe burst repair',
      amountCents: 45000,
    });
    expect(res.statusCode).toBe(200);
    const body = LogContractorJobResponseSchema.parse(res.json());
    expect(body.status).toBe('created');
    if (body.status !== 'created') throw new Error('expected created');
    createdTransactionIds.push(body.job.id);
    expect(body.job.description).toBe('Emergency pipe burst repair');
    expect(body.job.amountCents).toBe(45000);

    const txn = await prisma.transaction.findUnique({
      where: { id: body.job.id },
      include: { category: true },
    });
    expect(txn).not.toBeNull();
    expect(txn!.vendor).toBe('Rivera Plumbing');
    expect(txn!.type).toBe('expense');
    expect(txn!.status).toBe('confirmed');
    expect(txn!.source).toBe('manual');
    // Manually logged jobs land on the Repairs category (Schedule E "Repairs"
    // line), not uncategorized — the lookup must match the system-seeded
    // Repairs row (accountId: null), not just account-owned categories.
    expect(txn!.category?.name).toBe('Repairs');

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, entityType: 'transaction', entityId: body.job.id },
    });
    expect(audit?.action).toBe('transaction.created');
    expect(audit?.actor).toBe('user');

    const detail = await contractorService.detail(accountId, rivera.id);
    expect(detail.jobsCount).toBe(jobsCountBefore + 1);
  });

  it('surfaces a possible duplicate instead of creating when a nearby same-vendor expense exists', async () => {
    const rows = ContractorListResponseSchema.parse((await inject('GET', '/contractors')).json());
    const rivera = rows.find((r) => r.name === 'Rivera Plumbing')!;
    const jobsCountBefore = rivera.jobsCount;

    const res = await inject('POST', `/contractors/${rivera.id}/jobs`, {
      // Rivera's seeded history rows land on `monthStart(anchorPeriod) + 14d`
      // (prisma/seed.ts); use that exact date so it's within the window.
      date: addDays(contractorHistoryAnchor(), 14).toISOString(),
      description: 'Re-logged plumbing visit',
      amountCents: 21000,
    });
    expect(res.statusCode).toBe(200);
    const body = LogContractorJobResponseSchema.parse(res.json());
    expect(body.status).toBe('possible_duplicate');
    if (body.status !== 'possible_duplicate') throw new Error('expected possible_duplicate');
    expect(body.duplicates.length).toBeGreaterThan(0);

    const detail = await contractorService.detail(accountId, rivera.id);
    expect(detail.jobsCount).toBe(jobsCountBefore);
  });

  it('confirmDuplicate: true creates the transaction despite a nearby match', async () => {
    const rows = ContractorListResponseSchema.parse((await inject('GET', '/contractors')).json());
    const rivera = rows.find((r) => r.name === 'Rivera Plumbing')!;
    const jobsCountBefore = rivera.jobsCount;

    const res = await inject('POST', `/contractors/${rivera.id}/jobs`, {
      // Rivera's seeded history rows land on `monthStart(anchorPeriod) + 14d`
      // (prisma/seed.ts); use that exact date so it's within the window.
      date: addDays(contractorHistoryAnchor(), 14).toISOString(),
      description: 'Re-logged plumbing visit (confirmed)',
      amountCents: 21000,
      confirmDuplicate: true,
    });
    expect(res.statusCode).toBe(200);
    const body = LogContractorJobResponseSchema.parse(res.json());
    expect(body.status).toBe('created');
    if (body.status !== 'created') throw new Error('expected created');
    createdTransactionIds.push(body.job.id);

    const detail = await contractorService.detail(accountId, rivera.id);
    expect(detail.jobsCount).toBe(jobsCountBefore + 1);
  });

  it('returns the 404 envelope for an unknown contractor id', async () => {
    const res = await inject('POST', '/contractors/nonexistent-contractor-id/jobs', {
      date: new Date().toISOString(),
      description: 'Some job',
      amountCents: 10000,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('the duplicate window is inclusive at exactly 3 days and excludes 4 days', async () => {
    const rows = ContractorListResponseSchema.parse((await inject('GET', '/contractors')).json());
    const rivera = rows.find((r) => r.name === 'Rivera Plumbing')!;
    const seededDate = addDays(contractorHistoryAnchor(), 14);

    const atBoundary = await inject('POST', `/contractors/${rivera.id}/jobs`, {
      date: addDays(seededDate, 3).toISOString(),
      description: 'Exactly 3 days out',
      amountCents: 21000,
    });
    expect(LogContractorJobResponseSchema.parse(atBoundary.json()).status).toBe(
      'possible_duplicate',
    );

    const pastBoundary = await inject('POST', `/contractors/${rivera.id}/jobs`, {
      date: addDays(seededDate, 4).toISOString(),
      description: 'Exactly 4 days out',
      amountCents: 21000,
    });
    const body = LogContractorJobResponseSchema.parse(pastBoundary.json());
    expect(body.status).toBe('created');
    if (body.status !== 'created') throw new Error('expected created');
    createdTransactionIds.push(body.job.id);
  });

  it('rejects zero/negative amountCents and blank description with the validation envelope', async () => {
    const rows = ContractorListResponseSchema.parse((await inject('GET', '/contractors')).json());
    const rivera = rows.find((r) => r.name === 'Rivera Plumbing')!;

    const zeroAmount = await inject('POST', `/contractors/${rivera.id}/jobs`, {
      date: new Date().toISOString(),
      description: 'Bad amount',
      amountCents: 0,
    });
    expect(zeroAmount.statusCode).toBe(400);
    expect(zeroAmount.json().error.code).toBe('validation_error');

    const negativeAmount = await inject('POST', `/contractors/${rivera.id}/jobs`, {
      date: new Date().toISOString(),
      description: 'Bad amount',
      amountCents: -100,
    });
    expect(negativeAmount.statusCode).toBe(400);
    expect(negativeAmount.json().error.code).toBe('validation_error');

    const blankDescription = await inject('POST', `/contractors/${rivera.id}/jobs`, {
      date: new Date().toISOString(),
      description: '   ',
      amountCents: 10000,
    });
    expect(blankDescription.statusCode).toBe(400);
    expect(blankDescription.json().error.code).toBe('validation_error');
  });
});

describe('create_contractor tool — model/MCP-invoked writes audit as system', () => {
  it('threads the actor through to the audit row', async () => {
    const tool = findServiceTool('create_contractor')!;
    expect(tool.write).toBe(true);
    const created = ContractorSchema.parse(
      await tool.execute(accountId, { name: 'Tool Made Masonry', trade: 'Masonry' }, 'system'),
    );
    createdContractorIds.push(created.id);

    const rows = await prisma.auditLog.findMany({
      where: { accountId, entityType: 'contractor', entityId: created.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('create');
    expect(rows[0]!.actor).toBe('system');
  });
});
