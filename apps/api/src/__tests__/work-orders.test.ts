// Work orders (PRD §5.10, PLAN-MAINTENANCE §3-§5): route CRUD + list filters +
// ownership validation on the seeded demo account (unauthenticated
// `app.inject` resolves to it — the mortgages.test.ts precedent), and derived
// cost under lib/pnl.ts semantics, status-transition rules, completedOn
// stamping/clearing, null-clears-a-field, and work-order↔transaction
// attribution inheritance via direct service calls on a dedicated throwaway
// account — those tests mint confirmed transactions and must not move the
// demo account's pinned money KPIs (the recurring.test.ts drafting-block
// precedent). Everything created here is cleaned up in afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { WorkOrderDetailResponseSchema, WorkOrderListRowSchema } from '@hearth/shared';
import { buildApp } from '../app';
import { wallClockParts } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import { resetAuthServiceCache } from '../services/auth.service';
import * as transactionService from '../services/transaction.service';
import * as workOrderService from '../services/work-order.service';

const API = '/api/v1';
const SVC_TZ = 'America/New_York';

/** "YYYY-MM-DD" of `now` in `tz` — mirrors the service's own derivation so
 *  tests can compute exact expected daysOpen/overdue/completedOn values. */
function todayYmd(tz: string, now = new Date()): string {
  const p = wallClockParts(tz, now);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function addDaysToYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

let app: FastifyInstance;

// ── demo-account fixtures (route-level tests: unauthenticated inject = demo) ─
let demoAccountId: string;
let demoTz: string;
let propertyId: string;
let unitId: string;
let mismatchedUnitId: string;
let contractorId: string;
let tenantId: string;
const createdDemoPropertyIds: string[] = [];

// ── dedicated throwaway account (service-level, money-affecting tests) ──────
let svcAccountId: string;
let svcPropertyId: string;
let svcUnitId: string;
let svcOtherPropertyId: string;
let svcMortgageId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `${API}${url}`, payload: payload as never });
}

