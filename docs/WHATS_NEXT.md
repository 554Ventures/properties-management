# What's Next

Status as of 2026-07-03: v1 is feature-complete per [PRD.md](PRD.md) and demoable offline (mock AI mode). All suites green (api 42/42, web 38/38), QA-reviewed with majors fixed. This file tracks what remains, in priority order.

## 1. Before enabling a real `ANTHROPIC_API_KEY` in anything shared

The demo is safe as-is; these matter once the model (not the deterministic mock) drives tool calls:

- [ ] **Exercise the real Anthropic client path end-to-end.** Only the mock `AiClient` has been driven live. Run the full chat flows (chart, tax pause/resume, late rent) against the real model; tune `src/ai/prompts.ts` until render/ask tool usage is reliable.
- [~] **AI usage cost controls** (PRD §13.4): token-usage logging (structured `aiUsage` lines per model call) and per-account rate limiting on chat turns are done (deployment plan §4.5). Remaining: a per-account monthly token *budget* with a hard cutoff, and cost visibility in Settings.
- [ ] **Persist askUserQuestion selections.** The shared `AskUserQuestionBlock` has no field recording the chosen option, and no user message is written for the answer — after a reload the transcript shows the question but not the selection (kept in client state today). Add an `answeredOptionIds` field to the block (or persist a user answer message) and backfill the renderer.

## 2. Before multi-user / production deployment

> **Production is live (2026-07-04)** at https://app.554properties.com — see `docs/property-app-deployment-plan.md` (§13 has the remaining post-launch checklist). The unchecked items below are hardening work, no longer launch blockers.

- [x] **Real auth** (PRD §7.3, deployment plan §4.1): Supabase mode — JWT verification in `plugins/auth.ts` (HS256 secret or JWKS), first-sight `Account`+`User` provisioning in `services/auth.service.ts`, web login screen + session bearer tokens. Demo mode remains the no-env default. Remaining: a `User ↔ Account` many-to-many UX (schema is ready) and rate limiting on auth endpoints.
- [x] **Postgres migration** (deployment plan §4.2): provider swapped; baseline migration in `prisma/migrations`; local dev/tests boot an npm-managed embedded Postgres (`apps/api/scripts/`), production points `DATABASE_URL` at Supabase. String-enum columns deliberately stay Strings (shared Zod enums remain the source of truth) — converting to native Postgres enums is a possible later migration, not a blocker.
- [ ] **Atomic session-state transitions**: the chat 409 guards are read-then-act (`chat.service.ts`) — use conditional `updateMany` transitions so concurrent sends/answers can't both enter the loop. Same pattern review for any remaining check-then-create paths (rent tracker materialization already retries on unique-constraint; `recordPayment` is transactional).
- [ ] **MCP per-client OAuth** (PRD §10): replace the single `HEARTH_MCP_ENABLE_WRITE` env gate with per-client authorization + scopes, revocable from Settings; the `Integration` model (`type: mcp_client`, `scopesJson`) is the intended home.
- [x] **Audit coverage completion**: property/unit/tenant/lease CRUD is now audited (create/update/archive/restore/terminate/renew/add_tenant/remove_tenant) alongside transactions, payments, reminders, reports, insights.
- [ ] **Transaction-delete / RentPayment desync**: deleting a rent-linked ledger Transaction leaves the RentPayment `paid` (SetNull; noted in `schema.prisma`). Block deletion of rent-linked transactions or cascade a status recompute.
- [ ] **Session hygiene**: sessions left `awaiting_user` are never expired server-side; add a TTL sweep.

## 3. Real integrations (v1 ships mocks behind adapter interfaces)

Interfaces in `apps/api/src/integrations/types.ts`; each swap is one adapter implementation:

