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
- [x] **Transaction-delete / RentPayment desync**: deleting a rent-linked ledger Transaction is now blocked with a 400 in `transaction.service.remove` (SetNull remains the DB-level fallback for writes that bypass the service).
- [ ] **Session hygiene**: sessions left `awaiting_user` are never expired server-side; add a TTL sweep.

## 3. Real integrations (v1 ships mocks behind adapter interfaces)

Interfaces in `apps/api/src/integrations/types.ts`; each swap is one adapter implementation:

- [x] **Plaid** — real Sandbox Link flow + cursor-based `/transactions/sync` into the review queue (`integrations/real/real-plaid.ts`; toggled by `PLAID_CLIENT_ID`/`PLAID_SECRET`/`INTEGRATION_ENCRYPTION_KEY`, account setup §6). Known limitations, deliberately deferred: no webhooks — sync is driven only by the existing manual "Import from bank" button, so a fresh Sandbox link often needs a second click a little later before Plaid's initial pull finishes; only `added` transactions are processed, `modified`/`removed` are ignored (the `Transaction.externalId` dedup column is in place for a follow-up); Production requires Plaid's app-review process and hasn't been requested.
- [x] **Plaid rent reconciliation**: the Review Queue now computes a rent-match suggestion on load (income bank transaction whose amount exactly equals an open `due`/`processing` `RentPayment` dated within ±14 days of `dueDate`; ambiguous same-rent candidates suppress the suggestion) and renders it as an AiChip ("T. Okafor's Jul rent — never auto-applied"). Accepting it confirms via `POST /transactions/:id/confirm { rentPaymentId }`, which atomically sets the lease's property/unit + Rent category on the transaction and flips the `RentPayment` to `paid` (`method: 'bank'`, `transactionId` linked) with a double-pay guard, audited as `ai_suggested_user_confirmed`. Known accepted misses: early payments for a future period aren't suggested; the chat/MCP `confirm_transaction` tool accepts the same params. The mock Plaid batch includes an income fixture (`plaid_mock_4`, kept in sync with `OKAFOR_RENT_CENTS`) so the flow demos offline.
- [ ] **Rent-match heuristics v2** (follow-up to the above): tolerance/partial-payment matching, tenant-name matching against the deposit description, and a picker to link a deposit to a rent row the heuristic didn't suggest.
- [x] **Bank-imported transactions have no property/unit attribution UI**: the Review Queue confirm card now has property/unit selects (`ConfirmTransactionInput` extended with `propertyId`/`unitId`), and the Money ledger has a per-row Edit modal (`useUpdateTransaction` → existing `PATCH /transactions/:id`) for transactions confirmed earlier. Clearing a set property/unit still isn't possible (same `null`-vs-`undefined` contract limitation tracked in §5).
- [ ] **Stripe** — real payment links, webhooks for settlement status (RentPayment `processing`/`paid`/`failed` states already modeled).
- [ ] **Docusign** — real envelope creation + status webhooks (lease `esignStatus` already modeled).
- [ ] **Email provider** — transactional email for reminders / "email accountant".
- [ ] **Real PDF rendering** — `src/lib/pdf.ts` is a plain-text placeholder buffer served as `application/pdf`; the function signature is stable, drop in a renderer (e.g. pdfkit / puppeteer-print).
- [x] **Receipt OCR** — real Anthropic vision extraction (`apps/api/src/ai/receipt.ts`; forced-tool call, category/property candidates in the prompt resolved back to account-scoped ids) when `ANTHROPIC_API_KEY` is set; deterministic mock fixture otherwise. Route hardened with an image mimetype allowlist, 5 MB cap, and a per-account rate limit (`RECEIPT_RATE_LIMIT_MAX`, default 10/min); token usage logged as `aiUsage` lines (`context: receipt_scan`).
- [ ] **QuickBooks export format** — currently CSV/PDF only; add the QBO-compatible export named in PRD §5.6.

## 4. Product build-out (PRD Phase 2)

- [ ] Tenant portal (pay rent, maintenance requests, view/sign lease) — data model is already shaped for it (PRD §11).
- [ ] Multi-user teams/roles (`Membership` table attaches to `Account` without reshaping).
- [~] Native mobile: iOS Capacitor shell shipped 2026-07-11 (`apps/mobile`, remote-URL mode) with APNs push (rent received + daily warning insights), camera receipt capture, and Face ID lock — see `docs/MOBILE.md`. Remaining: the manual Apple steps (identifier + APNs key + first device install, MOBILE.md checklist), Android if ever needed.
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
