// Maintenance work orders (PRD §5.10, PLAN-MAINTENANCE §3-§5). A work order is
// to an expense what a rent charge is to a deposit: the obligation is recorded
// here, the money is recorded on `Transaction` (via `workOrderId`), and this
// file derives `costCents` at read time from linked confirmed rows — never
// stored, so it can never drift when a linked expense is edited, reclassified,
// refunded, or restated by bank sync (the exact failure contractor stats
// already paid for once, riding a vendor string before `contractorId` landed).
//
// `costCents` reuses `lib/pnl.ts`'s classification semantics byte-identical to
// contractor usage stats (ARCHITECTURE §4): transfers/owner-contributions
// contribute nothing, a refund nets negative, a mortgage `principalCents`
// carve-out is subtracted — confirmed rows only. Batch reads (list) use
// `pnlSums` over one `groupBy(['workOrderId', 'type', 'classification'])`
// query for the whole page (the `Mortgage`/`Contractor` precedent: one query
// per batch, never per row in a loop); the detail view sums `pnlBucket` per
// linked row since it also renders each row's `countedInCost` flag.
//
// Status is stored (lateness/overdue is derived from `dueBy`); transitions are
// validated here, never in a route Zod `.refine()` — chat/MCP compose a flat
// object input schema off the same shared type, and a refined/intersected
// schema serializes to `allOf`, which the Anthropic tool API rejects outright
// (guarded by `tool-schemas.test.ts`).
import {
  TERMINAL_WORK_ORDER_STATUSES,
  type CreateWorkOrderInput,
  type UpdateWorkOrderInput,
  type WorkOrderDetailResponse,
  type WorkOrderFilter,
  type WorkOrderListRow,
  type WorkOrderPriority,
  type WorkOrderSource,
  type WorkOrderStatus,
} from '@hearth/shared';
import type { Prisma, WorkOrder as DbWorkOrder } from '@prisma/client';
import { iso, isoOrNull, wallClockParts } from '../lib/dates';
import { BadRequestError, NotFoundError } from '../lib/errors';
import { pnlBucket, pnlSums } from '../lib/pnl';
import { prisma } from '../lib/prisma';
import { accountTimezone } from './account.service';
import { writeAudit, type AuditActor } from './audit.service';
import { propertyLabel } from './property.service';

const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" of `now` in the account's timezone — these fields are
 *  calendar-date strings throughout, never instants (PLAN-MAINTENANCE §3). */
function todayCalendarDate(tz: string, now: Date = new Date()): string {
  const p = wallClockParts(tz, now);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Whole days between two "YYYY-MM-DD" calendar-date strings (positive when
 *  `to` is later). Both are already local calendar days, so this is a plain
 *  ordinal difference — no timezone lookup needed at this step (the tz only
 *  matters for computing "today" above). */
function daysBetweenCalendarDates(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY_MS);
}

/**
 * Ownership + cross-attribution integrity, mirroring
 * `assertAttributionOwned` in transaction.service: every id must belong to
 * `accountId`, and a unit must sit under the attributed property.
 */
async function assertOwnership(
  accountId: string,
  refs: {
    propertyId?: string;
    unitId?: string | null;
    contractorId?: string | null;
    tenantId?: string | null;
  },
): Promise<void> {
  if (refs.propertyId) {
    const property = await prisma.property.findFirst({
      where: { id: refs.propertyId, accountId },
      select: { id: true },
    });
    if (!property) throw new NotFoundError('property', refs.propertyId);
  }
  if (refs.unitId) {
    const unit = await prisma.unit.findFirst({
      where: { id: refs.unitId, property: { accountId } },
      select: { propertyId: true },
    });
    if (!unit) throw new NotFoundError('unit', refs.unitId);
    if (refs.propertyId && unit.propertyId !== refs.propertyId) {
      throw new BadRequestError('unit does not belong to the attributed property');
    }
  }
  if (refs.contractorId) {
    const contractor = await prisma.contractor.findFirst({
      where: { id: refs.contractorId, accountId },
      select: { id: true },
    });
    if (!contractor) throw new NotFoundError('contractor', refs.contractorId);
  }
  if (refs.tenantId) {
    const tenant = await prisma.tenant.findFirst({
      where: { id: refs.tenantId, accountId },
      select: { id: true },
    });
    if (!tenant) throw new NotFoundError('tenant', refs.tenantId);
  }
}

