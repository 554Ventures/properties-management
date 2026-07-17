# Tenant-Name Matching for Rent-Match Heuristics (v2)

> **Status (2026-07-15):** Plan approved-in-principle, not yet started. Scope decisions made: name matching only (manual charge picker stays a separate roadmap item); tier = boost + disambiguate (no name-only suggestions). Pick up from "Order of work".

## Context

Rent matching today suggests a link only when a deposit's amount equals **exactly** the remaining balance of **exactly one** open charge within ±14 days of its due date. Two consequences: (a) a descriptor like `ZELLE FROM RIVERA J` contributes nothing even when it plainly names the tenant, and (b) two same-amount charges in window suppress the suggestion entirely, even when the descriptor would settle which one it is. WHATS_NEXT §3 tracks this as "Rent-match heuristics v2 — remaining: tenant-name matching against the deposit description".

**Scope (user-confirmed):** tenant-name matching only — the manual charge picker stays a separate roadmap item. Tier: **boost + disambiguate** — the name signal only ever acts on top of the existing exact-amount gate; it never creates name-only suggestions. Deterministic string matching only (mock mode must work offline). No schema migration needed — descriptor text already lives on `Transaction.description`/`vendor`.

Behavior:
1. **Boost** — single exact-amount match AND descriptor names a lease tenant → confidence 0.9 → **0.95**.
2. **Disambiguate** — 2+ exact-amount matches (today suppressed) and exactly one candidate's lease tenants match the descriptor → suggest that one at **0.85**. Zero or 2+ name matches → keep suppressing.
3. The Rent-page "Link deposit to rent?" nudge gets the same disambiguation for its `fits.length > 1` suppression.

## Name-matching algorithm

New file `apps/api/src/services/name-match.ts` (pure, dependency-free — same precedent as `services/vendor.ts`; the API is the only consumer, so not in `packages/shared`):

- `nameTokens(text)` — `text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)`. Handles case, periods ("T. Okafor"), hyphens, apostrophes, em-dashes, diacritics.
- `matchTenantName(tenantNames: readonly string[], descriptorText: string): string | null` — first (primary-first) tenant name the descriptor mentions, else null.

Match rule — exact token equality only (never substring: `PARKING` ≠ `park`):
1. Tokenize the tenant `fullName`. **Significant** tokens = length ≥ 3; tokens of length 1–2 (stored initials, particles) are ignored — never required, never sufficient.
2. Zero significant tokens → no match (lone-`J` guard).
3. **Surname anchor**: the *last* significant token (names are stored first-name-first) must appear as an exact descriptor token.
4. **Corroboration**: every other significant token must appear as an exact token **or** as its single-letter initial (a length-1 descriptor token equal to its first char) — this accepts truncated `RIVERA J`-style descriptors.

Descriptor text = `description + ' ' + (vendor ?? '')`, one order-insensitive token set (FIRST-LAST and LAST-FIRST both work).

Worked cases (become the test table): `T. Okafor` matches `ACH CREDIT — RENT T OKAFOR` and `ACH CREDIT OKAFOR`; `Juan Rivera` matches `ZELLE FROM RIVERA J` but NOT `RIVERA PLUMBING LLC` (first name uncorroborated — defuses the seeded contractor collision); `D. Park` ≠ `PARKING GARAGE REFUND`; `Ana García-López` matches `GARCIA LOPEZ A`; diacritics fold. Accepted conservative misses (doc-comment them): bare `RIVERA` doesn't match "Juan Rivera"; two candidates whose tenants share a surname (seed: A. Osei / R. Osei) both name-match → stays suppressed — correct.

## Changes

### 1. Shared contract (extend-only)
`packages/shared/src/schemas/transaction.ts` — `RentMatchSuggestionSchema` (line ~105) gains one optional field:
```ts
matchedName: z.string().nullable().optional(), // tenant the descriptor names (why the confidence is what it is)
```
Optional keeps existing web test fixtures parsing; the API always emits it. `disambiguatedByName` deliberately not exposed — confidence value already differentiates.

### 2. `apps/api/src/services/rent.service.ts`
- `RentMatchCandidate` (line 339): add `tenantNames: string[]` (all lease tenants, primary first — payer may be a co-tenant); keep `tenantName` for display.
- `findRentMatchCandidates` mapper (line 374): `tenantNames: p.lease.leaseTenants.map((lt) => lt.tenant.fullName)` — the query already includes tenants ordered `isPrimary: 'desc'`.
- `pickRentMatch` (line 408) — stays pure; descriptor passed in; **flattened** return so existing `?.rentPaymentId` call sites and tests survive unchanged:
  ```ts
  export interface RentMatchResult extends RentMatchCandidate {
    matchedName: string | null;
    disambiguatedByName: boolean;
  }
  export function pickRentMatch(
    txn: { amountCents: number; date: Date; description?: string | null; vendor?: string | null },
    candidates: RentMatchCandidate[],
  ): RentMatchResult | null
  ```
  Keep the existing filter verbatim as `inWindow`; then: 0 → null; 1 → return it with `matchedName` computed, `disambiguatedByName: false`; 2+ → exactly one candidate with non-null `matchTenantName` → return it with `disambiguatedByName: true`, else null. Optional descriptor fields keep `late-fees.test.ts` calls (amount/date only) compiling and behaving as today.
