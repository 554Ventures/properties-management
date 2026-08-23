# PLAN-MAINTENANCE.md — Work Orders

*Authored 2026-08-13 from WHATS_NEXT §4 "Maintenance / work orders — no home in the app", which asks for a design pass against PRD scope before scheduling. **PRD amendment A1 ratified 2026-08-14 (D1) — maintenance is approved scope and Phase 1 is unblocked.** D2/D3 (status depth, priority levels) should be settled before the shared enums ship.*

## 1. Overview & goals

An independent landlord's week is rent and repairs. The app models rent to the cent — materialized charges, partial deposits, per-tenant shares, grace periods, late fees — and models repairs not at all. A request arrives (tenant calls, landlord notices a stain on a ceiling), and the only trace it can ever leave is an expense weeks later, attributed to a property but not a unit, described as whatever the bank descriptor said.

The organizing idea, and the reason this fits the existing architecture rather than fighting it:

> **A work order is to an expense what a rent charge is to a deposit.** An obligation exists before the money moves; the money arrives separately, from the bank or by hand; a link between them is what makes both legible. The app already has the whole apparatus for the income side — open charges, a manual "Link to rent…" picker, unlinked-deposit nudges, `linkSource` provenance, derived paid/remaining. The expense side has nothing to link *to*. This adds the missing noun.

Three concrete payoffs, each of which is already a filed gap:

1. **Per-unit maintenance cost becomes real by construction.** A work order carries `unitId`; a linked expense inherits it. This is the standing answer to the "expense `unitId` is never populated" observation (WHATS_NEXT §4, 2026-08-13 MCP gap analysis) — attribution arrives as a by-product of a workflow the landlord already wants, instead of as a field the app nags about. Note that `logJob` today takes only `propertyId` (contractor.service.ts, `logJob`), so the app's one first-class maintenance write cannot record a unit at all.
2. **The nav stops over-promising.** `navItems.ts:27` ships a nav item labelled **"Maintenance"** whose only destination is `/maintenance/contractors` — a rolodex. The section promises a workflow and delivers a contact list.
3. **The contractor directory gets a subject.** Job history derives from `Transaction.contractorId` and answers "who did I pay, how much" (ARCHITECTURE §4, contractor usage stats). It cannot answer "what was it for" or "is anything outstanding with them right now".

**What this is not:** no new money aggregates. Cost derives from the existing confirmed ledger through `lib/pnl.ts`; nothing in this plan touches P&L, NOI, cashflow, tax set-aside, or Schedule E, and no report changes. That is the deliberate contrast with PLAN-REAL-EQUITY, whose whole risk surface was the `pnl.ts` ripple. Repairs already flow to Schedule E via the seeded `Repairs` / `Cleaning & Maintenance` categories; this plan adds a *workflow* record above the ledger, never a second source of financial truth.

## 2. PRD scope reckoning — the question WHATS_NEXT asked

Answering plainly, because the answer is not "yes it's in scope":

- **PRD §4 (information architecture)** — the nav table has eight rows. None is Maintenance.
- **PRD §5 (feature specifications)** — no maintenance/work-order/repair-workflow section exists. §5.6 names *repairs* only as a Schedule E line ("per-property rents/repairs/other/net"), i.e. as money already spent.
- **PRD §8 (data model)** — eleven v1 entities. No work order, no contractor. (`Contractor` shipped anyway.)
- **PRD §14 (phasing)** — absent from Phase 1, 2, and 3.
- **PRD §11 (tenant-portal forward-compatibility)** names three v1 decisions kept deliberately ready for the portal: `Tenant` as its own entity, `RentPayment`'s method/processor split, `Lease`'s e-sign ref. **Maintenance requests are not among them** — yet WHATS_NEXT §4's tenant-portal item scopes the portal as "pay rent, **maintenance requests**, view/sign lease". The portal as currently scoped depends on a landlord-side record that was never designed.