async function getOwnedRow(accountId: string, id: string): Promise<DbWorkOrder> {
  const row = await prisma.workOrder.findFirst({ where: { id, accountId } });
  if (!row) throw new NotFoundError('work order', id);
  return row;
}

// ── denormalized labels + derived cost, batched for a page of rows ─────────

interface LabelMaps {
  propertyLabelById: Map<string, string>;
  unitLabelById: Map<string, string>;
  contractorNameById: Map<string, string>;
  tenantNameById: Map<string, string>;
}

/** One query per related entity for the whole batch — never per row in a loop. */
async function labelsFor(rows: DbWorkOrder[]): Promise<LabelMaps> {
  const propertyIds = [...new Set(rows.map((r) => r.propertyId))];
  const unitIds = [...new Set(rows.map((r) => r.unitId).filter((id): id is string => !!id))];
  const contractorIds = [
    ...new Set(rows.map((r) => r.contractorId).filter((id): id is string => !!id)),
  ];
  const tenantIds = [...new Set(rows.map((r) => r.tenantId).filter((id): id is string => !!id))];
  const [properties, units, contractors, tenants] = await Promise.all([
    propertyIds.length
      ? prisma.property.findMany({
          where: { id: { in: propertyIds } },
          select: { id: true, nickname: true, addressLine1: true },
        })
      : [],
    unitIds.length
      ? prisma.unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, label: true } })
      : [],
    contractorIds.length
      ? prisma.contractor.findMany({
          where: { id: { in: contractorIds } },
          select: { id: true, name: true },
        })
      : [],
    tenantIds.length
      ? prisma.tenant.findMany({
          where: { id: { in: tenantIds } },
          select: { id: true, fullName: true },
        })
      : [],
  ]);
  return {
    propertyLabelById: new Map(properties.map((p) => [p.id, propertyLabel(p)])),
    unitLabelById: new Map(units.map((u) => [u.id, u.label])),
    contractorNameById: new Map(contractors.map((c) => [c.id, c.name])),
    tenantNameById: new Map(tenants.map((t) => [t.id, t.fullName])),
  };
}

interface CostStats {
  costCents: number;
  linkedTransactionCount: number;
}

/** No standalone exported type for one linked-ledger-row on the detail cost
 *  table — derive it from the response shape's own `costs` array element. */
type WorkOrderCostRow = WorkOrderDetailResponse['costs'][number];

/**
 * Derived cost + link count for a batch of work orders, one pair of queries
 * total (the `Mortgage`/`Contractor` batching precedent). `costCents` sums
 * `pnlSums`'s expense bucket over confirmed linked rows grouped by
 * `[workOrderId, type, classification]` — the same `lib/pnl.ts` semantics as
 * every other money aggregate, never a hand-rolled `groupBy(['type'])` sum.
 * `linkedTransactionCount` counts every linked row regardless of status.
 */
async function costStatsByWorkOrder(
  accountId: string,
  workOrderIds: string[],
): Promise<Map<string, CostStats>> {
  const stats = new Map<string, CostStats>();
  if (workOrderIds.length === 0) return stats;
  const [costGroups, countGroups] = await Promise.all([
    prisma.transaction.groupBy({
      by: ['workOrderId', 'type', 'classification'],
      where: { accountId, status: 'confirmed', workOrderId: { in: workOrderIds } },
      _sum: { amountCents: true, principalCents: true },
    }),
    prisma.transaction.groupBy({
      by: ['workOrderId'],
      where: { accountId, workOrderId: { in: workOrderIds } },
      _count: true,
    }),
  ]);
  const groupsByWorkOrder = new Map<string, typeof costGroups>();
  for (const g of costGroups) {
    const key = g.workOrderId as string;
    const list = groupsByWorkOrder.get(key) ?? [];
    list.push(g);
    groupsByWorkOrder.set(key, list);
  }
  for (const id of workOrderIds) {
    stats.set(id, {
      costCents: pnlSums(groupsByWorkOrder.get(id) ?? []).expenseCents,
      linkedTransactionCount: 0,
    });
  }
  for (const g of countGroups) {
    const id = g.workOrderId as string;
    const existing = stats.get(id) ?? { costCents: 0, linkedTransactionCount: 0 };
    stats.set(id, { ...existing, linkedTransactionCount: g._count });
  }
  return stats;
}