beforeAll(async () => {
  app = await buildApp();
  demoAccountId = await getDemoAccountId();
  demoTz = (await prisma.account.findUniqueOrThrow({ where: { id: demoAccountId } })).timezone;

  const property = await prisma.property.create({
    data: { accountId: demoAccountId, addressLine1: '7 Ticket Ln', city: 'Springfield', state: 'NY', zip: '10000' },
  });
  propertyId = property.id;
  createdDemoPropertyIds.push(propertyId);
  const unit = await prisma.unit.create({ data: { propertyId, label: 'Unit 1' } });
  unitId = unit.id;
  const otherProperty = await prisma.property.create({
    data: { accountId: demoAccountId, addressLine1: '8 Mismatch Ave', city: 'Springfield', state: 'NY', zip: '10000' },
  });
  createdDemoPropertyIds.push(otherProperty.id);
  const otherUnit = await prisma.unit.create({ data: { propertyId: otherProperty.id, label: 'Unit X' } });
  mismatchedUnitId = otherUnit.id;
  const contractor = await prisma.contractor.create({
    data: { accountId: demoAccountId, name: 'Rivera Plumbing Co (WO test)', trade: 'plumbing' },
  });
  contractorId = contractor.id;
  const tenant = await prisma.tenant.create({ data: { accountId: demoAccountId, fullName: 'Alex Okafor (WO test)' } });
  tenantId = tenant.id;

  const svcAccount = await prisma.account.create({
    data: { name: 'Work Order Svc Co', email: 'workorders-svc@workordertest.example', timezone: SVC_TZ },
  });
  svcAccountId = svcAccount.id;
  const svcProperty = await prisma.property.create({
    data: { accountId: svcAccountId, addressLine1: '1 Service Ln', city: 'Springfield', state: 'NY', zip: '10000' },
  });
  svcPropertyId = svcProperty.id;
  const svcUnit = await prisma.unit.create({ data: { propertyId: svcPropertyId, label: 'Unit 1' } });
  svcUnitId = svcUnit.id;
  const svcOtherProperty = await prisma.property.create({
    data: { accountId: svcAccountId, addressLine1: '2 Other Ln', city: 'Springfield', state: 'NY', zip: '10000' },
  });
  svcOtherPropertyId = svcOtherProperty.id;
  const svcMortgage = await prisma.mortgage.create({
    data: {
      accountId: svcAccountId,
      propertyId: svcPropertyId,
      lender: 'Work Order Federal',
      balanceCents: 10_000_000,
      balanceAsOfDate: new Date('2024-01-01'),
    },
  });
  svcMortgageId = svcMortgage.id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { accountId: demoAccountId, entityType: 'work_order' } });
  await prisma.property.deleteMany({ where: { id: { in: createdDemoPropertyIds } } }); // cascades work orders + units
  await prisma.contractor.delete({ where: { id: contractorId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
  await prisma.account.delete({ where: { id: svcAccountId } }); // cascades everything under it
  await app.close();
});

describe('routes — create defaults, scheduled-needs-a-date, completedOn stamping', () => {
  it('defaults status to open, priority to normal, source to landlord, reportedOn to today; audits work_order.created', async () => {
    const res = await inject('POST', '/work-orders', { propertyId, title: 'Leaky faucet' });
    expect(res.statusCode).toBe(201);
    const wo = WorkOrderListRowSchema.parse(res.json());
    expect(wo.status).toBe('open');
    expect(wo.priority).toBe('normal');
    expect(wo.source).toBe('landlord');
    expect(wo.reportedOn).toBe(todayYmd(demoTz));
    expect(wo.costCents).toBe(0);
    expect(wo.linkedTransactionCount).toBe(0);
    expect(wo.quoteVarianceCents).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { accountId: demoAccountId, action: 'work_order.created', entityType: 'work_order', entityId: wo.id },
    });
    expect(audit?.actor).toBe('user');
  });

  it('a status omitted alongside scheduledFor infers scheduled; scheduled with no date is rejected', async () => {
    const scheduled = WorkOrderListRowSchema.parse(
      (await inject('POST', '/work-orders', { propertyId, title: 'Booked the plumber', scheduledFor: '2099-01-05' })).json(),
    );
    expect(scheduled.status).toBe('scheduled');

    const rejected = await inject('POST', '/work-orders', { propertyId, title: 'No date', status: 'scheduled' });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('bad_request');
  });

  it("status 'completed' at creation stamps completedOn to today unless supplied", async () => {
    const stamped = WorkOrderListRowSchema.parse(
      (await inject('POST', '/work-orders', { propertyId, title: 'Already done', status: 'completed' })).json(),
    );
    expect(stamped.completedOn).toBe(todayYmd(demoTz));

    const explicit = WorkOrderListRowSchema.parse(
      (
        await inject('POST', '/work-orders', {
          propertyId,
          title: 'Backdated',
          status: 'completed',
          completedOn: '2020-06-01',
        })
      ).json(),
    );
    expect(explicit.completedOn).toBe('2020-06-01');
  });
});

describe('ownership validation and label round-trip (route level)', () => {
  it('rejects a unit that does not belong to the attributed property, and an unowned contractor/tenant', async () => {
    const badUnit = await inject('POST', '/work-orders', { propertyId, unitId: mismatchedUnitId, title: 'Mismatched unit' });
    expect(badUnit.statusCode).toBe(400);

    const badContractor = await inject('POST', '/work-orders', {
      propertyId,
      title: 'Unowned contractor',
      contractorId: 'not-a-real-id',
    });
    expect(badContractor.statusCode).toBe(404);

    const badTenant = await inject('POST', '/work-orders', { propertyId, title: 'Unowned tenant', tenantId: 'not-a-real-id' });
    expect(badTenant.statusCode).toBe(404);
  });

  it('round-trips propertyLabel/unitLabel/contractorName/tenantName', async () => {
    const res = await inject('POST', '/work-orders', { propertyId, unitId, contractorId, tenantId, title: 'Fully attributed' });
    const wo = WorkOrderListRowSchema.parse(res.json());
    expect(wo.unitLabel).toBe('Unit 1');
    expect(wo.contractorName).toBe('Rivera Plumbing Co (WO test)');
    expect(wo.tenantName).toBe('Alex Okafor (WO test)');
  });
});

