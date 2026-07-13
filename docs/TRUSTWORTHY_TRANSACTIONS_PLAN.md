# Plan: Make Transactions Trustworthy — Category Learning, Partial/Split Rent, Reliable Money↔Rent Linkage

> Status: in progress (2026-07-12). Scope confirmed with the account owner. **Workstreams A, B, and C shipped 2026-07-12** (see `WHATS_NEXT.md` §3 for the as-built summaries); D remains.
> Reviewed against the code 2026-07-12; review addenda folded in: B gains a `paidCents` backfill, exact-remaining rent matching (moved up from C5), deposit-aware delete/update guards, and an unlink action; new Workstream D (ledger classification + duplicate defense) promoted from the gap review. The remaining review findings are logged as the "Transactions gap backlog" in `WHATS_NEXT.md` §3.

## Context

Transactions are the most valuable data we offer, so users must be able to trust that what they enter is reflected everywhere. Three gaps currently break that trust:

1. **AI category suggestions never learn.** `suggestCategory` is a static keyword table. Correcting a wrong category (e.g. "AMZN Mktp" Supplies→Office) updates that one row and writes an unread `AuditLog` entry — the *next* identical transaction gets the same wrong suggestion. Corrections evaporate.
2. **Rent can't represent partial or split payments.** Rent is one `RentPayment` per lease per period with a binary `paid`/not status. Both write paths (`recordPayment`, `confirmWithRentLink`) hard-reject any non-exact amount. Roommates each paying their share, or any partial payment, is impossible — the period stays "late."
3. **Money→Rent linkage is silent and brittle.** A Money transaction only clears rent status if it's income, exactly equal to the charge, within ±14 days, in a materialized period, AND the user accepts a prompt. A "Rent"-categorized deposit that misses any condition silently leaves the tenant showing late, with no on-page signal.

**Intended outcome:** corrections stick and improve future suggestions; a unit's rent reads "paid in full" once total received ≥ amount due (with per-tenant share tracking); and a Rent-categorized deposit either links or visibly nudges instead of silently doing nothing.

Decisions confirmed with the user: (1) split rent = **deposit aggregation + per-tenant shares**; (2) matching = **relax to partial + on-page nudge**; (3) category = **remember + auto-apply to future** (do not touch confirmed rows).

Binding repo conventions that constrain every part below: money is integer cents; **no Prisma `enum`/`Decimal`** (String columns validated by `@hearth/shared` Zod enums); every schema change ships as a `prisma migrate dev` migration (no `db push`); `@hearth/shared` is the single source of truth (contract changes must update both apps + their tests); writes must go through the service layer, thread an `actor`, and gate routes with `requirePermission`/`WRITE_TOOL_PERMISSIONS`; seed figures in `apps/api/prisma/seed-constants.ts` are pinned and asserted by tests.

---

## Workstream A — AI category suggestions that learn from corrections

**Goal:** a per-account vendor→category memory that `suggestCategory` consults first and that user corrections write to.

### A1. Shared contract (`packages/shared`)
- No new enum needed. Optionally add a `suggestionSource: z.enum(['learned','keyword','fallback']).optional()` to the transaction response schema so the UI can label a learned suggestion. Keep additive.

### A2. Schema + migration (`apps/api/prisma/schema.prisma`)
- New model:
  ```prisma
  model VendorCategoryMemory {
    id         String   @id @default(cuid())
    accountId  String
    vendorKey  String   // normalized vendor (trim+lowercase)
    type       String   // income | expense (validated by shared enum)
    categoryId String
    confidence Float    @default(0.95)
    hitCount   Int      @default(1)
    updatedAt  DateTime @updatedAt
    account  Account  @relation(fields: [accountId], references: [id], onDelete: Cascade)
    category Category @relation(fields: [categoryId], references: [id], onDelete: Cascade)
    @@unique([accountId, vendorKey, type])
    @@index([accountId])
  }
  ```