function buildListRow(
  row: DbWorkOrder,
  labels: LabelMaps,
  stats: Map<string, CostStats>,
  today: string,
): WorkOrderListRow {
  const cost = stats.get(row.id) ?? { costCents: 0, linkedTransactionCount: 0 };
  const status = row.status as WorkOrderStatus;
  return {
    id: row.id,
    accountId: row.accountId,
    propertyId: row.propertyId,
    unitId: row.unitId,
    title: row.title,
    description: row.description,
    status,
    priority: row.priority as WorkOrderPriority,
    contractorId: row.contractorId,
    reportedOn: row.reportedOn,
    scheduledFor: row.scheduledFor,
    dueBy: row.dueBy,
    completedOn: row.completedOn,
    quotedCents: row.quotedCents,
    source: row.source as WorkOrderSource,
    tenantId: row.tenantId,
    notes: row.notes,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    archivedAt: isoOrNull(row.archivedAt),
    costCents: cost.costCents,
    linkedTransactionCount: cost.linkedTransactionCount,
    quoteVarianceCents: row.quotedCents != null ? cost.costCents - row.quotedCents : null,
    // Counts to completion, not to today, once the job is finished — a work
    // order completed three days after it was reported must not read "246 days
    // open" eight months later. Found in the browser, not by a test: every
    // fixture asserted an open row, where the two agree.
    daysOpen: daysBetweenCalendarDates(row.reportedOn, row.completedOn ?? today),
    overdue: row.dueBy != null && row.dueBy < today && !TERMINAL_WORK_ORDER_STATUSES.includes(status),
    propertyLabel: labels.propertyLabelById.get(row.propertyId) ?? '',
    unitLabel: row.unitId ? (labels.unitLabelById.get(row.unitId) ?? null) : null,
    contractorName: row.contractorId ? (labels.contractorNameById.get(row.contractorId) ?? null) : null,
    tenantName: row.tenantId ? (labels.tenantNameById.get(row.tenantId) ?? null) : null,
  };
}

async function hydrateOne(accountId: string, row: DbWorkOrder, tz: string): Promise<WorkOrderListRow> {
  const [labels, stats] = await Promise.all([
    labelsFor([row]),
    costStatsByWorkOrder(accountId, [row.id]),
  ]);
  return buildListRow(row, labels, stats, todayCalendarDate(tz));
}

// ── list / detail ────────────────────────────────────────────────────────

export async function list(
  accountId: string,
  filter: WorkOrderFilter = {},
): Promise<WorkOrderListRow[]> {
  const where: Prisma.WorkOrderWhereInput = {
    accountId,
    ...(filter.includeArchived ? {} : { archivedAt: null }),
    ...(filter.priority ? { priority: filter.priority } : {}),
    ...(filter.propertyId ? { propertyId: filter.propertyId } : {}),
    ...(filter.unitId ? { unitId: filter.unitId } : {}),
    ...(filter.contractorId ? { contractorId: filter.contractorId } : {}),
    // openOnly is a cheaper way to say "every non-terminal status" than four
    // repeated status params; an explicit status wins if both are sent.
    ...(filter.status
      ? { status: filter.status }
      : filter.openOnly
        ? { status: { notIn: [...TERMINAL_WORK_ORDER_STATUSES] } }
        : {}),
  };
  const rows = await prisma.workOrder.findMany({ where, orderBy: { createdAt: 'desc' } });
  if (rows.length === 0) return [];
  const tz = await accountTimezone(accountId);
  const today = todayCalendarDate(tz);
  const [labels, stats] = await Promise.all([
    labelsFor(rows),
    costStatsByWorkOrder(accountId, rows.map((r) => r.id)),
  ]);
  const listRows = rows.map((r) => buildListRow(r, labels, stats, today));
  // Open-first ordering: non-terminal work ahead of completed/cancelled: each
  // group keeps the createdAt-desc order above (Array#sort is stable in Node).
  return listRows.sort((a, b) => {
    const aTerminal = TERMINAL_WORK_ORDER_STATUSES.includes(a.status) ? 1 : 0;
    const bTerminal = TERMINAL_WORK_ORDER_STATUSES.includes(b.status) ? 1 : 0;
    return aTerminal - bTerminal;
  });
}