So: **this is a scope extension, not a gap in an approved plan.** The honest precedent is that `/maintenance/contractors` also shipped with no PRD backing — which is exactly how the app arrived at a nav item pointing at a rolodex. Repeating that pattern for a five-state workflow entity, an enum-bearing shared contract, and four AI tools would be a larger unratified commitment.

**Recommendation (D1): ratify first, then build** — a PRD amendment adding §5.10 (Maintenance), one `WorkOrder` row to the §8 table, and a fourth §11 forward-compatibility bullet. The amendment is small because this plan deliberately keeps v1 landlord-only; the point is that the portal's dependency becomes visible in the document that governs the portal.

## 3. Data model

Conventions per `schema.prisma`'s header: no Prisma `enum` (shared Zod enums back String columns), no `Decimal`, integer cents, `accountId` + cuid on root entities, soft-archive via `archivedAt`, compound index for archived filtering. Reference model: `Mortgage` (schema.prisma:175-199).

**`WorkOrder`** (new root model)

- `id`, `accountId`, `propertyId` (FK, Cascade) — **required**; `unitId String?` (FK, SetNull) — null for roof/grounds/exterior work
- `title String`, `description String?`
- `status String` — new enum `WorkOrderStatus`: `open | scheduled | in_progress | completed | cancelled` (§4)
- `priority String` — new enum `WorkOrderPriority`: `emergency | normal | low` (§4)
- `contractorId String?` (FK → Contractor, SetNull) — assignment; null = unassigned or self-performed
- `reportedOn String`, `scheduledFor String?`, `dueBy String?`, `completedOn String?` — **`YYYY-MM-DD` calendar dates, regex-validated in the shared contract, not `DateTime`.** This is the load-bearing lesson of PLAN-REAL-EQUITY Phase 2b: "the plumber comes Tuesday" is a claim about the landlord's calendar, not an instant, and an anchor serialized as UTC midnight renders as the day before for every viewer west of UTC. The web app's `formatCalendarDate` exists for exactly these values. `createdAt`/`updatedAt` stay instants — they record the row, not the event.
- `quotedCents Int?` — a figure the contractor *told* the landlord. Storable for the same reason `Mortgage.balanceCents` is: it is a received fact, not a derivation. Actual cost is never stored (§4).
- `source String` — new enum `WorkOrderSource`: `landlord | tenant`. **v1 only ever writes `landlord`**; the column exists so the portal is additive (§7 D4).
- `tenantId String?` (FK → Tenant, SetNull) — who reported it / who is affected. Writable in v1 without any portal ("Okafor called about the faucet").
- `notes String?`, `createdAt`, `updatedAt`, `archivedAt DateTime?`
- `@@index([accountId, status])`, `@@index([accountId, propertyId, archivedAt])`, `@@index([accountId, contractorId])`

**One work order is scoped to one property.** Annual gutter cleaning across three properties is three work orders — matching how the ledger attributes money, and keeping derived per-property/per-unit cost unambiguous.

**`Transaction` — one additive nullable column**

- `workOrderId String?` (FK → WorkOrder, SetNull, indexed). This is the entire money seam.

**Shared contract** (`packages/shared/src/schemas/work-order.ts`, new): `WorkOrderSchema`, `CreateWorkOrderInputSchema`, `UpdateWorkOrderInputSchema`, `WorkOrderListRowSchema` (carrying the derived fields of §4), `WorkOrderDetailResponseSchema`. Three new enums in `enums.ts`. `DocumentEntityTypeSchema` (enums.ts:144-151) gains `'work_order'`. `transaction.ts` gains optional `workOrderId` on the Transaction shape, `CreateTransactionInput`, `UpdateTransactionInput`, and `ConfirmTransactionInput` — extension, never change.

**Two deliberate non-fields.**

- *No trade/work category.* The ledger `Category` already classifies the money (`Repairs`, `Cleaning & Maintenance`) and the assigned contractor already carries `trade`. A third taxonomy would drift from both.
- *No comment thread.* v1 ships a single `notes` string. A portal needs a real thread; it arrives as an additive `WorkOrderNote` child table. Do **not** pre-build it as an append-to-string, which would have to be migrated out.