- `findUnlinkedRentDeposits` (line 862): replace `if (fits.length !== 1) continue;` — when `fits.length > 1`, narrow to charges where `matchTenantName(charge tenants, txn.description + ' ' + (txn.vendor ?? ''))` is non-null; proceed only if exactly one survives. Query already includes `leaseTenants` (line 818); no `UnlinkedRentDepositSchema` change.

### 3. `apps/api/src/services/transaction.service.ts`
- `computeRentMatches` (line ~618): pass `description`/`vendor` into `pickRentMatch`; replace the single confidence constant:
  ```ts
  const RENT_MATCH_CONFIDENCE = 0.9;                // exact amount + window (unchanged baseline)
  const RENT_MATCH_NAME_CONFIDENCE = 0.95;          // …and descriptor names a lease tenant
  const RENT_MATCH_DISAMBIGUATED_CONFIDENCE = 0.85; // name broke an amount/date tie
  ```
  Suggestion gains `matchedName`. POST /transactions response and `confirmAllInReview` both flow through `computeRentMatches` — disambiguated matches now appear in the map and are therefore automatically **excluded from bulk confirm** (the required per-item behavior; add a comment). `confirmWithRentLink` (explicit `rentPaymentId`, actor upgrade to `ai_suggested_user_confirmed`) untouched; chat/MCP tools serialize the response as-is — no tool changes.

### 4. Frontend (minimal)
- `apps/web/src/pages/MoneyReview.tsx` (~line 404): pass `AiChip`'s existing `note` prop — `note={rentMatch.matchedName ? `deposit names ${rentMatch.matchedName}` : undefined}`. Renders "suggests: T. Okafor's Jul 2026 rent … (95%) — deposit names T. Okafor" inside the existing AiSurface convention.
- `AddTransaction.tsx` modal and `RentTracker.tsx` nudge: no change (both already name the tenant).
- No seed changes: the mock Plaid fixture already imports `'ACH CREDIT — RENT T OKAFOR'` (`apps/api/src/integrations/mock/mock-plaid.ts:52`), so the 95% boost demos offline with zero `seed-constants.ts` repins.

### 5. Tests
- **New** `apps/api/src/__tests__/name-match.test.ts` — the worked-cases table: initials both directions, truncation, `RIVERA PLUMBING` rejection, lone-`J` and zero-significant-token guards, substring guard, diacritics, hyphenated surname.
- `apps/api/src/__tests__/transactions.test.ts` — extend the pure-matcher `candidate()` factory with `tenantNames`; new cases: boost (`matchedName` set), no-name single match (`matchedName: null`), disambiguation picks the named twin (`disambiguatedByName: true`), twins with neither/both named → null, co-tenant match, vendor-field match, right-name-wrong-amount → null (never name-only). Route test: post a pending deposit described `'TEST ACH CREDIT — RENT T OKAFOR'` → review `rentMatch` has `confidence: 0.95`, `matchedName: OKAFOR_NAME`; existing bland-descriptor deposit stays `0.9`/`null`. Note: the manual-entry test using `'TEST check from Okafor'` will incidentally rise to 0.95 — its `toMatchObject` doesn't pin confidence, no change needed (comment it).
- `late-fees.test.ts:319-336` — passes unchanged (verify only).
- Nudge suite (`rent-shares.test.ts` area): two open charges both fitting one deposit — descriptor naming exactly one lease's tenant → nudge surfaces that charge; naming neither → still suppressed.
- Web: a11y chip regex `/T\. Okafor's Jul 2026 rent/` is a prefix — still matches with the note; optionally set `matchedName` in the a11y fixture to audit the note path. `AddTransactionRentMatch.test.tsx` unchanged.

### 6. Docs
- `docs/WHATS_NEXT.md` §3: mark tenant-name matching shipped (0.95 boost / 0.85 disambiguation / 0.9 baseline, nudge narrowing, never name-only); remaining = manual charge picker only.
- `docs/FEATURES.md`: update the `/money/review` rent-chip sentence and the `/rent` nudge sentence.

## Order of work
1. Contract field (`packages/shared`) → 2. `name-match.ts` + its test → 3. `rent.service.ts` → 4. `transaction.service.ts` → 5. API tests → 6. `MoneyReview.tsx` chip note + web tests → 7. Docs → 8. `npm run typecheck` + both suites.

## Verification
- `npx vitest run src/__tests__/name-match.test.ts src/__tests__/transactions.test.ts src/__tests__/late-fees.test.ts` from `apps/api` (boots throwaway embedded Postgres on :5434), then full `npm run test --workspace apps/api` and `npm run test --workspace apps/web` (axe a11y included), `npm run typecheck`.
- Runtime: `npm run db:setup && npm run dev`, import mock bank transactions, open `/money/review` — the `ACH CREDIT — RENT T OKAFOR` deposit should show the chip at **95%** with "deposit names T. Okafor"; confirm it links and audits as `ai_suggested_user_confirmed`. Bulk "Confirm all" must still skip the row.