export async function getDetail(accountId: string, id: string): Promise<WorkOrderDetailResponse> {
  const row = await getOwnedRow(accountId, id);
  const tz = await accountTimezone(accountId);
  const today = todayCalendarDate(tz);
  const [labels, linked] = await Promise.all([
    labelsFor([row]),
    prisma.transaction.findMany({
      where: { accountId, workOrderId: id },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
    }),
  ]);
  let costCents = 0;
  const costs: WorkOrderCostRow[] = linked.map((t) => {
    let countedInCost = false;
    if (t.status === 'confirmed') {
      const bucket = pnlBucket({
        type: t.type,
        classification: t.classification,
        amountCents: t.amountCents,
        principalCents: t.principalCents,
      });
      if (bucket && bucket.bucket === 'expense') {
        countedInCost = true;
        costCents += bucket.amountCents;
      }
    }
    return {
      transactionId: t.id,
      date: iso(t.date),
      description: t.description,
      vendor: t.vendor,
      amountCents: t.amountCents,
      countedInCost,
    };
  });
  const stats = new Map<string, CostStats>([[id, { costCents, linkedTransactionCount: linked.length }]]);
  return { ...buildListRow(row, labels, stats, today), costs };
}

// ── create / update / archive / restore ─────────────────────────────────────

export async function create(
  accountId: string,
  input: CreateWorkOrderInput,
  actor: AuditActor = 'user',
): Promise<WorkOrderListRow> {
  await assertOwnership(accountId, {
    propertyId: input.propertyId,
    unitId: input.unitId,
    contractorId: input.contractorId,
    tenantId: input.tenantId,
  });
  const tz = await accountTimezone(accountId);
  // "scheduled" with no date is meaningless; a status omitted alongside a
  // scheduledFor is the "booked the plumber on the call" shortcut.
  const status = input.status ?? (input.scheduledFor ? 'scheduled' : 'open');
  if (status === 'scheduled' && !input.scheduledFor) {
    throw new BadRequestError("status 'scheduled' requires scheduledFor — set one in the same request");
  }
  const completedOn = input.completedOn ?? (status === 'completed' ? todayCalendarDate(tz) : null);
  const row = await prisma.workOrder.create({
    data: {
      accountId,
      propertyId: input.propertyId,
      unitId: input.unitId ?? null,
      title: input.title,
      description: input.description ?? null,
      status,
      priority: input.priority ?? 'normal',
      contractorId: input.contractorId ?? null,
      reportedOn: input.reportedOn ?? todayCalendarDate(tz),
      scheduledFor: input.scheduledFor ?? null,
      dueBy: input.dueBy ?? null,
      completedOn,
      quotedCents: input.quotedCents ?? null,
      source: 'landlord', // not caller-settable in v1 (PLAN-MAINTENANCE §3)
      tenantId: input.tenantId ?? null,
      notes: input.notes ?? null,
    },
  });
  await writeAudit(accountId, {
    actor,
    action: 'work_order.created',
    entityType: 'work_order',
    entityId: row.id,
    detail: { propertyId: row.propertyId, title: row.title, status: row.status },
  });
  // Brand new — nothing can be linked to it yet.
  return buildListRow(
    row,
    await labelsFor([row]),
    new Map([[row.id, { costCents: 0, linkedTransactionCount: 0 }]]),
    todayCalendarDate(tz),
  );
}