## 4. The linchpin: a work order is not a ledger row, and its cost is derived

**Decision: `WorkOrder` is a root entity; `Transaction.workOrderId` is many-to-one; `costCents` is derived at read time from confirmed, ordinary expense rows, never stored.**

Derived on `WorkOrderListRow` / detail, all via existing rules:

- `costCents` = Σ `amountCents` of linked transactions that are **confirmed**, `type: 'expense'`, and ordinary under `lib/pnl.ts` semantics (a `transfer`/`owner_contribution` row contributes nothing; a `refund` nets negative; a `principalCents` carve-out subtracts) — byte-identical to the contractor-stats rule (ARCHITECTURE §4). A pending row in the review queue contributes nothing, exactly as it contributes nothing to any other aggregate.
- `quoteVarianceCents` = `costCents − quotedCents` when both exist. This is the figure a landlord actually wants and cannot get anywhere today.
- `daysOpen` from `reportedOn`; `overdue` = `dueBy` in the past and status not terminal. Rendered as text, never colour alone.

**Rejected alternatives:**

1. **Store `actualCostCents` on the work order.** Rejected — this is precisely the failure the app already paid for once: contractor stats rode a vendor string until the `contractorId` FK landed (2026-08-03), because a stored/re-derived-from-text total silently rewrote itself. A stored sum drifts the moment a linked expense is edited, deleted, reclassified as a transfer, refunded, or restated by bank sync, and it would force `lib/pnl.ts`'s semantics to be reimplemented on a second surface.
2. **Model the work order as a `Transaction` with a maintenance status.** Rejected — a work order exists *before* money moves and may never cost anything (the landlord fixes the faucet themself). And `Transaction.status` is a review-queue state machine (`pending_review | confirmed | dismissed`); overloading it with a maintenance lifecycle breaks every ledger filter in both apps.
3. **One-to-one work order ↔ transaction.** Rejected — a real job is a deposit, a final invoice, and a hardware-store run. Many-to-one from the start; one-to-one cannot be widened without a data migration.
4. **Reuse `Transaction.contractorId` alone, no new link.** Rejected — contractor attribution answers "who did I pay", which is a different question from "what was this for". Rivera Plumbing doing three jobs a year produces one undifferentiated history.

**Status is stored, lateness is derived** — the `RentPayment` precedent exactly (stored status; `late`/`partial`/`daysLate` derived). `in_progress` and `cancelled` have no date proxy, and "I've done it" is a statement only the user can make, so a fully-derived status would be wrong. Transitions are validated in `work-order.service`, **not** in a route Zod refine, because a chat/MCP tool must compose a flat object input schema — a refined/intersected schema serializes to `allOf` and the Anthropic tool API rejects the entire tools array, breaking every chat turn (guarded by `src/__tests__/tool-schemas.test.ts`; the Phase-1 mortgage lesson).

**Linking inherits attribution, and only fills blanks.** Linking a transaction to a work order sets the transaction's `propertyId`/`unitId` from the work order in the same write — the exact pattern `confirmWithRentLink` already uses to stamp property/unit + Rent category from a lease (transaction.service.ts:1367, attribution at :1442-1443). A value the user has already set is never overwritten. This is what makes payoff #1 automatic.

**No edit/delete guards on a work-order-linked row.** Rent links carry guards because linking flips a `RentPayment` to paid — an invariant an edit can break. A work-order link is pure attribution: change the amount and the derived cost simply recomputes. Deliberately asymmetric; a reader will ask.

## 5. API, permissions, and the AI surface

**Permission area: `requirePermission('properties')`, and no seventh `MemberPermission`.**