- Add `vendorCategoryMemories VendorCategoryMemory[]` to `Account` (schema ~line 45-59) and a back-relation on `Category`.
- Generate migration: `prisma migrate dev --name add_vendor_category_memory` (with `db:serve` running). Follows the existing 3-part `CreateTable`/`CreateIndex`/`AddForeignKey ON DELETE CASCADE` shape.

### A3. Shared vendor-key helper
- `vendorKey(name)` currently lives module-private in `apps/api/src/services/contractor.service.ts:34-36` (`name.trim().toLowerCase()`). **Lift it to a shared util** (e.g. `apps/api/src/services/vendor.ts` or export from contractor.service) and reuse it in both contractor matching and the new memory, so keys stay canonical. Do not fork the normalization.
- **Harden the normalization for bank descriptors** (2026-07-12 review): trim+lowercase is fine for the contractor directory but bank feed vendors carry per-transaction noise ("AMZN Mktp US\*1A2B3C" vs "\*9Z8Y7X") — exact-key memory would rarely hit twice on real Plaid/Stripe FC data, which is A's main value case. Strip trailing reference codes / store numbers (e.g. drop `*`-suffixed tokens and trailing digit runs) in the memory key. Contractor matching can keep the plain key if that changes its semantics; test with realistic descriptor variants either way.

### A4. Read path — consult memory first (`transaction.service.ts` `suggestCategory`, lines 160-180)
- At the top of `suggestCategory`, when `partialTxn.vendor` is non-empty, look up `VendorCategoryMemory` by `{ accountId, vendorKey(vendor), type }`. If found, return `{ categoryId, confidence }` from the memory (high confidence, e.g. stored value) and set `suggestionSource: 'learned'`. Otherwise fall through to the existing keyword table / fallback unchanged.

### A5. Write path — record corrections
- In `confirm()` (lines 493-511): when `input.categoryId` is set AND differs from `existing.aiSuggestedCategoryId` AND `existing.vendor` is non-empty → **upsert** memory `(accountId, vendorKey(existing.vendor), type) → input.categoryId` (increment `hitCount`, bump `confidence`). This is the primary correction signal; `existing` already has `vendor` in scope. The existing `ai_suggested_user_confirmed` actor logic is untouched.
- In `update()` (lines 317-318): when `input.categoryId` changes on a row that has a `vendor` → same upsert. Second correction signal for edits to already-confirmed rows.
- **Reinforcement, not just correction** (2026-07-12 review): when a confirm *accepts* the suggestion (no `categoryId` override) and a memory row backed it, bump `hitCount`/`confidence` too — otherwise confidence only ever moves on disagreement and the stored value never earns trust.
- Keep it a best-effort side effect inside the same service call (not a new route). No new REST surface; no chat tool change required.

### A6. Web (`apps/web`)
- In `MoneyReview.tsx` / the `AiChip` suggestion, when `suggestionSource === 'learned'`, render the existing `AiSurface`-wrapped chip with copy like "Suggested from your past choice" so the learning is visible and trusted. No color-only signal (a11y).

### A7. Tests (`apps/api/src/__tests__`)
- New `vendor-category-memory.test.ts`: correct a category → memory row created; a new transaction from the same vendor gets the learned suggestion at high confidence; a different vendor is unaffected; confirmed rows are not retroactively changed.
- Assert account isolation (memory is per-`accountId`).

---

## Workstream B — Partial & aggregated rent payments (deposit ledger)

**Goal:** multiple deposits sum toward one charge; status becomes `paid` when total received ≥ amount due, with an intermediate `partial` state. This is the structural core that unblocks roommates and the linkage nudge.

### B1. Shared contract (`packages/shared`)
- Add `'partial'` to the **derived** `RentStatusSchema` (`src/schemas/rent.ts:12`). Decide whether `partial` is also a **stored** status on `RentPayment` or purely derived from `paidCents` vs `amountCents`:
  - **Recommended:** keep the stored `RentPaymentStatusSchema` (`src/enums.ts:17`) as `due|processing|paid|failed`, and derive `partial` when `0 < paidCents < amountCents`. This minimizes stored-state churn and keeps `paid` meaning "settled in full."
- Add `paidCents` to `RentTrackerRowSchema`/`RentPaymentSchema` so the UI can show "$X of $Y". Additive.