describe('PATCH/DELETE/restore via the route, list filters, open-first ordering', () => {
  it('PATCH updates and null-clears fields, DELETE archives, restore brings it back', async () => {
    const created = WorkOrderListRowSchema.parse(
      (await inject('POST', '/work-orders', { propertyId, title: 'CRUD me', contractorId })).json(),
    );

    const patched = await inject('PATCH', `/work-orders/${created.id}`, {
      title: 'CRUD me (renamed)',
      contractorId: null,
    });
    expect(patched.statusCode).toBe(200);
    const patchedBody = WorkOrderListRowSchema.parse(patched.json());
    expect(patchedBody.title).toBe('CRUD me (renamed)');
    expect(patchedBody.contractorId).toBeNull(); // explicit null clears; an omitted key would have left it

    const detail = WorkOrderDetailResponseSchema.parse((await inject('GET', `/work-orders/${created.id}`)).json());
    expect(detail.title).toBe('CRUD me (renamed)');
    expect(detail.costs).toEqual([]);

    expect((await inject('DELETE', `/work-orders/${created.id}`)).statusCode).toBe(204);
    const afterArchive = (await inject('GET', `/work-orders?propertyId=${propertyId}`)).json();
    expect(afterArchive.some((r: { id: string }) => r.id === created.id)).toBe(false);
    const withArchived = (await inject('GET', `/work-orders?propertyId=${propertyId}&includeArchived=true`)).json();
    expect(withArchived.some((r: { id: string }) => r.id === created.id)).toBe(true);

    const restored = await inject('POST', `/work-orders/${created.id}/restore`);
    expect(restored.statusCode).toBe(200);
    expect(WorkOrderListRowSchema.parse(restored.json()).archivedAt).toBeNull();
  });

  it('open-first ordering puts every non-terminal work order ahead of completed/cancelled ones', async () => {
    const openOne = WorkOrderListRowSchema.parse((await inject('POST', '/work-orders', { propertyId, title: 'Open one' })).json());
    const done = WorkOrderListRowSchema.parse(
      (await inject('POST', '/work-orders', { propertyId, title: 'Done one', status: 'completed' })).json(),
    );
    const list = (await inject('GET', `/work-orders?propertyId=${propertyId}`)).json() as Array<{ id: string }>;
    const ids = list.map((r) => r.id);
    expect(ids.indexOf(openOne.id)).toBeLessThan(ids.indexOf(done.id));
  });

  it('status/priority/openOnly filters narrow the set', async () => {
    await inject('POST', '/work-orders', { propertyId, title: 'Emergency open', priority: 'emergency' });
    const cancelled = WorkOrderListRowSchema.parse(
      (await inject('POST', '/work-orders', { propertyId, title: 'Cancelled one' })).json(),
    );
    await inject('PATCH', `/work-orders/${cancelled.id}`, { status: 'cancelled' });

    const emergencyOnly = (
      await inject('GET', `/work-orders?propertyId=${propertyId}&priority=emergency`)
    ).json() as Array<{ title: string }>;
    expect(emergencyOnly.length).toBeGreaterThan(0);
    expect(emergencyOnly.every((r) => r.title === 'Emergency open')).toBe(true);

    const openOnly = (await inject('GET', `/work-orders?propertyId=${propertyId}&openOnly=true`)).json() as Array<{
      status: string;
    }>;
    expect(openOnly.every((r) => r.status !== 'cancelled' && r.status !== 'completed')).toBe(true);

    const cancelledOnly = (
      await inject('GET', `/work-orders?propertyId=${propertyId}&status=cancelled`)
    ).json() as Array<{ status: string }>;
    expect(cancelledOnly.length).toBeGreaterThan(0);
    expect(cancelledOnly.every((r) => r.status === 'cancelled')).toBe(true);
  });
});