This matches the existing precedent verbatim — `routes/contractors.ts:13` gates the whole directory on `properties` with the comment "the maintenance directory is part of property operations" — and matches the document write map (property/unit/lease → `properties`). Against adding a `maintenance` area: `MemberPermission` (enums.ts:123-131) is a live contract consumed by the Team UI, `deniedWriteTools`, and every existing member's stored `permissionsJson`; a new value is a seventh checkbox on a product with a two-seat cap, and every current member would silently lack it.

The money-touching step keeps riding `money` through the existing transaction guard, which yields a genuinely useful split: **a member with `properties` but not `money` can run maintenance and cannot spend.** That is a feature, and it is the strongest argument against folding both halves under one new area.

> **Live gap this surfaces, independent of this feature.** `POST /contractors/:id/jobs` is gated on `properties` (routes/contractors.ts:41) and creates a **confirmed expense** through `transactionService.create` (contractor.service.ts, `logJob`). A member granted `properties` and denied `money` can therefore write to the ledger today. See D5 — the recommendation is to re-gate it regardless of whether this plan ships.

**Routes** (`routes/work-orders.ts`, registered in `app.ts` alongside the others):

- `GET /work-orders` — filters `status`, `priority`, `propertyId`, `unitId`, `contractorId`; open-first ordering · `GET /work-orders/:id` (archived still viewable, contractor-detail precedent) — both ungated reads
- `POST /work-orders` · `PATCH /work-orders/:id` · `DELETE /work-orders/:id` (soft-archive) · `POST /work-orders/:id/restore` — all `properties`
- **No `POST /work-orders/:id/expense`.** Cost linking rides `POST /transactions` / `PATCH /transactions/:id` / `POST /transactions/:id/confirm` with `workOrderId`, under their existing `money` guard. A dedicated route would be a second money-write path outside that guard — the precise shape of the `logJob` gap above.
- Every write audits (`work_order.created`, `work_order.updated`, `work_order.completed`, `work_order.cancelled`, `work_order.archived`) with the actor threaded through.

**AI tools** (`ai/tools.ts`; MCP inherits automatically):

- Reads: `list_work_orders` (same filters), `get_work_order` (derived cost, linked transactions, documents). Extend `get_contractor`'s description to mention assigned open work orders.
- Writes: `create_work_order`, `update_work_order` — both `WRITE_TOOL_PERMISSIONS: 'properties'`. Two writes, not five: assignment, scheduling, priority, and status all move through `update_work_order`, with transition rules in the service where chat and REST share them.
- **Reversibility, per the 2026-08-13 resolve/undo lesson** ("the registry is a strict subset of REST" — the assistant could create obligations it could not clear): every state these tools can reach must be reachable back out. `update_work_order` moves status in both directions, and its clearable fields (`contractorId`, `scheduledFor`, `dueBy`, `unitId`, `quotedCents`) **accept `null`** — a `.partial()` schema cannot express "remove", since omitting a key and clearing it are the same request once `JSON.stringify` drops `undefined` (Phase 2b lesson 6, where a detached mortgage reported success and changed nothing).
- Action-card allowlist (`components/chat/actionAllowlist.ts`): `POST /work-orders`, `PATCH /work-orders/{id}`. No DELETE, per the standing archive/restore exclusion; lookalike-path negatives in `src/test/actionAllowlist.test.ts`; the system prompt's action-card catalog updated in the same change.
- Mock mode: one deterministic script (`/maintenance|repair|work order/i` → `list_work_orders` + a `data_table` of open items) plus a matching composer suggested prompt, so the offline demo stays honest.

## 6. UI surfaces

The doctrine is hub-in-place: this must live where the landlord already looks, not on a page they must remember to visit.

