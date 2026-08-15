// Maintenance work orders (PRD §5.10, PLAN-MAINTENANCE §3-§4).
//
// The organizing idea: a work order is to an expense what a rent charge is to
// a deposit. An obligation exists before the money moves, the money arrives
// separately, and the link between them is what makes both legible.
//
// `costCents` is therefore **derived**, never stored — summed at read time from
// linked confirmed expense rows under `lib/pnl.ts` classification semantics,
// byte-identical to how contractor stats derive (ARCHITECTURE §4). A stored
// total would drift the moment a linked expense is edited, reclassified as a
// transfer, refunded, or restated by bank sync — the exact failure this
// codebase already paid for once, when contractor stats rode a vendor string.
// `quotedCents` *is* stored, because it is a fact the contractor told the
// landlord, the same reason a mortgage's statement balance is stored.
import { z } from 'zod';
import {
  WorkOrderPrioritySchema,
  WorkOrderSourceSchema,
  WorkOrderStatusSchema,
} from '../enums';
import { CalendarDateSchema } from './recurring';

export const WorkOrderSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  /** Required — one work order is scoped to one property, matching how the ledger attributes money. */
  propertyId: z.string(),
  /** Null for property-level work (roof, grounds, exterior). */
  unitId: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  status: WorkOrderStatusSchema,
  priority: WorkOrderPrioritySchema,
  /** Assignment. Null = unassigned, or the landlord is doing it themself. */
  contractorId: z.string().nullable(),
  // Calendar dates, not instants. "The plumber comes Tuesday" is a claim about
  // the landlord's calendar; serializing it as UTC midnight renders as the day
  // before for every viewer west of UTC. This is the costliest lesson of
  // PLAN-REAL-EQUITY Phase 2b, carried forward deliberately. `createdAt` and
  // `updatedAt` stay instants — they record the row, not the event.
  reportedOn: CalendarDateSchema,
  scheduledFor: CalendarDateSchema.nullable(),
  dueBy: CalendarDateSchema.nullable(),
  completedOn: CalendarDateSchema.nullable(),
  /** What the contractor quoted — a received fact, not a derivation. */
  quotedCents: z.number().int().nullable(),
  source: WorkOrderSourceSchema,
  /** Who reported it / who is affected. Writable in v1 with no portal ("Okafor called about the faucet"). */
  tenantId: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});
export type WorkOrder = z.infer<typeof WorkOrderSchema>;

/** The derived half — never stored, recomputed on every read. */
export const WorkOrderDerivedSchema = z.object({
  /** Σ linked confirmed ordinary expense rows under pnl semantics. 0 when nothing is linked. */
  costCents: z.number().int(),
  /** How many ledger rows back that figure — lets the UI say "across 3 expenses" without a second call. */
  linkedTransactionCount: z.number().int(),
  /** `costCents - quotedCents`; null unless both exist. Positive = over quote. */
  quoteVarianceCents: z.number().int().nullable(),
  /**
   * Whole days from `reportedOn` to `completedOn`, or to today while the job is
   * still unfinished — i.e. how long it was open, not how long ago it started.
   * A completed job must not keep counting.
   */
  daysOpen: z.number().int(),
  /** `dueBy` is past and the status is not terminal. Rendered as text, never colour alone. */
  overdue: z.boolean(),
});

export const WorkOrderListRowSchema = WorkOrderSchema.merge(WorkOrderDerivedSchema).extend({
  /** Denormalized for list rendering — saves the client N lookups. */
  propertyLabel: z.string(),
  unitLabel: z.string().nullable(),
  contractorName: z.string().nullable(),
  tenantName: z.string().nullable(),
});
export type WorkOrderListRow = z.infer<typeof WorkOrderListRowSchema>;

export const WorkOrderListResponseSchema = z.array(WorkOrderListRowSchema);

/** One linked ledger row, shown on the detail page's cost table. */
export const WorkOrderCostRowSchema = z.object({
  transactionId: z.string(),
  date: z.string().datetime(),
  description: z.string(),
  vendor: z.string().nullable(),
  amountCents: z.number().int(),
  /** False for a row excluded from `costCents` (pending, or a transfer/owner-contribution). */
  countedInCost: z.boolean(),
});

export const WorkOrderDetailResponseSchema = WorkOrderListRowSchema.extend({
  costs: z.array(WorkOrderCostRowSchema),
});
export type WorkOrderDetailResponse = z.infer<typeof WorkOrderDetailResponseSchema>;

// POST /work-orders
export const CreateWorkOrderInputSchema = z.object({
  propertyId: z.string(),
  unitId: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  // Omitted → 'open'. A work order that starts life scheduled is legal (you
  // book the plumber on the call), so the field is writable at creation.
  status: WorkOrderStatusSchema.optional(),
  priority: WorkOrderPrioritySchema.optional(),
  contractorId: z.string().optional(),
  /** Omitted → today in the account's timezone. Backdatable: the call came in on Tuesday. */
  reportedOn: CalendarDateSchema.optional(),
  scheduledFor: CalendarDateSchema.optional(),
  dueBy: CalendarDateSchema.optional(),
  completedOn: CalendarDateSchema.optional(),
  quotedCents: z.number().int().min(0).optional(),
  tenantId: z.string().optional(),
  notes: z.string().optional(),
});
export type CreateWorkOrderInput = z.infer<typeof CreateWorkOrderInputSchema>;

// PATCH /work-orders/:id
//
// Every optional attachment is **nullable**, because a `.partial()` schema
// cannot express "remove": omitting a key and clearing it are the same request
// once JSON.stringify drops `undefined`. PLAN-REAL-EQUITY Phase 2b shipped
// exactly that bug — detaching a mortgage reported success and changed
// nothing. It also matters for the AI: `update_work_order` is the only tool
// that can reverse what `create_work_order` sets, and a tool that can assign a
// contractor but never unassign one strands the user (the 2026-08-13
// resolve/undo lesson).
//
// Left as a plain object schema — no `.refine()`. Status-transition rules live
// in work-order.service, because a refined schema serializes to `allOf` with
// no top-level `properties` and the Anthropic tool API rejects the whole tools
// array (guarded by tool-schemas.test.ts).
export const UpdateWorkOrderInputSchema = z.object({
  propertyId: z.string().optional(),
  unitId: z.string().nullable().optional(),
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  status: WorkOrderStatusSchema.optional(),
  priority: WorkOrderPrioritySchema.optional(),
  contractorId: z.string().nullable().optional(),
  reportedOn: CalendarDateSchema.optional(),
  scheduledFor: CalendarDateSchema.nullable().optional(),
  dueBy: CalendarDateSchema.nullable().optional(),
  completedOn: CalendarDateSchema.nullable().optional(),
  quotedCents: z.number().int().min(0).nullable().optional(),
  tenantId: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type UpdateWorkOrderInput = z.infer<typeof UpdateWorkOrderInputSchema>;

// GET /work-orders — filters. `openOnly` is the common case (the list's default
// view) and is cheaper to express here than as four repeated status params.
export const WorkOrderFilterSchema = z.object({
  status: WorkOrderStatusSchema.optional(),
  priority: WorkOrderPrioritySchema.optional(),
  propertyId: z.string().optional(),
  unitId: z.string().optional(),
  contractorId: z.string().optional(),
  openOnly: z.boolean().optional(),
  includeArchived: z.boolean().optional(),
});
export type WorkOrderFilter = z.infer<typeof WorkOrderFilterSchema>;