- [x] **Plaid** — real Sandbox Link flow + cursor-based `/transactions/sync` into the review queue (`integrations/real/real-plaid.ts`; toggled by `PLAID_CLIENT_ID`/`PLAID_SECRET`/`INTEGRATION_ENCRYPTION_KEY`, account setup §6). Known limitations, deliberately deferred: no webhooks — sync is driven only by the existing manual "Import from bank" button, so a fresh Sandbox link often needs a second click a little later before Plaid's initial pull finishes; only `added` transactions are processed, `modified`/`removed` are ignored (the `Transaction.externalId` dedup column is in place for a follow-up); Production requires Plaid's app-review process and hasn't been requested.
- [ ] **Plaid rent reconciliation (PRIORITY — next up)**: bank-imported transactions are never matched against a lease's expected rent. `rent.service.ts` and the ledger are fully independent today — a tenant's rent deposit imported via Plaid lands as a generic uncategorized income transaction and does **not** mark the `RentPayment` row `paid` on the Rent Tracker. If the landlord separately clicks "Record payment" (or the tenant pays via the mock Stripe link) for the same month, that creates a second, unrelated ledger `Transaction` — the two are never reconciled, so that month's income gets double-counted in Dashboard/Reports unless a human notices and skips confirming the duplicate. Fix: match an incoming bank transaction to a lease's `due`/`processing` `RentPayment` by amount (+ a date window around `dueDate`) during `importFromBank`, and either auto-link it (set `RentPayment.transactionId`, flip to `paid`) or surface a confirm-time suggestion ("this looks like J. Rivera's July rent") in the Review Queue instead of a bare category guess.
- [ ] **Bank-imported transactions have no property/unit attribution UI**: `importFromBank` never sets `Transaction.propertyId`/`unitId` (no heuristic exists), and — checked — there is currently no frontend path to set them afterward either (Money page has no edit-transaction form; only `POST /transactions/:id/confirm` exists, which only accepts `categoryId`, even though the backend's `PATCH /transactions/:id` already accepts `propertyId`/`unitId` via `UpdateTransactionInput`). Net effect: an imported transaction counts in portfolio-wide Dashboard KPIs and the unfiltered ledger, but is silently **excluded from any property-scoped report** (P&L/Schedule E filtered by `propertyId`). Fix: add property/unit fields to the Review Queue confirm step (or a lightweight edit action on the Money ledger row) wired to the existing `PATCH` endpoint — no backend change needed.
- [ ] **Stripe** — real payment links, webhooks for settlement status (RentPayment `processing`/`paid`/`failed` states already modeled).
- [ ] **Docusign** — real envelope creation + status webhooks (lease `esignStatus` already modeled).
- [ ] **Email provider** — transactional email for reminders / "email accountant".
- [ ] **Real PDF rendering** — `src/lib/pdf.ts` is a plain-text placeholder buffer served as `application/pdf`; the function signature is stable, drop in a renderer (e.g. pdfkit / puppeteer-print).
- [ ] **Receipt OCR** — `scanReceipt` returns a fixture parse in mock mode; wire the Anthropic vision call in the real path.
- [ ] **QuickBooks export format** — currently CSV/PDF only; add the QBO-compatible export named in PRD §5.6.

## 4. Product build-out (PRD Phase 2)

- [ ] Tenant portal (pay rent, maintenance requests, view/sign lease) — data model is already shaped for it (PRD §11).
- [ ] Multi-user teams/roles (`Membership` table attaches to `Account` without reshaping).
- [ ] Native mobile (v1 responsive web covers the wireframes' mobile layouts).
- [ ] Custom report builder if "Ask AI to build a report" usage shows recurring unmet patterns.

## 5. Polish / engineering hygiene

- [ ] **CI pipeline**: run typecheck + both test suites + build + the axe smoke as merge-blocking checks (everything is scripted; just needs a workflow file).
- [ ] **Playwright e2e**: the live end-to-end flow (seed → dashboard → chat pause/resume → action card) was verified manually via curl; codify it as a browser e2e.
- [ ] **Bundle size**: Recharts pushes the main chunk past 500 kB — add `manualChunks` or lazy-load chart components.
- [ ] **Transaction list pagination**: API supports cursor pagination; the UI fetches `limit=100` with no load-more.
- [ ] **"Already reminded" state**: `RentTrackerRow` lacks `remindedAt`, so repeat reminders are only surfaced via the send-result toast; add the field to the shared schema + row.
- [ ] **Session context persistence**: chat session `context` lives inside server-internal `providerStateJson`; give it a real column if session lists ever need to show it.
- [ ] **Clear an optional field on edit**: the property/unit edit modals send `undefined` (omit) for a blanked nickname/notes/market-rent, so the PATCH can't clear a previously-set value — it's silently retained. Needs the `Update*InputSchema` fields to accept `null` and the services to treat `null` as "clear" vs `undefined` as "leave". (QA finding, low; contract change deferred out of the CRUD pass.)
- [ ] **Archived-entity browser**: soft-archive + restore exist end-to-end, but there's no UI to *see* archived properties/tenants/units (restore is only wired via the hook); add an "Archived" filter/section if users need to find and restore them.

## 6. Open product decisions (from PRD §13, unchanged)

1. Legal review of tax-disclaimer language before any real user files taxes off a Hearth export.
2. Categorization confidence threshold policy (what score routes to the "needs a human eye" queue).
3. UX design for the MCP write-scope authorization screen.
4. Product name — "Hearth" is still a placeholder.