### B2. Schema + migration
- Add `paidCents Int @default(0)` to `RentPayment` (running total received).
- New child ledger to allow *many deposits → one charge* (the current `transactionId @unique` one-to-one cannot represent this):
  ```prisma
  model RentPaymentDeposit {
    id            String   @id @default(cuid())
    rentPaymentId String
    transactionId String   @unique
    amountCents   Int
    tenantId      String?  // which co-tenant paid (for share tracking, Workstream C)
    method        String?  // online | manual | bank
    paidAt        DateTime @default(now())
    rentPayment RentPayment @relation(fields: [rentPaymentId], references: [id], onDelete: Cascade)
    transaction Transaction @relation(fields: [transactionId], references: [id], onDelete: Cascade)
    tenant      Tenant?     @relation(fields: [tenantId], references: [id], onDelete: SetNull)
    @@index([rentPaymentId])
  }
  ```
- Keep the existing `RentPayment.transactionId` for backward compatibility (the single-payment fast path can still set it), but new/partial logic writes `RentPaymentDeposit` rows and maintains `paidCents = sum(deposits)`.
- **Backfill in the same migration:** existing `status='paid'` rows get `paidCents = amountCents` (and optionally a synthesized `RentPaymentDeposit` from the legacy `transactionId` link). Without this, B3's new `collectedCents = sum(paidCents)` reads $0 for every historical month and the pinned MTD totals fail for the wrong reason.
- **Extend the linked-row guards to deposits:** `transaction.service.update` (296-307) and `remove` (346-351) only check `RentPayment.transactionId` — a deposit-backed transaction would pass them, and deleting it would cascade the deposit away leaving `paidCents` stale (it's a maintained denormalization, not derived at read time). Both guards must also match `RentPaymentDeposit.transactionId`, and **every deposit mutation recomputes `paidCents`** inside the same `$transaction`.
- Migration: `prisma migrate dev --name add_rent_partial_payments`.

### B3. Status derivation (`rent.service.ts` `deriveRentStatus` 54-66, `getMonthStatus` 178-234)
- `deriveRentStatus`: a row with `paidCents >= amountCents` → `paid`; `0 < paidCents < amountCents` → `partial` (still track `daysLate` if past grace, so a partial-but-late row surfaces both); `paidCents === 0` → existing `due`/`late` logic.
- Aggregates (223-233): change `collectedCents` to sum **`paidCents` across all rows** (not full `amountCents` of paid rows only); `outstandingCents` = sum of `(amountCents - paidCents)` where positive. `paidUnits` becomes "fully paid" count; add `partialUnits`. These reducer changes ripple into pinned seed constants — see B6.

### B4. Payment write paths (relax the exact-amount guards)
- `recordPayment` (`rent.service.ts` 308-435): remove the hard `BadRequestError` at 355-360. Instead: accept `amountCents <= remaining` (remaining = `amountCents - paidCents`); reject only overpayment beyond remaining (or allow + clamp — default reject with a clear message). Inside the `$transaction`: create the ledger `Transaction` (as today), create a `RentPaymentDeposit`, recompute `paidCents`, set `status='paid'` only when fully covered (else leave stored `due`, derived `partial`). Preserve the double-pay/concurrency re-read guard.
- `confirmWithRentLink` (`transaction.service.ts` 523-606): same relaxation — link an income transaction as a deposit toward the charge instead of requiring exact equality; create `RentPaymentDeposit` from the existing transaction; recompute `paidCents`/status. Keep the income-only requirement and `ai_suggested_user_confirmed` actor.
- Keep the "already fully paid" guard (reject deposits once `paidCents >= amountCents`).
- **Match against *remaining*, not the full charge (moved up from C5):** `pickRentMatch` (`rent.service.ts` 296-306) compares `c.amountCents === txn.amountCents` — untouched, B's relaxed write paths are unreachable from the UI (no suggestion ever surfaces for a partial, and there's no manual rent-payment picker). Change the comparison to the charge's remaining (`amountCents - paidCents`), suggesting on **exact-remaining** matches only (covers the second roommate check completing a total, and re-suggests after a partial). Keep the two-candidate ambiguity suppression, now keyed on remaining. Broader below-remaining/near-miss matching stays in C5's nudge, where it's presented as a question rather than a 0.9-confidence chip.
- **Unlink / reverse a deposit (new):** a wrong link is currently permanent (`update`/`remove` throw on linked rows; no UI path exists), and B+C add two new ways to create links. Add a service + route (e.g. `DELETE /rent-payments/:id/deposits/:depositId`, `requirePermission('rent')`) that deletes the deposit row, recomputes `paidCents`/status inside a `$transaction`, and audits (`rent_payment.deposit_unlinked`, actor threaded). The ledger transaction itself survives unlinking (it's back to an ordinary confirmed row the user can edit/delete once the guard no longer sees it).

### B5. Web (`apps/web`)
- `RentTracker.tsx`: add a `partial` case to `statusInfo` (36-55) → "Partial — $X of $Y"; add an **editable amount field** to the record-payment modal (388-423) defaulting to remaining (today it always sends full `payRow.amountCents` at 141-158); show partial progress in the summary tiles (a "partially collected" figure alongside Collected/Outstanding); expose the deposits behind a partial/paid row with the **unlink** action from B4.
- `Money.tsx`: rent linkage is invisible on the ledger today (no column/badge — a user can't tell a deposit is "applied to rent"). Add a small "rent" marker on rows backing a `RentPaymentDeposit` (or legacy `transactionId` link), which also explains why edit/delete are restricted for those rows.
- `AddTransaction.tsx` `linkRentMatch` (178-192): prompt copy handles partial ("Apply $X as a partial rent payment?").
- `queries.ts`: invalidation already covers `['rent']`/`['tenants']` on confirm/record — extend `RentTracker` query usage for `paidCents`.

### B6. Seed constants + tests (the pinned-figure blast radius)
- `apps/api/src/__tests__/rent.test.ts:153` ("rejects a partial payment…") **is directly overturned** — rewrite it to assert a partial deposit is stored, `paidCents` updates, status derives `partial`, and a second deposit completing the total flips to `paid`.
- New assertions for the B4 additions: deleting/editing a deposit-backed transaction is blocked (guard extension); after a partial, the review queue suggests an exact-**remaining** income transaction; unlink removes the deposit, recomputes `paidCents`, reverts derived status, and writes the audit row; the backfill leaves pre-migration paid rows with `paidCents === amountCents`.
- Preserve `rent.test.ts:32` exact totals (`COLLECTED_MTD_CENTS 1156000`, `OUTSTANDING_MTD_CENTS 213500`, `PAID_UNITS 12`, `TOTAL_UNITS 14`) by keeping the seed all-or-nothing **unless** we intentionally add a partial/co-tenant seed row (see C4). If we add one, repin `seed-constants.ts` (127-138) and every downstream assertion (`dashboard.test.ts`, `reports.test.ts` import `COLLECTED_MTD_CENTS`/`OUTSTANDING_MTD_CENTS`).
- Preserve `lease-rent-reconciliation.test.ts` proration/one-charge-per-unit-month invariants — B changes must not alter materialization.

---

## Workstream C — Per-tenant shares + reliable, visible linkage

**Goal:** track each co-tenant's expected share and who has paid, and make a Rent-categorized deposit either link or visibly nudge (never silently leave "late").

### C1. Shared contract
- Extend the lease/tenant response schemas so `leaseTenants` carry `shareCents: z.number().int().nonnegative().nullable()`. Additive; a null share means "unspecified" (falls back to even split for display).

### C2. Schema + migration
- Add `shareCents Int?` to `LeaseTenant` (schema 200-209). Composite PK stays. Null = unspecified. Migration: `prisma migrate dev --name add_leasetenant_share`.
- (Deposits already carry `tenantId` from B2 to attribute who paid.)

### C3. Service + UI for shares
- `rent.service.ts` `getMonthStatus`: today `tenantName` uses only `leaseTenants[0]` (primary). Extend the row to expose all co-tenants with their `shareCents` (or even split when null) and per-tenant paid status derived from `RentPaymentDeposit.tenantId` sums. Validate that shares sum to `lease.rentCents` when all are specified (soft warning, not a hard block).
- `RentTracker.tsx`: for a unit with co-tenants, show per-tenant share + paid/due (the "Alex PAID / Jae DUE" view). Keep single-tenant units unchanged.
- Lease edit UI (find the lease form under `apps/web/src/pages/`): allow entering each co-tenant's `shareCents`.

### C4. Seed fixture
- Add one co-tenant lease to the seed (currently every unit has exactly one tenant) so the split UI/tests have a fixture. This changes pinned KPIs — repin `seed-constants.ts` and downstream dashboard/report assertions deliberately, documenting why (per the "seed numbers are pinned" convention).

### C5. The linkage nudge (fixes "silently still late")
- Backend: add a lightweight read used by the Rent page — for each open/partial charge, detect **Rent-categorized income transactions** (category name "Rent", not yet linked to a deposit) on the same property/unit within the period window that could apply. Reuse `findRentMatchCandidates` (`rent.service.ts` 255-289); exact-remaining matching already ships in B4, so this read is the **broader** tier — below-remaining amounts and near-misses that the high-confidence chip deliberately won't suggest, surfaced as a question.
- `RentTracker.tsx`: when such an unlinked Rent deposit exists for a still-unpaid/partial charge, render a "Link deposit to rent?" nudge (AiSurface if AI-suggested) that calls the existing `confirm`/`confirmWithRentLink` deposit path. This closes the loop the user hit: a Rent-categorized transaction never silently leaves a tenant "late."

### C6. Tests
- Per-tenant share derivation (shares sum, even-split fallback, per-tenant paid status from deposits).
- Nudge detection: a Rent-categorized unlinked income on a unit with an open charge surfaces a match; linking it creates a deposit and updates status.

---

## Workstream D — Ledger classification & duplicate defense (promoted 2026-07-12)

**Goal:** stop the two failure modes A–C cannot fix — money that shouldn't be in P&L at all, and the same money counted twice. Both were found in the 2026-07-12 gap review; both produce wrong report numbers no amount of category learning or rent linkage repairs.

### D1. Transfer / refund classification
- **Problem:** `TransactionTypeSchema` is `income|expense` only (`packages/shared/src/enums.ts:5`). Bank adapters sign-classify everything (`real-plaid.ts:24-32`, `real-stripe-fc.ts:18-26`): a transfer between the owner's own accounts or an owner contribution is forced into P&L, and a vendor **refund lands as income** (original expense stays full, spurious income line — both sides overstated). `dismiss` only works pre-confirm and erases the money rather than reclassifying.
- **Shape (recommended):** don't extend `TransactionType` (it ripples through every type filter). Add a nullable `classification` String column validated by a new shared enum (`transfer | owner_contribution | refund`), settable at review time and from the edit modal. `report.service.confirmedWhere` + dashboard/insight filters exclude `transfer`/`owner_contribution`; `refund` stays in reports but nets against its expense category (contra-expense) instead of counting as income. Additive contract change; migration per convention.
- **Kill the income-fallback trap:** `suggestCategory` suggests "Rent" at 0.80 for **every** income row (`transaction.service.ts:158,166-167`) — above the UI's 0.7 low-confidence cue — and `confirmAllInReview` auto-applies it, so refunds/transfers/security deposits can be mass-confirmed as Rent income in one click. Drop `INCOME_FALLBACK` confidence below a new **minimum-confidence gate on bulk confirm** (resolves the `WHATS_NEXT.md` §6.2 open decision), and have D1's classification suggestions run before the category fallback.

### D2. Cross-source duplicate detection
- **Problem:** the only dedupe key is `@@unique([accountId, externalId])` (`schema.prisma:251`), bank-source only. Manual/receipt rows carry null `externalId` → a hand-logged check plus its later bank import = two rows. Plaid and Stripe FC use different id namespaces and `importFromBank` (`transaction.service.ts:945-957`) lets both cover the same bank account → same real transaction, two rows. Workstream B sharpens the worst case: `recordPayment` creates a manual ledger row, the bank deposit later imports, can't link ("already fully paid"), and gets confirmed as ordinary income — double count.
- **Shape:** a content fingerprint heuristic (same `type` + `amountCents`, date within ±3 days, optionally same normalized vendor via A3's `vendorKey`) computed on import/create against recent rows. Never auto-merged: flag as a "possible duplicate of …" chip on the review card with a **dismiss-as-duplicate** action (reuses the existing `dismissed` status; audited). The rent-specific case gets first-class handling: a bank income matching an already-fully-paid charge's amount/window suggests "this looks like the deposit behind the rent you recorded manually" → dismiss-as-duplicate, or swap the link (unlink manual row, link bank row) via B4's unlink.
- Settings: warn when both Plaid and Stripe FC are connected (possible same underlying bank account feeding twice).

### D3. Tests
- Refund/transfer classified rows excluded/netted in P&L, Schedule E, dashboard KPIs consistently; classification requires `money` permission and audits.
- Bulk confirm skips sub-threshold suggestions (income fallback no longer auto-applied).
- Fingerprint: manual row then identical bank import → flagged, dismiss-as-duplicate works; different amounts/dates → not flagged; account isolation.

---

## Sequencing & dependencies

1. **A (category learning)** is independent — ship first; smallest blast radius, immediate trust win, no seed churn.
2. **B (partial/deposit ledger)** is the structural foundation for C — do second. Keep seed all-or-nothing so existing pinned totals survive until C4.
3. **C (shares + nudge)** builds on B's `RentPaymentDeposit.tenantId` and relaxed matching; it's the part that touches pinned seed constants (C4), so isolate that change and repin deliberately.
4. **D (classification + duplicates)** is independent of B/C and can ship any time after A (D2 reuses A3's `vendorKey`; D2's link-swap flow wants B4's unlink but degrades to dismiss-as-duplicate without it). D1's bulk-confirm confidence gate is the most urgent slice — it's a one-day change that stops mass-miscategorization today.

Each workstream is architect-decomposable into a backend subtask (schema/migration/service/shared contract), a frontend subtask (pages + AiSurface + a11y), and a test subtask.

---

## Verification (end-to-end)

Per-workstream, after implementation:

- **Typecheck + build:** `npm run typecheck` (all workspaces), `npm run build`.
- **Backend suite:** `npm run test --workspace apps/api` (boots throwaway embedded Postgres). Targeted: `npx vitest run src/__tests__/rent.test.ts`, `.../vendor-category-memory.test.ts`, `.../lease-rent-reconciliation.test.ts`, plus `dashboard.test.ts`/`reports.test.ts` if seed repinned.
- **Frontend suite (incl. axe a11y):** `npm run test --workspace apps/web`.
- **Migrations apply cleanly:** run `npm run db:setup` on a fresh `pgdata`; confirm `prisma migrate deploy` (what tests use) succeeds — an unmigrated schema change fails the suite by design.
- **Runtime smoke (use the `verify`/`run` skill to boot API+web):**
  - A: create a transaction, correct its AI category, create a second transaction from the same vendor → suggestion is now the corrected category, chip reads "from your past choice."
  - B: on a $3000 charge, record a $1000 manual payment → Rent page shows "Partial — $1000 of $3000"; record $2000 more → flips to "Paid." Confirm collected/outstanding tiles reflect partial.
  - C: set two co-tenants with $1500 shares; each pays separately → per-tenant PAID/DUE shows correctly; unit reads paid in full only when total ≥ due. Add a Rent-categorized income that doesn't auto-link → Rent page shows the "Link deposit to rent?" nudge; accept it → status updates.
  - D: mark an imported transfer as `transfer` → disappears from P&L/dashboard; log a rent payment manually, then import the matching bank deposit → review card flags "possible duplicate"; bulk confirm leaves low-confidence income suggestions in the queue.
- **Audit attribution intact:** confirm corrections/deposits still write `AuditLog` with the right actor (`user` / `ai_suggested_user_confirmed` / `system`).
