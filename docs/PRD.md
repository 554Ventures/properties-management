# Hearth — Product Requirements Document

**Status:** Draft for review — not yet approved for implementation
**Source design artifact:** [Property App Wireframes](https://claude.ai/design/p/564c5159-c5b8-4a37-bbf0-79073d96d7d7) ("AI property management solution" project)
**Owner:** Anh Bien
**Last updated:** 2026-07-03

> "Hearth" is the placeholder product name used in the wireframes' wordmark. It is used throughout this document for concreteness; treat it as a working title, not a final brand decision.

---

## 1. Summary

Hearth is a web application for independent landlords and small property owner-operators (roughly 4–15 properties, single owner/operator account for v1) to manage properties, tenants, rent collection, income/expenses, and tax reporting — with an AI layer woven through the product rather than bolted on as a separate feature. AI shows up in three distinct forms:

1. **Contextual insight cards** embedded directly in ordinary screens (dashboard, tenant list, property detail) — short, specific, actionable observations, visually distinguished by a consistent design convention.
2. **A scheduled, auto-generated monthly financial review** — a shareable report the AI produces on its own cadence, not on request.
3. **A persistent, global AI chat assistant** available from anywhere in the app, capable of answering free-form questions, rendering charts/tables/action cards inline in its responses, and asking the *user* clarifying multiple-choice questions mid-conversation when a request is ambiguous.

The backend is a clean, versioned API that the frontend consumes like any other client — and that same domain layer is also exposed as an **MCP server**, so external MCP-aware clients (Claude Desktop, Claude Code, other agents the user authorizes) can query and act on a user's property data under proper authorization, using the identical underlying business logic as the in-app assistant.

This document defines scope, UX, data model, API surface, the AI/MCP architecture, and non-functional requirements (accessibility, maintainability, security) for v1. It does not include implementation code or a locked technology decision beyond a recommended stack for engineering to ratify.

---

## 2. Goals

- Give a landlord a single place to see, in under 10 seconds, whether their portfolio is healthy this month (cash flow, occupancy, rent collection, tax posture).
- Reduce manual bookkeeping by using AI to categorize expenses, read receipts, and reconcile transactions — with the human always confirming anything that affects money or taxes.
- Make "ask a question about my portfolio" as easy as asking a person, with answers that include real numbers and visuals, not just prose.
- Make the same capabilities available to power users through their own AI tools via MCP, without duplicating business logic.
- Ship a UI that feels professional and calm despite handling potentially stressful financial content — smooth, purposeful motion; no gimmicks.
- Meet WCAG 2.2 AA from day one; accessibility is not a v2 cleanup pass.

### Non-goals (v1)

- **Tenant-facing portal.** V1 is landlord/operator-only. Tenants exist in the system only as records the landlord manages (see §11 for how the data model stays ready for a phase-2 tenant portal).
- **Multi-user teams/roles.** V1 assumes one authenticated owner-operator per account. Team seats, permissions, and delegated bookkeeper access are phase 2.
- **Authoritative tax filing.** Hearth estimates, categorizes, and packages data for a human or accountant to file. It is not a certified tax preparation product and must not claim to be (see §13.4 disclaimers).
- **Native mobile apps.** V1 mobile support is a fully responsive web experience, matching the wireframes' phone-frame layouts (bottom tab bar, back-arrow navigation). Native iOS/Android is a future consideration, not in this PRD.

---

## 3. Primary persona

**Sam — independent landlord, 9 properties / 14 units.** Not a full-time property manager; has a day job. Comfortable with spreadsheets but doesn't enjoy them. Wants to know quickly "am I doing okay, is anyone late, and how much should I be setting aside for taxes" without digging. Trusts the app to flag problems but wants to make the final call on anything that touches money, tenants, or the IRS.

---

## 4. Information architecture

One persistent left navigation ("the spine") on desktop, collapsing to a bottom tab bar on mobile/narrow viewports. Every screen carries the same nav (active item highlighted) plus a breadcrumb trail on drill-down screens (a back-arrow on mobile). This structure is a hard requirement carried over directly from the wireframes' navigation map — it is the app's core usability contract.

| Nav item | Top-level screen | Drill-down |
|---|---|---|
| Dashboard | Home overview | — |
| Properties | Properties list | Property detail |
| Tenants & Leases | Tenants list | Tenant / lease detail |
| Money | Income & expenses | Add / snap receipt |
| Rent Collection | Rent tracker | Remind late tenant |
| Reports & Tax | Report library (13+ reports) | Report viewer / export |
| ✦ AI Insights | Monthly review (auto-generated) | — |
| Settings | Account, integrations, notifications | — |

A persistent **global assistant affordance** (chat bubble / drawer trigger) is available from every screen regardless of which nav item is active — it is not itself a nav destination, it's a layer above the nav. See §9.

---

## 5. Feature specifications

### 5.1 Dashboard (Home)

**Direction chosen:** the wireframes' "Classic KPI overview" (Variant A) — a traditional, information-dense dashboard where AI appears as one supporting element among several, not the organizing principle of the page. This suits a persona who wants a fast factual read before anything else.

Contents:
- Greeting header with portfolio-at-a-glance context (property count, unit count, current month) and a primary "Add transaction" action.
- Four KPI tiles: net cash flow (MTD), rent collected (% and progress bar), expenses (MTD), estimated tax set-aside — each with a small trend indicator.
- A 6-month income vs. expense chart.
- One AI insight card surfaced alongside the chart — a specific, dismissible observation with a primary action (e.g., "Review") and a secondary dismiss. Never more than one insight card competes for attention on the dashboard; additional insights live in the AI Insights screen and the assistant.
- Recent activity feed (last N transactions/events, chronological).

Acceptance criteria:
- KPI tiles load with skeleton states, never layout-shift once data arrives.
- The insight card's content is generated server-side (see §9.4) and cached per day per user; dismissing it hides that specific insight until a materially new one is generated (not just re-shown on refresh).
- All KPI tiles are keyboard-focusable and expose their value via accessible text, not only a bar/graphic.

### 5.2 Properties

- **List:** table of properties — address, unit count, occupancy %, rent/mo, status (Full / N vacant / N late), with status conveyed by text label + icon, not color alone.
- **Detail:** per-property P&L, unit list with per-unit status, property-level AI insight card (e.g., underperformance vs. portfolio average), and lease/document links.
- Add-property flow: address, unit configuration, opening rent roll — kept intentionally simple for v1 (no MLS/listing integration).

### 5.3 Tenants & Leases

- **List:** all active leases — tenant, unit, rent, lease end date, status (Current / Renew soon / Late), with a portfolio-level AI insight when applicable (e.g., renewals approaching with a market-rent suggestion).
- **Detail:** tenant contact info, lease terms, document list, payment history, and a "Draft renewal" action.
- **Lease e-signature (Docusign):** renewal and new-lease documents are sent for e-signature via Docusign; envelope status (sent / viewed / signed) is reflected on the tenant/lease detail screen. Hearth does not build its own signature/legal-terms editor — it composes from a firm-provided or Hearth-provided lease template and hands it to Docusign for execution.

### 5.4 Money (income & expenses)

- Manual entry form: amount, type (income/expense), property, category — with AI-suggested category shown as a distinct "AI guess" chip the user confirms or overrides (never silently auto-applied to a saved transaction).
- **Snap-a-receipt:** photo/drag-drop capture → OCR + categorization pipeline reads vendor, amount, and suggested category/property match, and pre-fills the entry form for user confirmation. This is assistive data entry, not autonomous bookkeeping — every AI-populated transaction requires an explicit save.
- **Bank feed sync (Plaid):** connected bank/credit accounts import transactions automatically; imported transactions go through the same AI categorization step and land in a review queue rather than posting directly, so the user always has a confirm/edit step before a transaction is considered final for reporting/tax purposes.

### 5.5 Rent Collection

- Monthly rent tracker: collected vs. outstanding totals, per-tenant paid/late status, bulk and individual "Remind" actions.
- **Online payments (Stripe/ACH):** tenants can be sent a payable link (email/SMS) to pay rent via ACH or card; payment status here reflects real transaction state (pending/settled/failed), not just a manual "mark as paid" toggle. Manual/offline payment recording (check, cash) remains available and is clearly distinguished from online-collected payments in the ledger.
- This screen intentionally has no AI insight banner in the wireframes — status tracking here is meant to read as deterministic and trustworthy; AI commentary about rent trends belongs on the Dashboard/AI Insights, not embedded in the collection ledger itself.

### 5.6 Reports & Tax

- **Report library:** Balance Sheet, Income Statement, P&L, Net Cashflow, Rent Roll, Schedule of Real Estate Owned, Capital Expenses, General Ledger, Tenant Ledger, Escrow Ledger, Schedule E, Tax Package, Stress Test — generated from the same underlying ledger data, filterable by tax year and property.
- **"Ask AI to build a custom report"** entry point: routes into the global assistant with report-building context pre-loaded (see §9), rather than a separate custom-report builder UI — one less thing to design and maintain twice.
- **Schedule E summary:** per-property rents/repairs/other/net table with totals, depreciation auto-calculated from asset/improvement records, estimated taxable income, and a "reconciliation confidence" indicator (e.g., "3 expenses may be miscategorized — review before filing").
- **Tax Package:** review queue of AI-sorted transactions into IRS categories, with explicit human decision required on ambiguous items (e.g., repair vs. capital improvement — this determines depreciation treatment and must never be auto-resolved), and a year-end export bundle (Schedule E summary, depreciation schedule, categorized ledger CSV, receipt images archive).
- **Export destinations:** PDF, CSV, "email to accountant" (send a copy via email with the user's own accountant contact), and QuickBooks-compatible export. No live two-way QuickBooks sync in v1 — one-way export only, to avoid taking on reconciliation-conflict handling this early.

### 5.7 AI Insights

**Direction chosen:** the wireframes' "Auto monthly review" (Variant 2) is the primary and only content of this screen in v1 — a scheduled, auto-generated report (not a chat interface). Rationale: the conversational, ask-anything experience is fully covered by the **global assistant** (§9), which is available everywhere, so this screen's job is specifically to be the place where Hearth *proactively* tells the user what it noticed, on its own schedule, without being asked.

Contents: a "bottom line" summary card, a net-cash-flow trend chart, a by-property breakdown, 2–3 specific watch items with recommended actions, and export/share actions (PDF, email to accountant). Generated automatically on a monthly cadence (see §9.5) and archived so past months remain viewable.

### 5.8 Mobile / responsive behavior

All of the above adapt to a narrow-viewport layout: left nav becomes a bottom tab bar (Home / Money / Add / Rent / Tax), drill-down screens use a back-arrow instead of a breadcrumb, and the same components restack into single-column layouts. The global assistant becomes a full-screen chat view on mobile rather than a side drawer. No content or capability is dropped on mobile — only the chrome adapts.

### 5.9 Settings

Out of wireframe scope but required for a shippable v1: account/profile, connected integrations (bank via Plaid, Stripe payouts, Docusign, email), notification preferences, and data export/account deletion. Kept intentionally minimal for v1 given the single-owner-account model.

---

## 6. Design system direction

The wireframes' hand-drawn aesthetic (Caveat/Kalam fonts, thick black borders, flat offset shadows, sketch-style bars) is explicitly a **wireframing convention**, confirmed by the source doc's own annotations — it exists to let a reviewer evaluate layout and content without being distracted by finished visuals, and is not meant to ship. The production UI should be built as a professional, polished interface, while preserving the structural conventions that carry real product meaning:

- **The AI-content convention is the one thing that must survive into production:** a consistent, distinct visual treatment (e.g., a subtle accent border/background + a small "AI" indicator) marks *any* AI-authored or AI-suggested content anywhere in the app — insight cards, suggested categories, chat responses, auto-reports — so a user always knows at a glance what came from the AI versus what is their own deterministic data. This is not decorative; it's a trust and legibility requirement, and should be codified as a design token (`surface-ai`, `border-ai`, etc.), not a one-off style.
- **Status must never rely on color alone** — the wireframes already pair status color with text labels ("Full", "1 vacant", "6 days late"); production should keep pairing color with text/icon for WCAG compliance.
- **Motion:** transitions should communicate state changes (route changes, drawer open/close, chat message streaming, chart entrance) — subtle, fast (150–250ms), and respect `prefers-reduced-motion`. Motion is for clarity, not spectacle.
- **Charts:** the wireframes fake charts with styled `div`s; production needs a real charting approach with accessible markup (text alternatives, keyboard-navigable data points, sufficient color contrast between series). Engineering should apply the project's `dataviz` design skill for palette, mark, and layout conventions so charts across the dashboard, reports, and chat responses read as one consistent system.
- **Component quality bar:** engineering should apply the project's `artifact-design`-equivalent judgment to every shipped screen — polish should match the seriousness of the data (financial/tax), not feel like a demo.

---

## 7. Non-functional requirements

### 7.1 Accessibility (WCAG 2.2 AA)

- Full keyboard operability for every interactive element, including the chat assistant, charts, and modals; visible focus indicators throughout.
- Correct semantic structure (landmarks, heading hierarchy, table markup for tabular reports) so screen readers can navigate the app the same way sighted users do via the nav/breadcrumb structure.
- Color contrast ≥ 4.5:1 for text, ≥ 3:1 for meaningful non-text UI (chart series boundaries, status icons).
- Live regions for asynchronous content: streaming chat responses, newly generated insight cards, and toast notifications must be announced without disrupting the user's current focus.
- Forms (transaction entry, receipt review, tenant/lease forms) have properly associated labels, inline error messaging tied to the field via `aria-describedby`, and never rely on placeholder text as the only label.
- All motion respects `prefers-reduced-motion: reduce`.
- Accessibility is a merge-blocking check (automated axe-core scan in CI + manual keyboard/screen-reader pass per release), not a periodic audit.

### 7.2 Maintainability

- Backend exposes a single, versioned, documented API (OpenAPI spec checked into the repo) that is the **only** way the frontend (or any client) reads/writes data — no frontend-only business logic duplicating server rules.
- Typed contracts end-to-end: API schema is the source of truth for both backend validation and generated frontend types, so a contract change is a compile-time error on both sides, not a runtime surprise.
- Domain/business logic lives in a service layer independent of the transport (REST controllers, chat tool-handlers, and the MCP server all call the *same* service functions — see §9.2), so a rule only needs to be correct and tested once.
- Design tokens (color, spacing, type, the AI-surface convention from §6) are defined once and consumed by every component — no ad hoc hex values in component code.
- Test strategy: unit tests on the service layer (business rules — categorization confidence thresholds, tax calculations, rent-status derivation), contract tests on the API, and end-to-end tests for the core flows (add transaction, receipt capture, send reminder, generate report, chat round-trip including an askUserQuestion interaction).

### 7.3 Security & compliance

- Financial account credentials never touch Hearth's servers directly — bank connections go through Plaid's token exchange; payment details go through Stripe; Hearth stores only the resulting tokens/references, not raw credentials.
- All financial data encrypted at rest and in transit; audit log for any AI-initiated or AI-suggested action that was accepted by the user (category applied, reminder sent, report generated, tag applied via chat) — who/what/when, since this touches money and tax reporting.
- External MCP access (§10) is scoped and user-authorized per client, revocable at any time from Settings, and read-only by default — write/action tools require an explicit additional grant.
- Tax-related surfaces (Schedule E, Tax Package, AI insights referencing tax amounts) carry a persistent, unambiguous disclaimer that Hearth provides estimates and organization, not tax or legal advice, and recommend confirming with a licensed professional before filing.

### 7.4 Performance

- Dashboard and list views target sub-second perceived load via skeleton states and incremental data fetching (KPIs first, chart/detail data streamed in after).
- Chat responses stream token-by-token where the underlying model supports it, with structured content (charts/cards/questions) rendered as soon as that portion of the response resolves, not held until the entire message completes.

---

## 8. Data model (v1 core entities)

| Entity | Key fields | Notes |
|---|---|---|
| `Account` | owner profile, timezone, tax year settings | Single owner-operator per account in v1; designed so a future `Membership`/role table can be added without reshaping this entity. |
| `Property` | address, unit count, acquisition date/cost (for depreciation) | |
| `Unit` | property_id, unit label, status (vacant/occupied) | |
| `Lease` | unit_id, tenant_id(s), rent amount, term start/end, status, e-sign envelope ref | |
| `Tenant` | contact info, linked lease(s) | No login/portal in v1 — a record, not a user. |
| `Transaction` | property_id, unit_id?, amount, type (income/expense), category, source (manual/receipt-ocr/bank-feed), confidence, status (pending-review/confirmed), receipt attachment ref | Central ledger entity; every report is derived from this table. |
| `Category` | IRS-aligned expense/income categories | Seeded, user-extensible. |
| `RentPayment` | lease_id, period, amount, method (online/manual), status | Distinct from generic `Transaction` so payment-processor state (pending/settled/failed) is tracked precisely. |
| `Report` | type, period/tax year, property scope, generated_at, source data snapshot | Generated on demand or on schedule; snapshotted so a filed year's report doesn't silently change if categorization changes later. |
| `Insight` | scope (portfolio/property/tenant), type, text, related entity refs, status (active/dismissed/actioned) | Backs both dashboard insight cards and the AI Insights monthly review. |
| `ChatSession` / `ChatMessage` | session_id, role, content blocks (text/chart/table/action_card/ask_user_question), tool calls/results | See §9.3 for the message content-block schema. |
| `Integration` | type (plaid/stripe/docusign/email), external ref, status, scopes granted | Also backs external MCP client authorizations. |

---

## 9. The AI assistant

### 9.1 Where it lives

A persistent, globally-available chat surface (desktop: slide-out drawer or docked panel; mobile: full-screen view), reachable from every screen without losing the user's place. It is the app's single conversational AI surface — the "Ask AI to build a custom report" entry point (§5.6) and any other "ask AI about this" affordance route into this same assistant with context pre-loaded, rather than spawning separate mini-chat experiences.

### 9.2 Architecture

A shared **service layer** implements the actual capabilities (query transactions, compute rent status, categorize a transaction, send a reminder, generate a report, draft a lease renewal, etc.) independent of how it's invoked. Three surfaces call into it:

1. **REST API** — used by the frontend for standard CRUD/read screens.
2. **In-app assistant tool-calling** — the chat backend runs an agent loop against the same service functions, exposed to the model as tools (function-calling), so the assistant's answers and actions are backed by the identical logic the rest of the app uses (no separate "AI math" that can drift from the real ledger).
3. **External MCP server** (§10) — the same service functions, wrapped as MCP tools/resources, for authorized external MCP clients.

This keeps business logic single-sourced: a fix to, say, rent-status calculation is correct everywhere at once.

### 9.3 Rendering charts, tables, and action cards in chat

Chat messages are structured, not plain strings. Each assistant message is composed of one or more typed content blocks so the frontend can render each appropriately instead of parsing markdown for meaning:

- `text` — prose.
- `chart` — a chart spec (kind: line/bar/donut/sparkline; series; data; axis/units; a semantic color role such as *positive/warning/neutral* rather than a raw color) rendered with the app's real charting component, keeping visual consistency with dashboard/report charts and following the same accessibility requirements (§7.1).
- `data_table` — structured tabular data (e.g., the "roof repair $1,200 / higher utilities $640" comparison from the wireframes) rendered as a real, accessible table, not an ASCII-art approximation.
- `action_card` — a suggested action with one or more buttons (e.g., "Tag it", "Add to report", "Send reminder") that, when clicked, invoke the corresponding service-layer action through the normal API — the assistant never silently takes a financial or tenant-facing action on its own; every action surfaced this way requires an explicit user click.
- `ask_user_question` — see §9.4.

### 9.4 `askUserQuestion`: the assistant asks the user

When the assistant's next step is genuinely ambiguous — not a fact it should already know from the user's data, but a preference or decision only the user can make — it emits an `ask_user_question` block instead of guessing or asking an open-ended follow-up in prose. This mirrors the same interaction pattern used to gather requirements for *this* PRD:

- A short question, 2–4 mutually exclusive options (plus an implicit "Other" free-text fallback), each with a one-line description of what choosing it means.
- Optional `multiSelect` when options aren't mutually exclusive.
- Rendered inline in the transcript as tappable choice chips/buttons (not a native OS dialog), so it reads as part of the conversation and remains fully keyboard/screen-reader operable.
- The user's selection is sent back as a structured answer (which option, plus free text if "Other"/notes were used), and the assistant continues the same turn using that answer as a hard constraint — it does not re-ask or ignore the answer.

Example from the domain: user asks "help me get ready for taxes" → assistant asks (single-select): *"Which tax year?"* with the last 2 tax years plus "Other" — rather than assuming, or worse, silently defaulting to the current year and producing a wrong package.

Guardrail: this feature is for resolving genuine ambiguity, not for the assistant to defer default judgment calls it's equipped to make (e.g., it should not ask "should I use blue or green for this chart" — only decisions with real product/financial consequence for the user).

### 9.5 Scheduled generation (AI Insights monthly review)

A background job runs monthly per account, invoking the same report/insight service-layer functions used elsewhere, producing a snapshotted `Report` + a set of `Insight` records, and notifying the user (in-app + optional email) that the review is ready. Past months remain archived and viewable, not regenerated in place.

### 9.6 Model & provider

Recommend Anthropic's Claude models via the Claude API for both the in-app assistant and any AI-assisted categorization/OCR reasoning, given the tool-calling and structured-output needs described above; vision-capable calls handle receipt image reading. This is a recommendation for engineering to confirm during technical design, not a locked decision in this PRD.

---

## 10. External MCP server

**Purpose:** let a user's own AI tools (Claude Desktop, Claude Code, other MCP-aware agents they authorize) query and act on their Hearth data directly, under explicit, revocable authorization — using the exact same service-layer logic as the in-app assistant, so answers a user gets from their own tools are never out of sync with what the app itself would say.

Key design points for the technical design phase:

- **Auth:** OAuth-based authorization flow (per the MCP spec) scoped to a single Hearth account; tokens are visible and revocable from Settings → Integrations at any time.
- **Default posture: read-only.** Resources exposed by default: portfolio summary, property/unit details, rent status, transaction history, generated reports. Write/action tools (send a reminder, categorize a transaction, generate a new report, draft a lease renewal) require an explicit additional grant during authorization — mirroring the in-app assistant's rule that anything affecting money or tenants needs an explicit human-approved step, just moved to authorization-time instead of click-time for this surface.
- **Same tool definitions, two adapters:** the tool/resource definitions given to the external MCP server should be the same functions the in-app assistant calls internally (§9.2), just wrapped with MCP's resource/tool protocol and per-client auth scoping, so there is one place capability logic is defined and tested.
- **Non-goal for v1:** the external MCP server does not need to support its own conversational UI or `ask_user_question`-style flows — that's the calling MCP client's job (e.g., Claude Desktop's own chat). Hearth's MCP server just needs to expose correct, well-scoped resources and tools.

---

## 11. Forward-compatibility for tenant portal (not built in v1)

Although out of scope, the following v1 decisions are made specifically so a phase-2 tenant portal doesn't require a data-model rework:

- `Tenant` is already a distinct entity from `Account`, so adding tenant login/auth later is additive, not a migration.
- `RentPayment` already models payment method and processor status independent of who initiated it, so a future tenant-initiated payment fits the existing shape.
- `Lease` already carries an e-signature envelope reference, which a tenant portal could surface directly (view/sign own lease) without new fields.

---

## 12. Third-party integrations summary

| Integration | Purpose | v1 depth |
|---|---|---|
| Plaid | Bank feed sync for transactions | Real, two-way import into review queue |
| Stripe | Online rent payments (ACH/card) | Real payment processing + payout tracking |
| Docusign | Lease/renewal e-signature | Real envelope creation, status tracking |
| Anthropic Claude API | Chat assistant, categorization reasoning, receipt OCR/vision | Core to product |
| Email provider (TBD) | "Email accountant", notifications, reminders | Transactional email only |
| QuickBooks / CSV / PDF | Accounting/tax export | One-way export only, no live sync |

---

## 13. Risks & open questions

1. **Tax liability framing.** Legal review needed on exact disclaimer language before any Schedule E / tax-package feature ships, given the product computes real estimated-tax figures.
2. **Categorization trust threshold.** Needs a concrete confidence-score policy: below what threshold does a transaction get routed to the "needs a human eye" queue vs. accepted with a lightweight confirm?
3. **MCP write-scope UX.** The authorization screen for granting an external MCP client write access (send reminders, categorize transactions on the user's behalf) needs its own careful design pass — this is a real trust/security surface, not a simple toggle.
4. **Rate/cost of AI usage.** Chat, monthly auto-reports, and receipt OCR all call the model; needs a usage/cost model before broad rollout (e.g., per-account monthly AI budget or plan tiering).
5. **Product naming.** "Hearth" is a wireframe placeholder — confirm before any branding work begins.

---

## 14. Suggested phasing

- **Phase 1 (v1, this PRD):** Dashboard, Properties, Tenants & Leases (incl. Docusign), Money (incl. Plaid + receipt OCR), Rent Collection (incl. Stripe), Reports & Tax, AI Insights (monthly review), global chat assistant (incl. chart/table/action-card rendering and `askUserQuestion`), external MCP server (read-only + opt-in write tools).
- **Phase 2:** Tenant portal, multi-user/team roles, live QuickBooks sync, native mobile.
- **Phase 3:** Whatever Phase 1 usage data suggests — e.g., expanding the AI Insights cadence beyond monthly, or a custom-report builder if "ask AI to build a report" usage shows recurring unmet patterns.

---

## 15. Appendix

- Full wireframe reference: `Property App Wireframes.dc.html`, Claude Design project `564c5159-c5b8-4a37-bbf0-79073d96d7d7`.
- Design direction decisions in this PRD (Dashboard = Variant A "Classic KPI"; AI Insights = Variant 2 "Auto monthly review", with the conversational mode absorbed into the global assistant rather than being a separate AI Insights sub-page) were confirmed directly by the product owner during PRD drafting and supersede the wireframe doc's own "pick one" prompt.