export async function update(
  accountId: string,
  id: string,
  input: UpdateWorkOrderInput,
  actor: AuditActor = 'user',
): Promise<WorkOrderListRow> {
  const prior = await getOwnedRow(accountId, id);
  const effective = {
    propertyId: input.propertyId !== undefined ? input.propertyId : prior.propertyId,
    unitId: input.unitId !== undefined ? input.unitId : prior.unitId,
    contractorId: input.contractorId !== undefined ? input.contractorId : prior.contractorId,
    tenantId: input.tenantId !== undefined ? input.tenantId : prior.tenantId,
  };
  if (
    input.propertyId !== undefined ||
    input.unitId !== undefined ||
    input.contractorId !== undefined ||
    input.tenantId !== undefined
  ) {
    await assertOwnership(accountId, effective);
  }

  const tz = await accountTimezone(accountId);
  const status = input.status !== undefined ? input.status : (prior.status as WorkOrderStatus);
  const scheduledFor = input.scheduledFor !== undefined ? input.scheduledFor : prior.scheduledFor;
  if (status === 'scheduled' && !scheduledFor) {
    throw new BadRequestError("status 'scheduled' requires scheduledFor — set one in the same update");
  }

  // completedOn stamps/clears on a transition into/out of 'completed', unless
  // the caller explicitly sent completedOn in this same request (which always
  // wins, including an explicit null clear).
  let completedOn: string | null;
  if (input.completedOn !== undefined) {
    completedOn = input.completedOn;
  } else if (status === 'completed' && prior.status !== 'completed') {
    completedOn = todayCalendarDate(tz);
  } else if (status !== 'completed' && prior.status === 'completed') {
    completedOn = null;
  } else {
    completedOn = prior.completedOn;
  }

  let action = 'work_order.updated';
  if (input.status !== undefined && input.status !== prior.status) {
    if (input.status === 'completed') action = 'work_order.completed';
    else if (input.status === 'cancelled') action = 'work_order.cancelled';
  }

  const row = await prisma.workOrder.update({
    where: { id },
    data: {
      ...(input.propertyId !== undefined ? { propertyId: input.propertyId } : {}),
      ...(input.unitId !== undefined ? { unitId: input.unitId } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.contractorId !== undefined ? { contractorId: input.contractorId } : {}),
      ...(input.reportedOn !== undefined ? { reportedOn: input.reportedOn } : {}),
      ...(input.scheduledFor !== undefined ? { scheduledFor: input.scheduledFor } : {}),
      ...(input.dueBy !== undefined ? { dueBy: input.dueBy } : {}),
      // Always written — it's the derived stamp/clear above even when the
      // request didn't touch status at all (a no-op write in that case).
      completedOn,
      ...(input.quotedCents !== undefined ? { quotedCents: input.quotedCents } : {}),
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
  });
  await writeAudit(accountId, {
    actor,
    action,
    entityType: 'work_order',
    entityId: id,
    detail: { priorStatus: prior.status, status: row.status },
  });
  return hydrateOne(accountId, row, tz);
}

/** Soft-archive. */
export async function remove(accountId: string, id: string, actor: AuditActor = 'user'): Promise<void> {
  await getOwnedRow(accountId, id);
  await prisma.workOrder.update({ where: { id }, data: { archivedAt: new Date() } });
  await writeAudit(accountId, { actor, action: 'work_order.archived', entityType: 'work_order', entityId: id });
}

export async function restore(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<WorkOrderListRow> {
  await getOwnedRow(accountId, id);
  const row = await prisma.workOrder.update({ where: { id }, data: { archivedAt: null } });
  await writeAudit(accountId, { actor, action: 'work_order.restored', entityType: 'work_order', entityId: id });
  return hydrateOne(accountId, row, await accountTimezone(accountId));
}