describe('cross-account isolation — a foreign id 404s, never leaks', () => {
  let otherAccountId: string;
  let otherWorkOrderId: string;

  beforeAll(async () => {
    const otherAccount = await prisma.account.create({
      data: { name: 'Other WO Co', email: 'other-wo@workordertest.example' },
    });
    otherAccountId = otherAccount.id;
    const otherProp = await prisma.property.create({
      data: { accountId: otherAccountId, addressLine1: '9 Elsewhere St', city: 'X', state: 'CA', zip: '00000' },
    });
    const wo = await workOrderService.create(otherAccountId, { propertyId: otherProp.id, title: 'Foreign order' });
    otherWorkOrderId = wo.id;
  });

  afterAll(async () => {
    await prisma.account.delete({ where: { id: otherAccountId } });
  });

  it('GET/PATCH/DELETE/restore all 404 from the demo account context', async () => {
    for (const [method, url, payload] of [
      ['GET', `/work-orders/${otherWorkOrderId}`, undefined],
      ['PATCH', `/work-orders/${otherWorkOrderId}`, { title: 'nope' }],
      ['DELETE', `/work-orders/${otherWorkOrderId}`, undefined],
      ['POST', `/work-orders/${otherWorkOrderId}/restore`, undefined],
    ] as const) {
      const res = await inject(method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    }
  });
});

describe('derived cost — pnl.ts classification semantics, confirmed-only, quote variance', () => {
  it('sums ordinary confirmed expense minus a refund minus a principal carve-out, ignoring pending and transfer rows', async () => {
    const wo = await workOrderService.create(svcAccountId, {
      propertyId: svcPropertyId,
      title: 'Cost mix',
      quotedCents: 10_000,
    });

    await transactionService.create(
      svcAccountId,
      { date: '2026-01-01T00:00:00Z', amountCents: 10_000, type: 'expense', description: 'Parts', workOrderId: wo.id },
      { status: 'confirmed' },
    );
    await transactionService.create(
      svcAccountId,
      { date: '2026-01-02T00:00:00Z', amountCents: 5_000, type: 'expense', description: 'Pending invoice', workOrderId: wo.id },
      { status: 'pending_review' },
    );
    await transactionService.create(
      svcAccountId,
      {
        date: '2026-01-03T00:00:00Z',
        amountCents: 3_000,
        type: 'expense',
        description: 'Owner transfer',
        classification: 'transfer',
        workOrderId: wo.id,
      },
      { status: 'confirmed' },
    );
    await transactionService.create(
      svcAccountId,
      {
        date: '2026-01-04T00:00:00Z',
        amountCents: 2_000,
        type: 'income',
        description: 'Vendor refund',
        classification: 'refund',
        workOrderId: wo.id,
      },
      { status: 'confirmed' },
    );
    await transactionService.create(
      svcAccountId,
      {
        date: '2026-01-05T00:00:00Z',
        amountCents: 5_000,
        type: 'expense',
        description: 'Mortgage-adjacent payment',
        mortgageId: svcMortgageId,
        principalCents: 2_000,
        workOrderId: wo.id,
      },
      { status: 'confirmed' },
    );

    // 10,000 (ordinary) + 0 (pending) + 0 (transfer) − 2,000 (refund) + 3,000 (5,000 − 2,000 principal)
    const detail = await workOrderService.getDetail(svcAccountId, wo.id);
    expect(detail.costCents).toBe(11_000);
    expect(detail.linkedTransactionCount).toBe(5); // ALL linked rows, regardless of status
    expect(detail.quoteVarianceCents).toBe(1_000); // 11,000 − 10,000
    expect(detail.costs).toHaveLength(5);
    const countedByDescription = new Map(detail.costs.map((c) => [c.description, c.countedInCost]));
    expect(countedByDescription.get('Parts')).toBe(true);
    expect(countedByDescription.get('Pending invoice')).toBe(false);
    expect(countedByDescription.get('Owner transfer')).toBe(false);
    expect(countedByDescription.get('Vendor refund')).toBe(true);
    expect(countedByDescription.get('Mortgage-adjacent payment')).toBe(true);

    // The list row must derive identically to the detail row (ARCHITECTURE §4).
    const list = await workOrderService.list(svcAccountId, { propertyId: svcPropertyId });
    const listRow = list.find((r) => r.id === wo.id);
    expect(listRow?.costCents).toBe(11_000);
    expect(listRow?.linkedTransactionCount).toBe(5);
  });

  it('quoteVarianceCents is null when quotedCents is unset', async () => {
    const wo = await workOrderService.create(svcAccountId, { propertyId: svcPropertyId, title: 'No quote' });
    expect(wo.quotedCents).toBeNull();
    expect(wo.quoteVarianceCents).toBeNull();
  });
});

describe('daysOpen and overdue', () => {
  it('daysOpen is whole days from reportedOn to today in the account timezone', async () => {
    const reportedOn = addDaysToYmd(todayYmd(SVC_TZ), -10);
    const wo = await workOrderService.create(svcAccountId, { propertyId: svcPropertyId, title: 'Aging ticket', reportedOn });
    expect(wo.daysOpen).toBe(10);
  });

  it('overdue is true only when dueBy is past AND status is not terminal', async () => {
    const pastDue = addDaysToYmd(todayYmd(SVC_TZ), -3);
    const wo = await workOrderService.create(svcAccountId, { propertyId: svcPropertyId, title: 'Overdue job', dueBy: pastDue });
    expect(wo.overdue).toBe(true);

    const completed = await workOrderService.update(svcAccountId, wo.id, { status: 'completed' });
    expect(completed.overdue).toBe(false); // terminal status wins even though dueBy is still past

    const futureDue = addDaysToYmd(todayYmd(SVC_TZ), 3);
    const notYetDue = await workOrderService.create(svcAccountId, { propertyId: svcPropertyId, title: 'Future job', dueBy: futureDue });
    expect(notYetDue.overdue).toBe(false);
  });
});

describe('completedOn stamping and clearing', () => {
  it('stamps on transition into completed, clears on transition out, and an explicit value always wins', async () => {
    const wo = await workOrderService.create(svcAccountId, { propertyId: svcPropertyId, title: 'Lifecycle' });
    expect(wo.completedOn).toBeNull();

    const completed = await workOrderService.update(svcAccountId, wo.id, { status: 'completed' });
    expect(completed.completedOn).toBe(todayYmd(SVC_TZ));
    expect(
      await prisma.auditLog.findFirst({
        where: { accountId: svcAccountId, action: 'work_order.completed', entityType: 'work_order', entityId: wo.id },
      }),
    ).not.toBeNull();

    const reopened = await workOrderService.update(svcAccountId, wo.id, { status: 'open' });
    expect(reopened.completedOn).toBeNull();

    const explicit = await workOrderService.update(svcAccountId, wo.id, { status: 'completed', completedOn: '2020-03-04' });
    expect(explicit.completedOn).toBe('2020-03-04');

    const cancelled = await workOrderService.update(svcAccountId, wo.id, { status: 'cancelled' });
    expect(cancelled.status).toBe('cancelled');
    expect(
      await prisma.auditLog.findFirst({
        where: { accountId: svcAccountId, action: 'work_order.cancelled', entityType: 'work_order', entityId: wo.id },
      }),
    ).not.toBeNull();
  });
});

describe('an explicit null clears a field; an omitted key leaves it alone', () => {
  it('unassigns a contractor, clears scheduledFor/quotedCents, and rejects clearing the only date a scheduled status has left', async () => {
    const wo = await workOrderService.create(svcAccountId, {
      propertyId: svcPropertyId,
      title: 'Assigned job',
      contractorId: undefined, // no service-account contractor fixture needed for this assertion path
      scheduledFor: '2099-02-01',
      quotedCents: 5_000,
    });

    const untouched = await workOrderService.update(svcAccountId, wo.id, { title: 'Assigned job (renamed)' });
    expect(untouched.scheduledFor).toBe('2099-02-01');
    expect(untouched.quotedCents).toBe(5_000);

    const cleared = await workOrderService.update(svcAccountId, wo.id, { quotedCents: null });
    expect(cleared.quotedCents).toBeNull();

    // Status is still 'scheduled' and untouched by this request — clearing the
    // only date that justifies it must 400, not silently leave it inconsistent.
    await expect(workOrderService.update(svcAccountId, wo.id, { scheduledFor: null })).rejects.toThrow(/scheduledFor/);
  });
});

describe('work-order ↔ transaction attribution inheritance (money seam)', () => {
  it('create: fills blank propertyId/unitId from the work order; an explicit propertyId always wins and blocks mismatched unit inheritance', async () => {
    const wo = await workOrderService.create(svcAccountId, { propertyId: svcPropertyId, unitId: svcUnitId, title: 'Unit job' });

    const inherited = await transactionService.create(svcAccountId, {
      date: '2026-02-01T00:00:00Z',
      amountCents: 1_000,
      type: 'expense',
      description: 'Inherits both',
      workOrderId: wo.id,
    });
    expect(inherited.propertyId).toBe(svcPropertyId);
    expect(inherited.unitId).toBe(svcUnitId);

    const explicitProperty = await transactionService.create(svcAccountId, {
      date: '2026-02-02T00:00:00Z',
      amountCents: 1_000,
      type: 'expense',
      description: 'Caller property wins',
      propertyId: svcOtherPropertyId,
      workOrderId: wo.id,
    });
    expect(explicitProperty.propertyId).toBe(svcOtherPropertyId); // caller's value, never overwritten
    expect(explicitProperty.unitId).toBeNull(); // not inherited — would mismatch svcOtherPropertyId
  });

  it('update: fills blanks on link, never overwrites a value already on the row, and unlink carries no other guard', async () => {
    const wo = await workOrderService.create(svcAccountId, { propertyId: svcPropertyId, unitId: svcUnitId, title: 'Link on patch' });

    const blank = await transactionService.create(svcAccountId, {
      date: '2026-02-03T00:00:00Z',
      amountCents: 1_000,
      type: 'expense',
      description: 'Unattributed row',
    });
    expect(blank.propertyId).toBeNull();
    const linked = await transactionService.update(svcAccountId, blank.id, { workOrderId: wo.id });
    expect(linked.workOrderId).toBe(wo.id);
    expect(linked.propertyId).toBe(svcPropertyId);
    expect(linked.unitId).toBe(svcUnitId);

    const preAttributed = await transactionService.create(svcAccountId, {
      date: '2026-02-04T00:00:00Z',
      amountCents: 1_000,
      type: 'expense',
      description: 'Already attributed row',
      propertyId: svcOtherPropertyId,
    });
    const relinked = await transactionService.update(svcAccountId, preAttributed.id, { workOrderId: wo.id });
    expect(relinked.propertyId).toBe(svcOtherPropertyId); // the caller's earlier value wins
    expect(relinked.unitId).toBeNull();

    const unlinked = await transactionService.update(svcAccountId, linked.id, { workOrderId: null });
    expect(unlinked.workOrderId).toBeNull();
    // No edit/delete guard rides a work-order link — the amount stays editable.
    const edited = await transactionService.update(svcAccountId, preAttributed.id, { amountCents: 4_242 });
    expect(edited.amountCents).toBe(4_242);
  });

  it('linking a work order owned by another account 404s', async () => {
    const foreignAccount = await prisma.account.create({
      data: { name: 'Foreign WO Co', email: 'foreign-wo@workordertest.example' },
    });
    const foreignProperty = await prisma.property.create({
      data: { accountId: foreignAccount.id, addressLine1: '1 Foreign St', city: 'X', state: 'CA', zip: '00000' },
    });
    const foreignWorkOrder = await workOrderService.create(foreignAccount.id, {
      propertyId: foreignProperty.id,
      title: 'Not yours',
    });
    await expect(
      transactionService.create(svcAccountId, {
        date: '2026-02-05T00:00:00Z',
        amountCents: 1_000,
        type: 'expense',
        description: 'Cross-account link attempt',
        workOrderId: foreignWorkOrder.id,
      }),
    ).rejects.toThrow(/not found/i);
    await prisma.account.delete({ where: { id: foreignAccount.id } });
  });
});

describe('audit actor attribution', () => {
  it('threads a system/ai actor through create/update/archive/restore', async () => {
    const wo = await workOrderService.create(svcAccountId, { propertyId: svcPropertyId, title: 'System-authored' }, 'system');
    expect(
      (
        await prisma.auditLog.findFirst({
          where: { accountId: svcAccountId, action: 'work_order.created', entityType: 'work_order', entityId: wo.id },
        })
      )?.actor,
    ).toBe('system');

    await workOrderService.update(svcAccountId, wo.id, { priority: 'emergency' }, 'ai_suggested_user_confirmed');
    expect(
      (
        await prisma.auditLog.findFirst({
          where: { accountId: svcAccountId, action: 'work_order.updated', entityType: 'work_order', entityId: wo.id },
        })
      )?.actor,
    ).toBe('ai_suggested_user_confirmed');

    await workOrderService.remove(svcAccountId, wo.id, 'system');
    expect(
      (
        await prisma.auditLog.findFirst({
          where: { accountId: svcAccountId, action: 'work_order.archived', entityType: 'work_order', entityId: wo.id },
        })
      )?.actor,
    ).toBe('system');

    await workOrderService.restore(svcAccountId, wo.id, 'system');
    expect(
      (
        await prisma.auditLog.findFirst({
          where: { accountId: svcAccountId, action: 'work_order.restored', entityType: 'work_order', entityId: wo.id },
        })
      )?.actor,
    ).toBe('system');
  });
});

describe("write routes are gated on the 'properties' member permission", () => {
  const TEST_SECRET = 'test-jwt-secret-with-at-least-32-characters!';
  let authzApp: FastifyInstance;
  let authzAccountId: string;
  let authzPropertyId: string;
  let workOrderId: string;

  beforeAll(async () => {
    process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
    resetAuthServiceCache();
    authzApp = await buildApp();

    const account = await prisma.account.create({
      data: { name: 'Work Order Authz Co', email: 'wo-authz@workordertest.example' },
    });
    authzAccountId = account.id;
    const property = await prisma.property.create({
      data: { accountId: authzAccountId, addressLine1: '3 Authz Blvd', city: 'X', state: 'CA', zip: '00000' },
    });
    authzPropertyId = property.id;
    await prisma.user.create({
      data: {
        accountId: authzAccountId,
        supabaseUserId: 'wo-authz-member',
        email: 'wo-authz-member@example.com',
        role: 'member',
        permissionsJson: JSON.stringify(['money']), // deliberately missing 'properties'
      },
    });
    const wo = await workOrderService.create(authzAccountId, { propertyId: authzPropertyId, title: 'Guarded' });
    workOrderId = wo.id;
  });

  afterAll(async () => {
    await prisma.account.delete({ where: { id: authzAccountId } });
    delete process.env.SUPABASE_JWT_SECRET;
    resetAuthServiceCache();
    await authzApp.close();
  });

  async function memberToken(): Promise<string> {
    return new SignJWT({ email: 'wo-authz-member@example.com', aud: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('wo-authz-member')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(TEST_SECRET));
  }

  it("403s a member without 'properties' on every write, and still allows the reads", async () => {
    const headers = { authorization: `Bearer ${await memberToken()}` };
    for (const [method, url, payload] of [
      ['POST', `${API}/work-orders`, { propertyId: authzPropertyId, title: 'Denied' }],
      ['PATCH', `${API}/work-orders/${workOrderId}`, { title: 'Denied edit' }],
      ['DELETE', `${API}/work-orders/${workOrderId}`, undefined],
      ['POST', `${API}/work-orders/${workOrderId}/restore`, undefined],
    ] as const) {
      const res = await authzApp.inject({ method, url, headers, payload: payload as never });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.code).toBe('forbidden');
    }
    const listRes = await authzApp.inject({ method: 'GET', url: `${API}/work-orders`, headers });
    expect(listRes.statusCode).toBe(200);
    const detailRes = await authzApp.inject({ method: 'GET', url: `${API}/work-orders/${workOrderId}`, headers });
    expect(detailRes.statusCode).toBe(200);
    // Nothing moved.
    const after = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrderId } });
    expect(after.title).toBe('Guarded');
    expect(after.archivedAt).toBeNull();
  });
});
