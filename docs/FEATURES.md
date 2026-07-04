# Implemented Features

Complete inventory of what Hearth v1 does today (as of 2026-07-03). Companion to [WHATS_NEXT.md](WHATS_NEXT.md) (what's not built yet) — **check both before implementing a "new" feature.** Traceability: PRD section in parentheses.

## Screens (apps/web)

| Route | Feature | Notes |
|---|---|---|
| `/` | Dashboard (PRD §5.1) | Greeting + portfolio counts, 4 KPI tiles (net cash flow w/ trend, rent collected w/ progress bar, expenses, tax set-aside w/ "Estimate — not tax advice"), 6-month income-vs-expense bar chart, exactly one dismissible AI insight card, recent-activity feed. Zero-CLS skeletons. |
| `/properties` | Properties list (§5.2) | Table w/ occupancy, rent/mo, status ("Full"/"N late" as text+icon); create-property modal. |
| `/properties/:id` | Property detail (§5.2) | Units w/ lease+tenant+status, MTD/YTD P&L, property-scoped insight cards. |
| `/tenants` | Tenants & leases list (§5.3) | Status per row (Current / Renew soon / "N days late"), portfolio renewal insight, per-row Remind for late tenants. |
| `/tenants/:id` | Tenant detail (§5.3) | Contact, lease terms w/ e-sign status, payment history, renewal-draft modal (suggested rent) → mock Docusign send. |
| `/money` | Transactions (§5.4) | Filterable ledger, review-queue count badge, mock bank import (Plaid adapter). |
| `/money/review` | Review queue (§5.4) | Pending bank/receipt transactions w/ AI category suggestion chip (never auto-applied), confirm/override. |
| `/money/new` | Add transaction (§5.4) | Manual form + snap-a-receipt dropzone → OCR endpoint pre-fills the form (mock parse; explicit save always required). |
| `/rent` | Rent tracker (§5.5) | Period selector, collected/outstanding/progress tiles, per-tenant status with exact days late, individual + bulk reminders (confirm modal, result toasts). |
| `/reports` | Report library (§5.6) | All 13 report types w/ "Simplified" maturity tags, tax-year/property filters, generate, recent-reports list, "Ask AI to build a custom report" → opens chat with context. |
| `/reports/:id` | Report viewer (§5.6) | Accessible data tables, CSV/PDF export, email-accountant modal, tax disclaimer footer. |
| `/insights` | AI Insights (§5.7) | Latest auto-generated monthly review (bottom line, net-cashflow chart, by-property, watch items — all inside the AI surface), archive of past reviews, dev "Generate now", PDF/email actions. |
| `/settings` | Settings (§5.9) | Account (name/email/tax rate/timezone), integrations connect/disconnect (mock), MCP access copy. |
| — | Responsive shell (§5.8) | Left nav ↔ bottom tab bar (<md), breadcrumbs ↔ back-arrow, chat drawer full-screen on mobile; dark mode; reduced-motion honored everywhere. |

## AI assistant (PRD §9)

- **Global chat drawer** on every screen (docked panel ≥xl, overlay below, full-screen <md); `?chat=open` deep link; context pre-loading from entry points (e.g. Reports).
- **Structured content blocks** rendered in-transcript: `text` (markdown-lite), `chart` (line/bar/donut/sparkline via the app's real chart components, semantic color roles, a11y description + table alternative), `data_table`, `action_card` (buttons executing allowlisted API calls with busy/done states, or in-app navigation), `ask_user_question`.
- **askUserQuestion** (§9.4): model pauses mid-turn with 2–4 options (+ "Other" free text); radiogroup/checkbox UI, keyboard operable; answer resumes the same assistant message; failed answers roll back and allow retry; pause state survives server restart.
- **Agent loop** (backend): Anthropic tool-use loop (max 8 iterations) over the service layer; 17 read + 7 write tools; render tools validated against the shared block schemas; tool activity indicator ("Checking your ledger…").
- **Deterministic mock mode** (no API key): regex-scripted flows — cash-flow chart, tax pause/resume → Schedule E table + open-report action, late-rent table + send-reminder action, portfolio-summary fallback — executing real tools against the seeded DB. Composer's suggested prompts match these scripts.
- **Auto monthly review** (§5.7/§9.5): daily scheduler generates last month's review (and refreshes rule-based insights) if missing; snapshot archived as a Report.
- **Inline insight cards** (§5.1): rule-generated (late rent >5 days, expense spike >125% of trailing avg, renewal window ≤60d, underperforming property <80% of portfolio per-unit avg), deduped by key so dismissals stick.

## Backend (apps/api)

- **REST API** `/api/v1/*`: properties, units, tenants, leases (incl. renewal draft + mock e-sign), transactions (CRUD, review queue, confirm, receipt scan, bank import), categories, rent (tracker, record payment, payment link, reminders), reports (library, generate, get, CSV/PDF export, email), insights (list, dismiss, monthly reviews), dashboard (KPIs, cashflow series, activity, insight), chat (sessions, SSE messages, SSE answer), settings/integrations, healthz. Every request/response validated by `@hearth/shared` Zod schemas.
- **Data model**: Account, Property, Unit, Tenant, Lease(+LeaseTenant), Category (IRS Schedule E lines), Transaction (cents, source/status/AI-suggestion fields), RentPayment (period-materialized, due-date days-late), Report (snapshotted dataJson), Insight (dedupeKey), ChatSession/ChatMessage (blocksJson, providerStateJson), Integration, AuditLog.
- **Derivation rules** (unit-tested against pinned seed constants): rent status/days-late, KPI trends vs same-day-of-month prior window, tax set-aside (current + quarterly target), tenant status precedence, insight rules.
- **Reports**: real computed data for Schedule E, P&L, Net Cashflow, Rent Roll, General Ledger, Tenant Ledger; structurally-correct simplified output for the other 7 (maturity-flagged).
- **Audit log** on every money/tenant write with actor attribution: `user`, `ai_suggested_user_confirmed`, `system` (model/MCP/scheduler).
- **Seeded demo portfolio**: 9 properties / 14 units / $13,695 rent roll; 12 paid + 2 late (Okafor 6d, Park 3d); 6 months of history; KPIs land exactly on the wireframe figures ($8,450 net MTD, 86%, $1,690/$2,700 set-aside). Idempotent reseed refreshes the demo clock.
- **Integration adapters** (interfaces + mocks): Plaid (bank import → review queue), Stripe (payment links), Docusign (envelopes), email (console). Real implementations are 1:1 swaps.
- **Auth**: single seeded demo account; optional `DEV_BEARER_TOKEN` bearer auth (web client sends it via `VITE_DEV_BEARER_TOKEN`); binds 127.0.0.1 by default.

## MCP server (PRD §10)

- Stdio entrypoint (`npm run mcp -w apps/api`), server name `hearth`, reusing the chat tool registry.
- **17 read tools** always on (portfolio summary, KPIs, series, properties, tenants, leases, renewal draft, transactions, review queue, categories, rent status, insights, reports).
- **7 write tools** only with `HEARTH_MCP_ENABLE_WRITE=true` (create/confirm transaction, record payment, send reminders, generate/email report, dismiss insight) — all audit-logged as `system`.
- **Resources**: `hearth://portfolio/summary`, `hearth://properties[/{id}]`, `hearth://rent/{period}`, `hearth://reports[/{id}]`, `hearth://insights/active`.
- Claude Desktop/Code config example in the root README.

## Cross-cutting

- **Contract package** `@hearth/shared`: all enums, entity/API schemas, chat content-block union, SSE event schemas, cents formatters — single source of truth for both apps.
- **Accessibility (WCAG 2.2 AA target, §7.1)**: skip link, landmarks, `aria-current` nav, focus traps with Esc-returns-focus, radiogroup keyboard navigation, polite live regions (announce on completion, not per token), charts with text alternatives + table views, status never color-only, visible labels + described errors on forms — enforced by axe tests in the web suite.
- **Design tokens** (§6): terracotta brand, status roles ≥4.5:1, the violet AI-surface convention via a single `AiSurface` wrapper, chart palette by semantic role, motion tokens with global reduced-motion override, dark mode.
- **Security posture**: zod validation on every route, strict localhost CORS, size-capped receipt upload, action-card API allowlist (email/settings/mutating-verb paths refused with visible notice), MCP write gating, no secrets in code.
- **Tests**: 42 backend (incl. SSE protocol, pause/resume across restart, MCP in-process client, audit attribution) + 38 frontend (incl. axe smoke over all block types, allowlist, answer-failure recovery) — all green; `npm run build` clean.

## Explicitly NOT implemented (see WHATS_NEXT.md)

Tenant portal · multi-user/roles · real Plaid/Stripe/Docusign/email/OCR calls · real PDF rendering · real-model prompt tuning (only mock mode live-verified) · per-client MCP OAuth · production auth · Postgres · CI workflow · Playwright e2e.