1. **`/maintenance`** — new index; the nav item's `to` moves here from `/maintenance/contractors`, with Work orders and Contractors as sibling tabs. Work-order list with status/priority/property filters, open-first, create modal. Mobile-fit idioms per the 2026-07-11 table conventions (filters in a focus-trapped bottom sheet, `RowActions` collapse).
2. **`/maintenance/:id`** — detail: status/assignment/schedule controls, quote vs. derived actual with variance, linked-cost table, `DocumentsCard` (photos of the leak, the invoice), notes. Write controls behind `can('properties')`, including while permissions load.
3. **Property hub "Needs attention"** — open work orders join late rent, expiring leases, and vacancies in the derived triage card. Emergency and overdue first. This is the single highest-value surface in the plan.
4. **UnitDetail** — unit work-order history beside the existing unit P&L; the records room finally records repairs.
5. **ContractorDetail** — assigned open work orders above the derived job history: "what's outstanding with them" beside "what I've paid them".
6. **Review queue + transaction edit modal** — a **"Link to work order…"** picker on expense rows, deliberately mirroring the income side's "Link to rent…" picker (open work orders, newest first). The Money ledger marks linked rows "part of work order", mirroring "applied to rent".

## 7. Phased delivery

Sequencing throughout: shared schema → migration → service/routes/tools → frontend.

**Phase 1 — the record and its money seam.** Shared schemas + three enums + `'work_order'` on `DocumentEntityType`; migration `add_work_orders` (one table, one nullable `Transaction` column — fully additive); `work-order.service.ts` (accountId-first, audited, ownership-checked) + routes; derived cost/variance/overdue; attribution inheritance on link; the four tools + allowlist entries + mock script; `/maintenance` index + detail; the link picker in the review queue and edit modal; seed.

**Phase 2 — ambient surfacing.** Property-hub triage rows; UnitDetail and ContractorDetail cross-links; ledger marker; and **two** insight rules, bounded hard against noise:
- `work_order_emergency_open` — an `emergency` work order open past 24h → `warning`, navigate action.
- `work_order_stale` — non-emergency work orders open past 14 days with no `scheduledFor` → `info`, **one card naming the count**, never one card per order. This must copy the `transactions_pending_review` living-count lifecycle (ARCHITECTURE §4 rule 6): the `dedupeKey` carries the newest qualifying id so a dismissal sticks only until something new qualifies, the count refreshes in place, and the card auto-resolves to `actioned` when the list empties. A monthly-keyed dedupe would make a dismissal outlive the problem.

**No push in Phases 1–2.** The landlord created the record; notifying them of their own write is noise. The first genuine trigger is a tenant-submitted emergency, which needs the portal.

**Phase 3 — tenant-submitted requests** *(gated on the tenant portal, D4; not scheduled here)*: `source: 'tenant'` writes, the `WorkOrderNote` thread, emergency push via the existing `notifyCategory` fan-out.

**Seed** — link **existing** seeded Repairs/Cleaning expense rows (Rivera Plumbing, GreenScape Co.) to two completed work orders, plus one open and one scheduled carrying no cost. **Zero new Transaction rows**, so every pinned money KPI in `seed-constants.ts` holds — the Phase-1 mortgage precedent. Named traps:
- The Phase-2 insight rules must not fire on seed data, or the dashboard deck count and pinned insight assertions move. Seed the open order recent, non-emergency, and under the stale threshold — or repin deliberately, knowing why.
- Contractor `jobsCount`/`avgCostCents` derive from `contractorId`, **not** `workOrderId`, so linking existing rows must leave them untouched. Assert it rather than assuming it.
- New pinned constants: `WORK_ORDER_OPEN_COUNT`, `WORK_ORDER_MAPLE_COST_CENTS`.

**Tests** — `work-orders.test.ts` (service + routes via `app.inject()`, audit attribution, cross-account isolation, status-transition rules, derived cost under every `pnl.ts` classification), `work-order-tools.test.ts` (registry flags, `deniedWriteTools` gating, `system` actor, null-clearing, MCP roundtrip), the `mcp.test.ts` write-gating list, `tool-schemas.test.ts` flat-schema invariant, plus web component + axe tests for the new pages and the link picker.

## 8. Risks & open product decisions

**Risks**

