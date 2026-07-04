# What's Next

Status as of 2026-07-03: v1 is feature-complete per [PRD.md](PRD.md) and demoable offline (mock AI mode). All suites green (api 42/42, web 38/38), QA-reviewed with majors fixed. This file tracks what remains, in priority order.

## 1. Before enabling a real `ANTHROPIC_API_KEY` in anything shared

The demo is safe as-is; these matter once the model (not the deterministic mock) drives tool calls:

- [ ] **Exercise the real Anthropic client path end-to-end.** Only the mock `AiClient` has been driven live. Run the full chat flows (chart, tax pause/resume, late rent) against the real model; tune `src/ai/prompts.ts` until render/ask tool usage is reliable.
- [ ] **AI usage cost controls** (PRD §13.4): per-account budget/rate limit on chat turns and scheduled jobs; token-usage logging.
- [ ] **Persist askUserQuestion selections.** The shared `AskUserQuestionBlock` has no field recording the chosen option, and no user message is written for the answer — after a reload the transcript shows the question but not the selection (kept in client state today). Add an `answeredOptionIds` field to the block (or persist a user answer message) and backfill the renderer.

## 2. Before multi-user / production deployment

- [ ] **Real auth** (PRD §7.3): replace the seeded demo account + optional `DEV_BEARER_TOKEN` with session auth. Every service already takes `accountId` first, so this is additive.
- [ ] **Postgres migration**: swap the SQLite provider; convert the String-enum columns to real Prisma enums and cents `Int`s stay as-is (schema header comment documents the plan).
- [ ] **Atomic session-state transitions**: the chat 409 guards are read-then-act (`chat.service.ts`) — use conditional `updateMany` transitions so concurrent sends/answers can't both enter the loop. Same pattern review for any remaining check-then-create paths (rent tracker materialization already retries on unique-constraint; `recordPayment` is transactional).
- [ ] **MCP per-client OAuth** (PRD §10): replace the single `HEARTH_MCP_ENABLE_WRITE` env gate with per-client authorization + scopes, revocable from Settings; the `Integration` model (`type: mcp_client`, `scopesJson`) is the intended home.
- [x] **Audit coverage completion**: property/unit/tenant/lease CRUD is now audited (create/update/archive/restore/terminate/renew/add_tenant/remove_tenant) alongside transactions, payments, reminders, reports, insights.
- [ ] **Transaction-delete / RentPayment desync**: deleting a rent-linked ledger Transaction leaves the RentPayment `paid` (SetNull; noted in `schema.prisma`). Block deletion of rent-linked transactions or cascade a status recompute.
- [ ] **Session hygiene**: sessions left `awaiting_user` are never expired server-side; add a TTL sweep.

## 3. Real integrations (v1 ships mocks behind adapter interfaces)

Interfaces in `apps/api/src/integrations/types.ts`; each swap is one adapter implementation:

- [ ] **Plaid** — real link flow + transaction sync into the review queue.
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