- **Scope creep into a CMMS.** Every property tool grows recurring schedules, inspection checklists, tenant chat, and vendor bidding. The persona is one person with 9 properties and a day job. Two guard rails: the entity carries no field that isn't on a shipped surface, and cost is never stored — so the ledger stays the single financial truth.
- **Abandoned records.** A to-do list nobody closes becomes a stale list that erodes trust in every other derived count. The stale-work-order insight is the mitigation, and it is also the thing most likely to become noise — hence the living-count lifecycle and the 14-day floor, both worth revisiting on real usage.
- **Two ways to record a repair** (`logJob` and a work order) until D5 is decided. Same double-path trust risk the recurring-template duplicate defense exists to handle, minus the money duplication.
- **`unitId` back-attribution.** Inheritance only helps rows linked *after* this ships; existing property-level expenses stay unit-less. Deliberately no bulk back-fill — guessing a unit from a bank descriptor is the fabrication the app refuses everywhere else.

**Open decisions for the owner (do not proceed on these silently)**

1. ~~**D1 — PRD amendment (blocking)**~~ — **RATIFIED 2026-08-14 by the owner.** Amendment **A1** is live in [PRD.md](PRD.md) (see its Amendment log): maintenance is approved product scope — §4 IA row, §5.10 feature spec, §8 `WorkOrder` + `Contractor` rows, §11 forward-compatibility bullet, §14 Phase 2. `Contractor` was ratified alongside `WorkOrder`, since ratifying the new entity while leaving the shipped one unratified would have repeated the very gap this plan names. **Phase 1 is unblocked.** Two things ratification deliberately did *not* do: it approves **scope, not this technical design** (the model, enums, permission area, and phasing remain this document's to get right, and D2/D3 below are still open); and it *surfaces but does not resolve* three further §4 drifts (retired Tenants & Leases, retired AI Insights, added Documents), because quietly rewriting that table would erase that its "core usability contract" was overridden four times. That reconciliation is its own pass.
2. **D2 — Status depth.** Five states (`open | scheduled | in_progress | completed | cancelled`) or three (`open | completed | cancelled`, with scheduled-ness derived from `scheduledFor`)? Five is proposed; three is defensible and cheaper to widen later than to narrow.
3. **D3 — Priority levels.** Three (`emergency | normal | low`) or the industry-conventional four? Three is proposed: for a 14-unit portfolio the only distinction that changes behavior is "drop everything", and a high-vs-normal choice with no behavioral consequence is a field that gets filled in at random.
4. **D4 — Tenant-facing half.** v1 already lets the landlord record *who* reported an issue (`tenantId`) with no portal. Does the notification/thread half wait for the portal (plan's default), or is a "notify the tenant it's scheduled" email worth shipping standalone off the existing Cloudflare Email adapter?
5. ~~**D5 — the `logJob` permission gap**~~ — **FIXED 2026-08-13**, shipped independently of this plan on `fix/log-job-money-guard`, since it was a live gap rather than a design question. `POST /contractors/:id/jobs` now carries `requirePermission('money')`: its effect is a confirmed ledger row, so it is gated by the permission that governs the effect rather than the surface it is reached from. **`money` alone, not both** — a member holding `money` can already produce the same row via `POST /transactions`, where a matching vendor name links the contractor automatically, so requiring both grants would make the route stricter than the equivalent it cannot stop. Tests assert the *split* (a `properties`-only member is refused with no transaction or audit row written, proving the guard runs ahead of the service; a `money`-only member succeeds; directory edits still refuse `money` and allow `properties`). *Still open, and genuinely a design question:* **does `logJob` survive at all** once a work order can carry cost? It would then be a second path to the same outcome. Options: leave it as the fast path for "I just paid someone, no ticket existed", or fold it into the work-order flow.
6. **D6 — Recurring maintenance** (annual furnace service, quarterly gutters). `RecurringTemplate` drafts *transactions*; drafting *work orders* is the same machinery pointed at a different table. Out of scope for v1 — but if it is ever wanted, `lib/recurrence.ts` is already pure and reusable, and the occurrence-marker lessons (monotonic, never equality-compared; calendar dates throughout) transfer unchanged.
