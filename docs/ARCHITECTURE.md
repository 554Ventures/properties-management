# Hearth — v1 Implementation Plan

**Approach summary.** A three-package npm-workspaces monorepo where `packages/shared` (Zod) is the frozen contract both `apps/api` (Fastify + Prisma/Postgres — local dev/tests use an npm-managed embedded Postgres, production uses Supabase; deployment plan §4.2) and `apps/web` (React/Vite/Tailwind/TanStack Query) compile against. All business rules live in `apps/api/src/services/*` — REST controllers, the chat agent's tool handlers, and the MCP server are three thin adapters over the same functions (PRD §9.2). The MCP server is a **second entrypoint inside `apps/api`** (`src/mcp/`), not a separate package: it needs the Prisma client, the service layer, and the seeded DB, and a thin `apps/mcp` package would only re-export those with extra wiring; the `@modelcontextprotocol/sdk` dependency is small and stdio transport needs no HTTP server. AI runs through a single `AiClient` interface with a real Anthropic implementation (`claude-sonnet-5`, override via `ANTHROPIC_MODEL`) and a deterministic `MockAiClient` used whenever `ANTHROPIC_API_KEY` is unset, so the entire app demos offline. Auth has two modes (deployment plan §4.1): demo mode — the seeded demo account with an optional static bearer token (`DEV_BEARER_TOKEN`), still the no-env default so the app demos offline — and Supabase mode (`SUPABASE_JWT_SECRET` or `SUPABASE_URL` set), where every request carries a Supabase Auth JWT that `plugins/auth.ts` verifies and `services/auth.service.ts` maps/provisions to an `Account` + `User`. Every service function takes `accountId` as its first argument, which is the tenancy boundary in both modes.

---

## 1. Repo layout

```
/Users/anhbien/Documents/Code/PropertiesAI
├── package.json                  # workspaces: ["packages/*", "apps/*"]; root scripts: dev, build, test, seed
├── tsconfig.base.json
├── .env.example                  # ANTHROPIC_API_KEY, ANTHROPIC_MODEL, DATABASE_URL, DEV_BEARER_TOKEN, HEARTH_MCP_ENABLE_WRITE
├── docs/
│   ├── PRD.md
│   └── ARCHITECTURE.md           # this file
├── packages/
│   └── shared/
│       ├── package.json          # name: @hearth/shared
│       └── src/
│           ├── index.ts
│           ├── enums.ts          # all enum string-unions + zod enums (source of truth; DB stores strings)
│           ├── money.ts          # cents helpers: formatUsd(cents), Cents type
│           ├── schemas/
│           │   ├── account.ts  property.ts  unit.ts  tenant.ts  lease.ts
│           │   ├── transaction.ts  category.ts  rent.ts  report.ts  insight.ts
│           │   ├── dashboard.ts  integration.ts
│           │   ├── chat-blocks.ts    # content-block discriminated union (§5)
│           │   ├── chat.ts           # session/message/answer schemas + SSE event schemas
│           │   └── api.ts            # per-route request/response schema exports
│           └── types.ts          # z.infer re-exports
├── apps/
│   ├── api/
│   │   ├── package.json          # name: @hearth/api
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   ├── seed.ts           # implements §10
│   │   │   └── dev.db            # gitignored
│   │   └── src/
│   │       ├── server.ts         # Fastify bootstrap (entry: npm run dev -w apps/api)
│   │       ├── app.ts            # buildApp() for tests
│   │       ├── plugins/          # auth.ts (demo bearer / Supabase JWT), zod-validation.ts, error-handler.ts, sse.ts
│   │       ├── routes/           # one file per resource group (§3): properties.ts, units.ts, tenants.ts,
│   │       │                     #   leases.ts, transactions.ts, categories.ts, rent.ts, reports.ts,
│   │       │                     #   insights.ts, dashboard.ts, chat.ts, settings.ts
│   │       ├── services/         # §4: property.service.ts, unit.service.ts, tenant.service.ts,
│   │       │                     #   lease.service.ts, transaction.service.ts, category.service.ts,
│   │       │                     #   rent.service.ts, report.service.ts, insight.service.ts,
│   │       │                     #   dashboard.service.ts, chat.service.ts, integration.service.ts
│   │       ├── ai/
│   │       │   ├── client.ts     # AiClient interface + factory (real vs mock on env)
│   │       │   ├── anthropic.ts  # @anthropic-ai/sdk impl
│   │       │   ├── mock.ts       # deterministic MockAiClient (§6)
│   │       │   ├── mock-scripts.ts
│   │       │   ├── agent-loop.ts # tool-use loop, pause/resume (§6)
│   │       │   ├── tools.ts      # tool definitions → service bindings (shared with MCP)
│   │       │   └── prompts.ts
│   │       ├── integrations/     # adapter interfaces + mocks only
│   │       │   ├── types.ts      # PlaidAdapter, StripeAdapter, DocusignAdapter, EmailAdapter
│   │       │   └── mock/         # mock-plaid.ts, mock-stripe.ts, mock-docusign.ts, mock-email.ts
│   │       ├── mcp/
│   │       │   ├── index.ts      # entry: npm run mcp -w apps/api (stdio)
│   │       │   ├── tools.ts      # wraps ai/tools.ts defs as MCP tools
│   │       │   └── resources.ts
│   │       ├── lib/              # prisma.ts (singleton), dates.ts (period math), csv.ts, pdf.ts
│   │       └── __tests__/        # vitest: services/*.test.ts, routes/*.test.ts, agent-loop.test.ts
│   └── web/
│       ├── package.json          # name: @hearth/web
│       ├── index.html  vite.config.ts  tailwind.config.ts
│       └── src/
│           ├── main.tsx  router.tsx  api/client.ts  api/queries.ts  api/sse.ts
│           ├── styles/tokens.css             # design tokens incl. --surface-ai (§8)
│           ├── components/
│           │   ├── shell/        # AppShell, SideNav, BottomTabBar, Breadcrumbs, PageHeader
│           │   ├── ui/           # Button, Card, Badge/StatusBadge, Table, Skeleton, Modal,
│           │   │                 #   Toast, EmptyState, FormField, Select, Drawer
│           │   ├── charts/       # ChartContainer, LineChart, BarChart, DonutChart, Sparkline (Recharts)
│           │   ├── ai/           # AiSurface (wrapper), InsightCard, AiChip (suggested category)
│           │   └── chat/         # ChatDrawer, ChatTranscript, ChatComposer, blocks/
│           │                     #   TextBlock, ChartBlock, DataTableBlock, ActionCardBlock,
│           │                     #   AskUserQuestionBlock
│           └── pages/            # Dashboard, PropertiesList, PropertyDetail, TenantsList,
│                                 #   TenantDetail, Money, MoneyReview, AddTransaction, RentTracker,
│                                 #   Reports, ReportViewer, Insights, Settings
```

---

## 2. Prisma schema

**Conventions (binding):** no Prisma `enum` or `Decimal` — all enums are `String` columns validated by Zod enums in `@hearth/shared` (each column commented with its enum; native Postgres enums deliberately deferred so the shared package stays the single source of truth), and **all money is integer cents** (`Int`, suffix `Cents`). All ids are `cuid()`. Every root entity carries `accountId` for multi-tenancy. Schema changes ship as Prisma migrations (`prisma/migrations`).

Enums (defined in `packages/shared/src/enums.ts`):

- `TransactionType`: `income | expense`
- `TransactionSource`: `manual | receipt | bank`
- `TransactionStatus`: `pending_review | confirmed`
- `RentPaymentStatus`: `due | processing | paid | failed`
- `RentPaymentMethod`: `online | manual`
- `LeaseStatus`: `active | ended | pending_signature`
- `EsignStatus`: `sent | viewed | signed`
- `ReportType`: `balance_sheet | income_statement | pnl | net_cashflow | rent_roll | reo_schedule | capital_expenses | general_ledger | tenant_ledger | escrow_ledger | schedule_e | tax_package | stress_test | monthly_review`
- `InsightScope`: `portfolio | property | tenant`
- `InsightStatus`: `active | dismissed | actioned`
- `InsightSeverity`: `info | warning | positive`
- `IntegrationType`: `plaid | stripe | docusign | email | mcp_client`
- `IntegrationStatus`: `connected | disconnected | mock`
- `ChatRole`: `user | assistant`
- `ChatSessionStatus`: `idle | running | awaiting_user`

Models (field → type; `?` optional; relations noted):

**Account** — `id`, `name String`, `email String @unique`, `timezone String @default("America/New_York")`, `taxRatePct Int @default(20)`, `taxYearStartMonth Int @default(1)`, `graceDays Int @default(0)`, `createdAt DateTime`. Relations: has many of everything below. (Future `Membership` table attaches here without reshaping.)

**Property** — `id`, `accountId`, `nickname String?`, `addressLine1 String`, `city String`, `state String`, `zip String`, `acquisitionDate DateTime?`, `acquisitionCostCents Int?`, `notes String?`, `archivedAt DateTime?`, `createdAt`. Relations: `units Unit[]`, `transactions Transaction[]`, `insights Insight[]`. (`unitCount`, occupancy, status are **derived** in the service, not stored.)

**Unit** — `id`, `propertyId`, `label String` (e.g. "Unit A", "Main"), `bedrooms Int?`, `bathrooms Float?`, `marketRentCents Int?`, `archivedAt DateTime?`. Relations: `leases Lease[]`. Occupancy status derived: occupied iff an `active` lease exists.

**Tenant** — `id`, `accountId`, `fullName String`, `email String?`, `phone String?`, `notes String?`, `archivedAt DateTime?`, `createdAt`. Relations: `leaseTenants LeaseTenant[]`. No login in v1.

**Soft archive** (`archivedAt` on Property/Unit/Tenant) — DELETE stamps `archivedAt` instead of removing the row; archived entities are filtered from list/active-portfolio derivations but resolve via detail and are restorable. Blocked while an `active` lease exists. Leases have no `archivedAt` — terminating sets `status = ended`.

**Lease** — `id`, `unitId`, `rentCents Int`, `dueDay Int @default(1)`, `startDate DateTime`, `endDate DateTime`, `status String` (LeaseStatus), `esignEnvelopeId String?`, `esignStatus String?` (EsignStatus), `createdAt`. Relations: `unit`, `leaseTenants LeaseTenant[]`, `rentPayments RentPayment[]`. ("Renew soon" is derived: `endDate` within 60 days.)

**LeaseTenant** (join) — `leaseId`, `tenantId`, `isPrimary Boolean @default(true)`, `@@id([leaseId, tenantId])`.

**Category** — `id`, `accountId?` (null = system-seeded), `name String`, `type String` (TransactionType), `irsScheduleELine String?` (e.g. "Line 14 – Repairs"), `isSystem Boolean @default(false)`. Seeded IRS-aligned set; user-extensible.

**Transaction** — `id`, `accountId`, `propertyId String?`, `unitId String?`, `categoryId String?`, `date DateTime`, `amountCents Int` (always positive; sign from `type`), `type String` (TransactionType), `description String`, `vendor String?`, `source String` (TransactionSource), `status String` (TransactionStatus), `aiSuggestedCategoryId String?`, `aiConfidence Float?`, `receiptUrl String?`, `createdAt`, `updatedAt`. Indexes: `@@index([accountId, date])`, `@@index([accountId, status])`. Central ledger; all reports derive from confirmed rows.

**RentPayment** — `id`, `leaseId`, `period String` ("YYYY-MM"), `dueDate DateTime` (materialized when the month's expected rows are created; enables exact days-late), `amountCents Int`, `method String?` (RentPaymentMethod, null until paid), `status String` (RentPaymentStatus), `paidAt DateTime?`, `externalRef String?` (mock Stripe id), `transactionId String? @unique` (ledger Transaction created on payment), `remindedAt DateTime?`. `@@unique([leaseId, period])`.

**Report** — `id`, `accountId`, `type String` (ReportType), `title String`, `periodStart DateTime`, `periodEnd DateTime`, `taxYear Int?`, `propertyId String?` (null = portfolio), `dataJson String` (snapshot — a filed year never silently changes), `generatedAt DateTime`.

**Insight** — `id`, `accountId`, `scope String` (InsightScope), `type String` (rule id, e.g. `late_rent`, `expense_spike`, `renewal_window`, `underperforming_property`), `severity String` (InsightSeverity), `title String`, `body String`, `actionLabel String?`, `actionTarget String?` (frontend route or API action ref), `propertyId String?`, `tenantId String?`, `leaseId String?`, `dedupeKey String` (e.g. `late_rent:tenant_okafor:2026-07` — dismissal sticks until a materially new key is generated, per PRD §5.1), `status String` (InsightStatus), `createdAt`. `@@unique([accountId, dedupeKey])`.

**ChatSession** — `id`, `accountId`, `title String?`, `status String` (ChatSessionStatus), `providerStateJson String?` (serialized Anthropic `messages[]` + pending `tool_use_id` while `awaiting_user`), `createdAt`, `updatedAt`. Relations: `messages ChatMessage[]`.

**ChatMessage** — `id`, `sessionId`, `role String` (ChatRole), `blocksJson String` (ContentBlock[] per §5), `createdAt`.

**Integration** — `id`, `accountId`, `type String` (IntegrationType), `name String`, `status String` (IntegrationStatus), `externalRef String?`, `scopesJson String @default("[]")`, `createdAt`. Also the future home of external MCP client authorizations.

**AuditLog** — `id`, `accountId`, `actor String` ("user" | "ai_suggested_user_confirmed" | "system"), `action String`, `entityType String`, `entityId String`, `detailJson String?`, `createdAt`. (PRD §7.3 — cheap now, painful later.)

---

## 3. API contract

Base path `/api/v1`. All request/response Zod schemas live in `packages/shared/src/schemas/api.ts` (names below are exports). Auth: `Authorization: Bearer ${DEV_BEARER_TOKEN}` if set, else open on localhost. Errors: `{ error: { code, message, fields? } }` (`ApiErrorSchema`).

**Properties**
| Method/Path | Request → Response |
|---|---|
| GET `/properties` | — → `PropertyListResponse` (array of `PropertyWithStats`: property + `unitCount`, `occupiedCount`, `monthlyRentCents`, `statusLabel` e.g. "Full"/"1 vacant"/"1 late") |
| POST `/properties` | `CreatePropertyInput` (address fields + `units: CreateUnitInput[]`) → `Property` |
| GET `/properties/:id` | — → `PropertyDetailResponse` (property, units w/ lease+tenant+status, `pnl: PnlSummary` MTD/YTD, `insights: Insight[]`) |
| PATCH `/properties/:id` | `UpdatePropertyInput` → `Property` |
| DELETE `/properties/:id` | — → 204 (soft-archive; 409 if a unit has an active lease) |
| POST `/properties/:id/restore` | — → `Property` (un-archive) |
| GET `/properties/:id/pnl?from&to` | → `PropertyPnlResponse` (income/expense by category + net) |

**Units** — POST `/properties/:id/units` (`CreateUnitInput` → `Unit`), PATCH `/units/:id` (`UpdateUnitInput`), DELETE `/units/:id` (soft-archive), POST `/units/:id/restore` → `Unit`.

**Tenants** — GET `/tenants` → `TenantListResponse` (rows: tenant, unit/property, `rentCents`, `leaseEndDate`, `status: current|renew_soon|late`); POST `/tenants` (`CreateTenantInput`); GET `/tenants/:id` → `TenantDetailResponse` (contact, leases, `paymentHistory: RentPaymentRow[]`, documents); PATCH `/tenants/:id`; DELETE `/tenants/:id` (soft-archive); POST `/tenants/:id/restore` → `Tenant`.

**Leases** — GET `/leases?status`; GET `/leases/:id` → `LeaseDetailResponse` (`lease: LeaseWithContext` — unitLabel/propertyLabel/tenants — + `rentPayments`); POST `/leases` (`CreateLeaseInput`: unitId, tenantIds, rentCents, dueDay, start/end); PATCH `/leases/:id`; POST `/leases/:id/terminate` → `Lease` (status→ended); POST `/leases/:id/tenants` (`AddLeaseTenantInput`) and DELETE `/leases/:id/tenants/:tenantId` → `LeaseWithContext` (co-tenants; can't remove last, primary auto-promotes); POST `/leases/:id/renewal` (`AcceptRenewalInput`) → `Lease` (immediate switchover: new active lease, source ended); POST `/leases/:id/renewal-draft` → `RenewalDraftResponse` (proposed terms incl. `suggestedRentCents` from market-rent heuristic); POST `/leases/:id/esign` → `EsignEnvelopeResponse` (mock Docusign envelope + status). New management schemas live in `schemas/lease-management.ts`.

**Transactions**
| Method/Path | Request → Response |
|---|---|
| GET `/transactions?from&to&propertyId&type&status&categoryId&cursor&limit` | → `TransactionListResponse` (items + `nextCursor`) |
| POST `/transactions` | `CreateTransactionInput` → `Transaction` (if `categoryId` omitted, response carries `aiSuggestedCategoryId`+`aiConfidence` for the "AI guess" chip; save always explicit) |
| PATCH `/transactions/:id` | `UpdateTransactionInput` → `Transaction` |
| DELETE `/transactions/:id` | → 204 |
| GET `/transactions/review` | → `ReviewQueueResponse` (pending_review items w/ suggestions) |
| POST `/transactions/:id/confirm` | `ConfirmTransactionInput` (`categoryId?` override) → `Transaction` |
| POST `/transactions/receipt` | multipart image → `ReceiptScanResponse` (`vendor?`, `amountCents?`, `date?`, `suggestedCategoryId?`, `suggestedPropertyId?`, `confidence`) — pre-fills form, never saves |
| POST `/transactions/import` | — → `{ imported: number }` (mock Plaid pull into review queue) |

**Categories** — GET `/categories` → `Category[]`; POST `/categories` (`CreateCategoryInput`).

**Rent**
| Method/Path | Request → Response |
|---|---|
| GET `/rent/tracker?period=YYYY-MM` | → `RentTrackerResponse`: `{ period, collectedCents, outstandingCents, paidUnits, totalUnits, rows: RentTrackerRow[] }` (row: tenant, unit/property, amountCents, dueDate, status, `daysLate?`, method?, paidAt?) |
| POST `/rent/payments` | `RecordRentPaymentInput` (leaseId, period, amountCents, method, paidAt?) → `RentPayment` (also writes ledger Transaction) |
| POST `/rent/payments/:id/payment-link` | — → `{ url }` (mock Stripe link) |
| POST `/rent/reminders` | `SendRemindersInput` (`rentPaymentIds: string[]`) → `SendRemindersResponse` (per-id sent/skipped; mock email) |

**Reports** — GET `/reports/library` → `ReportTypeInfo[]` (the 13 types: name, description, supported filters); GET `/reports?type&taxYear` → `Report[]` (archive, no dataJson); POST `/reports/generate` (`GenerateReportInput`: type, taxYear? | from/to?, propertyId?) → `Report`; GET `/reports/:id` → `ReportDetailResponse` (with parsed data); GET `/reports/:id/export?format=pdf|csv` → file; POST `/reports/:id/email` (`EmailReportInput`: `to`) → 202 (mock email).

**Insights** — GET `/insights?status&scope` → `Insight[]`; POST `/insights/:id/dismiss` → `Insight`; GET `/insights/monthly-reviews` → `Report[]` (type `monthly_review`); GET `/insights/monthly-reviews/:id` → `ReportDetailResponse`; POST `/insights/monthly-reviews/generate` → `Report` (dev/demo trigger for the scheduled job).

**Dashboard** — GET `/dashboard/kpis` → `DashboardKpisResponse` (§4 for fields); GET `/dashboard/cashflow-series?months=6` → `IncomeExpenseSeriesResponse` (`[{ month, incomeCents, expenseCents }]`); GET `/dashboard/activity?limit=10` → `ActivityItem[]` (kind: transaction|rent_payment|reminder|report|insight, text, at, link); GET `/dashboard/insight` → `Insight | null` (today's single card).

**Chat**
| Method/Path | Request → Response |
|---|---|
| POST `/chat/sessions` | `CreateChatSessionInput` (`context?: { screen, entityId? }`) → `ChatSession` |
| GET `/chat/sessions` / GET `/chat/sessions/:id/messages` | → `ChatSession[]` / `ChatMessage[]` |
| POST `/chat/sessions/:id/messages` | `SendChatMessageInput` (`text`) → **SSE stream** (§5 protocol) — via `fetch` + ReadableStream (EventSource can't POST) |
| POST `/chat/sessions/:id/answer` | `AskUserQuestionAnswer` (§5) → **SSE stream** (resumes the paused assistant turn) |

**Settings / Integrations** — GET/PATCH `/settings/account` (`AccountSettings`, `UpdateAccountSettingsInput`); GET `/integrations` → `Integration[]`; POST `/integrations/:type/connect` → `Integration` (flips mock status); DELETE `/integrations/:id` → 204. GET `/healthz`.

---

## 4. Service layer

All functions: `(accountId: string, ...) => Promise<...>`, typed with `@hearth/shared` types. Exposure key: **R** = REST, **A** = chat agent tool, **M** = MCP.

- **propertyService** — `list(accountId)` R A M · `getDetail(accountId, id)` R A M · `create/update` R · `remove` R (soft-archive, blocked on active lease) · `restore` R · `getPnl(accountId, id, range)` R A M. All writes audited; list/derivations filter `archivedAt: null`.
- **unitService** — `create/update` R · `remove` R (soft-archive) · `restore` R. Audited.
- **tenantService** — `list(accountId)` R A M · `getDetail(accountId, id)` R A M · `create/update` R · `remove` R (soft-archive) · `restore` R. Audited.
- **leaseService** — `list(accountId, filter?)` R A (excludes archived unit/property) · `getDetail(accountId, id)` R A · `create/update` R · `terminate(accountId, id)` R · `addTenant/removeTenant(accountId, leaseId, …)` R (last-tenant guard, primary auto-promote) · `createRenewal(accountId, leaseId, input)` R (switchover: new active lease, source ended) · `draftRenewal(accountId, leaseId)` R A (returns proposal; sending is separate) · `sendForEsign(accountId, leaseId)` R (mock Docusign). All writes audited.
- **transactionService** — `list(accountId, filter)` R A M · `create(accountId, input)` R A(write) M(write) · `update/remove` R · `getReviewQueue(accountId)` R A · `confirm(accountId, id, categoryId?)` R A(write) M(write, as `categorize_transaction`) · `suggestCategory(accountId, partialTxn)` internal (AiClient; mock = keyword table: "plumb|roof|repair"→Repairs, "electric|water|gas"→Utilities, "insur"→Insurance, else Supplies @ 0.62 confidence) · `scanReceipt(accountId, image)` R (mock returns fixture parse) · `importFromBank(accountId)` R (mock Plaid → pending_review rows)
- **categoryService** — `list` R A M · `create` R
- **rentService** — `getMonthStatus(accountId, period)` R A M (materializes missing expected RentPayment rows per active lease for `period`, `dueDate = periodStart + dueDay − 1`, then derives) · `recordPayment(accountId, input)` R A(write) M(write) · `createPaymentLink(accountId, rentPaymentId)` R (mock Stripe) · `sendReminders(accountId, rentPaymentIds)` R A(write) M(write) — sets `remindedAt`, mock email, audit log
- **reportService** — `listLibrary()` R · `listGenerated(accountId, filter)` R M · `generate(accountId, input)` R A(write) M(write) · `getById(accountId, id)` R M · `exportCsv/exportPdf(accountId, id)` R · `emailToAccountant(accountId, id, to)` R A(write)
- **insightService** — `listActive(accountId, scope?)` R A M · `dismiss(accountId, id)` R A(write) M(write) · `getDashboardInsight(accountId)` R (highest-severity active, cached per day via dedupeKey) · `generateInsights(accountId)` internal/cron+seed · `generateMonthlyReview(accountId, month)` R(dev trigger) internal — snapshots a `monthly_review` Report + Insights
- **dashboardService** — `getKpis(accountId)` R A M · `getIncomeExpenseSeries(accountId, months)` R A M · `getActivity(accountId, limit)` R · `getPortfolioSummary(accountId)` A M (one-paragraph + key numbers; the MCP resource body)
- **chatService** — `createSession`, `listSessions`, `getMessages`, `sendMessage(accountId, sessionId, text, sse)`, `answerQuestion(accountId, sessionId, answer, sse)` — R only; drives `agent-loop.ts`
- **integrationService** — `list`, `connectMock`, `disconnect` R

**Derivation rules (binding, unit-tested):**
- **Rent status** (per RentPayment for the viewed period): `paid` if status `paid`; `processing`/`failed` pass through; else `due` if `today ≤ dueDate + account.graceDays` (v1 default 0), else `late` with `daysLate = floor(today − dueDate)` — always rendered as text ("6 days late"), never color alone. Tracker `collected% (by units) = paidUnits / totalActiveLeaseUnits`.
- **KPIs** (`DashboardKpisResponse`): `netCashFlowMtdCents = Σ confirmed income − Σ confirmed expense (current month)`; `rentCollectedPct = paidUnits/totalUnits` + `paidUnits`, `totalUnits`; `expensesMtdCents`; each with `trend` = pct change vs. same day-of-month window of prior month.
- **Tax set-aside** (estimate only; UI carries the PRD §13.4 disclaimer): `currentCents = round(confirmedNetMtdCents × taxRatePct/100)`; `targetCents = round(avgMonthlyNet(trailing 6 full months) × 3 × taxRatePct/100)` (a quarterly target). With seed data (§10): current $1,690, target $2,700.
- **Tenant/lease status**: `late` if any unpaid rent past due; else `renew_soon` if `lease.endDate ≤ today + 60d`; else `current`.
- **Contractor usage stats** (`ContractorListRow`, `ContractorDetailResponse` — the detail's job history and stats derive from the same match, so both surfaces always agree): `jobsCount`/`avgCostCents`/`lastUsedAt` are never stored — they derive from confirmed expense transactions whose `vendor` matches the contractor `name` case/whitespace-insensitively (`trim().toLowerCase()`, casing variants folded into one bucket); `avgCostCents = round(total/count)`; no matching history → `jobsCount 0` with `avgCostCents`/`lastUsedAt` null.
- **Mock insight generation rules** (run by seed + `generateInsights`, deduped on `dedupeKey`): (1) `late_rent` — any payment `daysLate > 5` → warning, action "Review" → rent tracker; (2) `expense_spike` — a category's current-month total > 125% of its trailing-3-month avg → warning; (3) `renewal_window` — leases ending ≤ 60d → info, action "Draft renewal"; (4) `underperforming_property` — property net (trailing 3 mo) < 80% of per-unit portfolio average → info. Dashboard shows exactly one (highest severity, newest).

---

## 5. Chat content-block schema (`packages/shared/src/schemas/chat-blocks.ts`)

```ts
ColorRole = 'positive' | 'warning' | 'neutral' | 'ai'

TextBlock          { type:'text', text: string }                    // markdown-lite: bold, lists
ChartBlock         { type:'chart', kind:'line'|'bar'|'donut'|'sparkline',
                     title: string, description: string,            // description = required a11y text alt
                     yUnit:'usd'|'percent'|'count',
                     series: [{ label: string, colorRole: ColorRole,
                                points: [{ x: string, y: number }] }] }   // y in cents when yUnit='usd'
DataTableBlock     { type:'data_table', title?: string,
                     columns: [{ key, label, align?:'left'|'right', format?:'usd'|'date'|'text' }],
                     rows: Record<string, string|number>[] }
ActionCardBlock    { type:'action_card', title: string, body?: string,
                     actions: [{ id, label, style:'primary'|'secondary',
                                 action: { kind:'api_call', method:'POST'|'PATCH', path: string, body?: unknown }
                                       | { kind:'navigate', to: string } }] }
                     // api_call paths are the §3 REST routes — the button just calls the normal API
AskUserQuestionBlock { type:'ask_user_question', questionId: string,
                     header?: string, question: string, multiSelect: boolean,
                     options: [{ id, label, description }] /* 2–4 */, allowFreeText: true }

ContentBlock = discriminated union on `type`
AskUserQuestionAnswer = { questionId: string, selectedOptionIds: string[], freeText?: string }
```

**SSE protocol** (both chat POST endpoints stream `text/event-stream`; each event is `event: <name>\ndata: <json>`):

- `message_start` `{ messageId }`
- `block_start` `{ index, blockType }`
- `text_delta` `{ index, delta }` — text blocks stream token-wise
- `block_complete` `{ index, block: ContentBlock }` — structured blocks (chart/table/action_card/ask_user_question) arrive whole, as soon as resolved (PRD §7.4)
- `tool_activity` `{ name, status:'running'|'done' }` — optional, drives a "checking your ledger…" indicator
- `awaiting_input` `{ messageId, questionIndex }` — turn paused on ask_user_question; composer disabled except the option chips
- `message_complete` `{ messageId }` · `error` `{ message }`

Client sends the answer via POST `/chat/sessions/:id/answer`, whose response is a new SSE stream continuing the **same assistant turn** (appends blocks to the same persisted ChatMessage).

---

## 6. Agent loop design (`apps/api/src/ai/agent-loop.ts`)

- `AiClient` interface: `stream(params: { system, messages, tools }) → AsyncIterable<ProviderEvent>` where `ProviderEvent` mirrors the Anthropic SDK shapes (`text_delta`, `tool_use`, `stop`). `anthropic.ts` implements it with `claude-sonnet-5` (env `ANTHROPIC_MODEL` fallback); `mock.ts` implements the same interface.
- **Loop:** build system prompt (persona + account context + today's date + screen context) + tool defs from `ai/tools.ts` (each tool = name, description, Zod-derived JSON schema, service binding tagged **A** in §4). Iterate: stream model output → forward text as `text_delta` → on `tool_use`: emit `tool_activity`, execute the bound service function, append `tool_result`, continue (max 8 iterations). Tools that produce visuals: the model calls a `render_chart` / `render_table` / `propose_action` tool whose *input is* the block schema; the loop validates with Zod and emits `block_complete` — the model never emits raw JSON blocks in prose.
- **ask_user_question pause/resume:** exposed as tool `ask_user_question` (input = the block minus `questionId`). When called: emit the block + `awaiting_input`, persist the full provider `messages[]` + pending `tool_use_id` into `ChatSession.providerStateJson`, set session `awaiting_user`, end the stream **without** a `tool_result`. On `/answer`: validate the answer, append `tool_result` (`{ selected: [...labels], freeText }`) to the restored messages, clear state, resume the loop on a fresh SSE stream. The answer is a hard constraint (in the transcript as a tool result, so the model cannot ignore it).
- **action_card:** buttons are dumb — the frontend executes the embedded `api_call` against the normal REST API (normal auth/validation/audit path), then posts a short system-style confirmation locally. The assistant never executes the action itself (PRD §9.3).
- **MOCK mode** (when `ANTHROPIC_API_KEY` unset): `MockAiClient` matches the latest user message against ordered regex scripts in `mock-scripts.ts`. Each script is a deterministic sequence of `ProviderEvent`s — including real `tool_use` events, so **tools execute against the real service layer and all numbers come from the seeded DB**, exercising the identical loop/pause/resume code paths. Required scripts:
  1. `/cash ?flow|how.*(doing|going)|this month/i` → tool `get_dashboard_kpis` + `get_income_expense_series`, then text summary + `render_chart` (line, 6-month income vs. expense, colorRoles positive/warning) — **the chart script**.
  2. `/tax(es)?|schedule e/i` → `ask_user_question` ("Which tax year?", header "Tax prep", options: "2026 (year to date)" / "2025" / "Other", single-select) → **pauses**; on answer → tool `generate_report` (schedule_e for chosen year) → `render_table` (per-property rents/repairs/other/net) + `action_card` ("Open the full Schedule E", navigate `/reports/:id`) — **the scripted askUserQuestion flow**.
  3. `/late|behind|owes?/i` → tool `get_rent_status` → text + `data_table` of late tenants + `action_card` ("Send reminder to T. Okafor" → POST `/rent/reminders`).
  4. Fallback → tool `get_portfolio_summary` → text answer.
  Text streams in ~3-word deltas with tiny delays so streaming UI is demoable; deltas are byte-identical across runs.

---

## 7. MCP server (`apps/api/src/mcp/`, stdio; run `npm run mcp -w apps/api`)

Reuses the tool definitions/bindings in `ai/tools.ts` (single source, PRD §10). v1 auth: local single-user, same demo account; per-client OAuth is v2.

**Resources (read):** `hearth://portfolio/summary` (text summary + KPIs) · `hearth://properties` and `hearth://properties/{id}` · `hearth://rent/{period}` (tracker JSON) · `hearth://reports` and `hearth://reports/{id}` · `hearth://insights/active`.

**Read tools** (always on): `get_portfolio_summary` (no input) · `list_properties` · `get_property {propertyId}` · `get_rent_status {period?: "YYYY-MM"}` · `list_transactions {from?, to?, propertyId?, type?, status?}` · `list_insights {scope?}` · `list_reports {type?, taxYear?}` / `get_report {reportId}` — input schemas are the same Zod filters as REST, via `zod-to-json-schema`.

**Write tools** — registered **only when `HEARTH_MCP_ENABLE_WRITE=true`** (single env gate in v1, standing in for PRD §10's per-client write grant; each call writes an AuditLog row): `create_transaction` · `categorize_transaction {transactionId, categoryId}` (= confirm) · `send_rent_reminder {rentPaymentIds}` · `generate_report {type, taxYear?|from/to?, propertyId?}` · `dismiss_insight {insightId}`. Descriptions must state side effects plainly (e.g. "Sends a reminder email to the tenant — irreversible"). No `ask_user_question` on this surface (PRD §10 non-goal).

---

## 8. Frontend

**Routes** (react-router, all inside `AppShell`): `/` Dashboard · `/properties` · `/properties/:id` · `/tenants` · `/tenants/:id` · `/money` (+ `/money/new`, `/money/review`) · `/rent` · `/reports` · `/reports/:id` · `/insights` (+ `/insights/:reportId`) · `/settings`. Chat drawer is layout state (`?chat=open` for deep-linking, e.g. from "Ask AI to build a custom report" which opens it with report context), **not** a route (PRD §4).

**Component inventory & a11y notes:**
- `AppShell` — landmarks: `<nav aria-label="Main">` (SideNav, `aria-current="page"`), `<main>`, chat drawer as `<aside>`. `SideNav` ↔ `BottomTabBar` (Home/Money/Add/Rent/Tax) swap at `md`; skip-to-content link first in DOM.
- `Breadcrumbs` — `<nav aria-label="Breadcrumb">`, `aria-current="page"` on leaf; back-arrow variant on mobile.
- `KpiTile` — focusable, full value in accessible text (`aria-label="Net cash flow, $8,450, up 4% vs last month"`); progress bar (rent collected) uses `role="progressbar"` + `aria-valuenow`; `Skeleton` reserves exact final dimensions (no CLS, PRD §5.1).
- `charts/*` — Recharts wrapped in `ChartContainer`: required `title` + `description` (visually-hidden text alt), `role="img"` + `aria-label` on SVG, adjacent "View as table" toggle rendering the same data as a real `<table>` (satisfies keyboard-navigable data), series colors from tokens at ≥3:1.
- `StatusBadge` — always icon + text ("6 days late", "Full", "Renew soon"); color is reinforcement only.
- `Table` — semantic `<table>/<caption>/<th scope>`; row actions keyboard-reachable.
- `InsightCard` (inside `AiSurface`) — `surface-ai` background, `border-ai` left accent, `AiBadge` ("✦ AI"); primary action + Dismiss; new cards announced via `aria-live="polite"`.
- `AiChip` — the suggested-category chip on the transaction form: `aria-describedby` "AI-suggested, 84% confidence — confirm or change"; never auto-applied.
- `ChatDrawer` — `role="dialog" aria-label="Hearth assistant"`, Esc closes and returns focus to the launcher; **Clear** control resets the transcript + starts a fresh session on the next send. Modal below `xl` (backdrop, focus trap, body-scroll lock); at `xl` it's a **docked non-modal** panel — page shifts aside (`xl:pr`) and stays scrollable/keyboard-reachable, so no Tab-trap or scroll-lock. Full-screen at `<md`. Transcript is `aria-live="polite"` (announce on `block_complete`/message end, not per token). Block renderers: `TextBlock`, `ChartBlock` (reuses `charts/*`), `DataTableBlock` (reuses `Table`), `ActionCardBlock` (buttons fire the embedded `api_call` via the shared api client, disabled+spinner while pending, result toast), `AskUserQuestionBlock` (single-select → `role="radiogroup"`, multiSelect → checkbox group; each option = label + description; "Other" free-text; Submit posts `/answer` and re-attaches the SSE reader; chips disabled after answering, selection stays visible in transcript).
- Forms (`FormField`) — visible `<label>`, errors via `aria-describedby`, no placeholder-as-label.

**Design tokens** (`src/styles/tokens.css` as CSS custom properties, mapped into `tailwind.config.ts` — no ad hoc hex in components):
- Core: `--color-bg`, `--color-surface`, `--color-border`, `--color-text`, `--color-text-muted`, `--color-brand` (warm terracotta/ember — "Hearth"), spacing/radius/type scale.
- Status roles: `--color-positive` (green 700-range), `--color-warning` (amber 700), `--color-danger` (red 700), `--color-neutral` (slate) — all ≥4.5:1 on surface.
- **AI-surface convention (PRD §6, mandatory):** `--surface-ai` (subtle violet tint, e.g. ~`#F5F3FF`), `--border-ai` (violet ~`#7C3AED`), `--text-ai-label`; consumed by exactly one wrapper component `AiSurface` used by InsightCard, AiChip, all assistant chat bubbles, and monthly-review content — any AI-authored content is visually marked, everywhere, via this one component.
- Chart palette: `--chart-positive`, `--chart-warning`, `--chart-neutral`, `--chart-ai` — the `colorRole` → color mapping lives only here.
- Motion: `--motion-fast: 180ms`, `--motion-ease`; a global `prefers-reduced-motion: reduce` override zeroes transitions and disables chart entrance animation.
- CI: axe-core scan (vitest + jsdom or Playwright) as merge-blocking check.

---

## 9. Build order

**Gate 0 (freeze first, blocks everything):** `packages/shared` complete — enums, all entity/API schemas, chat-blocks union, SSE event schemas. Owner: **backend**, reviewed by frontend. Nothing else starts until this merges.

Then in parallel:

| # | Task | Role | Depends on | Touches |
|---|---|---|---|---|
| 1 | Monorepo scaffolding: root package.json, tsconfigs, Vite/Fastify hello-world, Prisma init | either | — | root, apps/* |
| 2 | Prisma schema + migration + **seed script (§10)** | backend | 0,1 | apps/api/prisma |
| 3 | Core services + REST: properties, units, tenants, leases, transactions, categories + Vitest | backend | 2 | services/, routes/ |
| 4 | rent/report/insight/dashboard services + REST (derivation rules §4 unit-tested against seed numbers) | backend | 2 (parallel w/ 3) | services/, routes/ |
| 5 | Web shell: AppShell, nav/tabs, breadcrumbs, tokens.css, ui/* primitives, api client + TanStack Query setup | frontend | 0,1 (mock fetches against shared schemas until 3/4 land) | apps/web |
| 6 | Pages wave 1: Dashboard, Properties list/detail, Tenants list/detail | frontend | 5; integrates when 3,4 land | pages/, charts/ |
| 7 | Pages wave 2: Money (+review, +receipt), Rent tracker, Reports, Insights, Settings | frontend | 5 (parallel w/ 6) | pages/ |
| 8 | AiClient + agent loop + tools.ts + MOCK scripts + chat REST/SSE | backend | 3,4 | ai/, routes/chat.ts |
| 9 | ChatDrawer + block renderers + SSE reader + ask_user_question round-trip | frontend | 0 (block schema), 5; integrates when 8 lands — can build against a canned SSE fixture first | components/chat/ |
| 10 | MCP entrypoint (reuses 8's tools.ts) | backend | 8 | mcp/ |
| 11 | Integration adapters + mocks (plaid/stripe/docusign/email) + Settings wiring | backend | 3 | integrations/ |
| 12 | Polish pass: a11y audit (axe CI), reduced-motion, e2e happy paths (add transaction, send reminder, generate report, chat round-trip incl. askUserQuestion) | either | all | — |

**Sequencing constraints:** 8 before 10 (shared tool defs); 3+4 before 8 (tools call services); 9's fixture-driven build can start immediately after Gate 0 but final integration needs 8. The seed script (2) must exactly produce §10's numbers before 4's tests are written, since tests assert those numbers.

---

## 10. Seed data spec (`apps/api/prisma/seed.ts`)

All dates computed **relative to the run date** (`today`), so the demo always looks current. Account: `Sam Landlord <demo@hearth.app>`, taxRatePct 20, graceDays 0, timezone America/New_York.

**Properties & units (9 properties, 14 units, all occupied):**

| Property | Units | Tenant(s) | Rent/mo |
|---|---|---|---|
| 12 Maple St | Main | **J. Rivera** | $1,250 |
| 88 Oak Ave | A / B / C | K. Whitfield / A. Osei / R. Delgado | $875 / $875 / $900 |
| 5 Birch Ln | 1 / 2 | **D. Park** (late) / L. Nguyen | $985 / $940 |
| 21 Cedar Ct | Main | **T. Okafor** (late) | $1,150 |
| 9 Pine Rd | 1 / 2 | H. Brooks / S. Novak | $795 / $815 |
| 140 Willow Way | Main | **M. Chen** | $1,175 |
| 7 Elm St | Main | P. Iyer | $950 |
| 310 Aspen Dr | 1 / 2 | C. Marsh / E. Fontaine | $780 / $790 |
| 55 Juniper Blvd | Main | G. Almeida | $1,415 |

Full rent roll = **$13,695/mo**. Each property gets an acquisitionDate (2018–2024) and acquisitionCostCents (for the REO schedule / depreciation placeholder).

**Leases:** all `active`, dueDay 1, started 6–30 months ago. Renewal window: **M. Chen** ends `today + 45d`, **S. Novak** ends `today + 58d` (drives the `renewal_window` insight → "2 leases up for renewal in the next 60 days"). All others end 6–18 months out. Okafor's lease carries a mock esign ref (`esignStatus: signed`).

**Current-month rent (drives KPIs):** materialize 14 RentPayment rows for the current period. 12 **paid** (paidAt within the first 2 days of the month; 9 `online`, 3 `manual`), each with a linked income Transaction — collected total **$11,560** (= roll − 985 − 1,150). 2 **late**: T. Okafor $1,150, `dueDate = today − 6d` (**"6 days late"**); D. Park $985, `dueDate = today − 3d` ("3 days late"). (Seed sets these two dueDates directly so days-late is exact regardless of run date.)

**Current-month expenses (confirmed) = $3,110:** plumbing repair $480 (88 Oak Ave, vendor "Reyes Plumbing", Repairs), utilities $640 (5 Birch Ln — drives `expense_spike`), insurance $780 (portfolio), landscaping $310 (12 Maple St), cleaning $220 (310 Aspen Dr), supplies $180 (9 Pine Rd), HOA $500 (55 Juniper Blvd).

**Resulting KPIs (assert in tests):** net cash flow MTD = 11,560 − 3,110 = **$8,450** (~$8,420 ✓ ballpark); rent collected **12 of 14 units = 86%**; expenses MTD **$3,110**; tax set-aside current = 8,450 × 20% = **$1,690**, target = 4,500 × 3 × 20% = **$2,700** ✓.

**Trailing 6 full months:** each month, 14 paid RentPayments (income $13,695) + expense transactions totaling: M−6 $9,480, M−5 $8,910, M−4 $9,650, M−3 $8,730, M−2 $9,240, M−1 $9,160 (avg $9,195 → **avg net exactly $4,500**, pinning the $2,700 target). Spread expenses across Repairs/Utilities/Insurance/Landscaping/Cleaning/Supplies/HOA/Property Management with realistic vendors; include the wireframes' comparison anchors in M−1: **roof repair $1,200** (12 Maple St) and **utilities $640**. This yields a non-flat 6-month income-vs-expense chart.

**Review queue:** 3 `pending_review` bank-source transactions dated within the last 5 days (e.g., "HD SUPPLY #443" $164 suggested Supplies @0.84; "CITY OF SPRINGFIELD WATER" $128 suggested Utilities @0.91; "AMZN Mktp" $76 suggested Supplies @0.55 — the low-confidence one demos the review threshold).

**Categories (system-seeded):** income — Rent, Late Fees, Other Income; expense — Repairs, Capital Improvements, Utilities, Insurance, Property Taxes, Mortgage Interest, Landscaping, Cleaning & Maintenance, Supplies, HOA Fees, Property Management, Legal & Professional, Travel — each with an `irsScheduleELine`.

**Contractors (6):** Rivera Plumbing (Plumbing 4.9), Summit Roofing (Roofing 4.8), Diaz Painting (Painting 4.7), Apex Services (Handyman 4.7), QuickFix Home (HVAC 4.4), GreenScape Co. (Landscaping 4.6). Usage stats derive from vendor-matched expenses (§4): synthetic history txns (confirmed expense, Repairs, `vendor` = contractor name) are dated monthly **backwards from an anchor = min(start of month − 7 months, Dec 1 of the previous year)** — every history txn is both in a prior calendar year and ≥7 full months back, so the pinned MTD/trailing/tax-target figures and insight windows never move. Summit Roofing also matches the existing M−1 $1,200 roof repair (→ 4 jobs, avg exactly $1,150, lastUsed M−1); GreenScape Co. has **no** synthetic history — its 7 jobs @ $310 derive entirely from the existing monthly grounds-service rows (lastUsed = current month); the existing "Apex Handyman" vendor deliberately does not match "Apex Services". Pinned in `seed-constants.ts` (`SEED_CONTRACTORS`, `CONTRACTOR_EXPECTED_STATS`, `contractorHistoryAnchor()`).

**Insights (active):** `late_rent:…okafor:<period>` (warning, dashboard card, action → `/rent`); `expense_spike:utilities:birch:<period>` (warning); `renewal_window:<period>` (info, "2 leases up for renewal…"). **Monthly review:** one `monthly_review` Report for last month (bottom line, per-property net table, 2–3 watch items) so `/insights` isn't empty. **Integrations:** 4 rows (plaid/stripe/docusign/email), status `mock`. Seed is idempotent (wipe-and-recreate for the demo account).

---

## Resolved decisions (were "open questions"; decided 2026-07-03)

1. **Rent-collected % basis** — confirmed: *units paid / total units* (matches "12 of 14").
2. **Vacancy vs. the 12/14 number** — accepted: all 14 units occupied in seed data; no "1 vacant" label in the demo. The wireframes were internally inconsistent here; 12/14 wins.
3. **Tax set-aside rate** — confirmed: 20% account default (user-editable in Settings).
4. **Charting library** — confirmed: Recharts behind `ChartContainer`.
5. **Report depth** — confirmed split: Schedule E, P&L, Net Cashflow, Rent Roll, General Ledger, Tenant Ledger get real computed data; the rest get structurally-correct simplified outputs flagged via `ReportTypeInfo.maturity`.

## Risks

- **Schema constraints** (no enums/Decimal) are handled by string+cents conventions — the schema file carries a header comment banning both (Zod enums in `@hearth/shared` stay the single source of truth).
- **SSE-over-POST** needs `fetch` + ReadableStream parsing on the client (no EventSource) and Fastify's reply hijack; build task 9 against a canned fixture stream first so it's not blocked on task 8.
- **ask_user_question resume state** (`providerStateJson`) is the trickiest correctness point — needs an explicit test: pause, kill/restart server, answer, verify resume.
- **Seed-number drift:** dashboard tests assert exact §10 figures; any later change to seed data silently breaks them — keep the numbers as named constants in one `seed-constants.ts` imported by both seed and tests.
- **Days-late reproducibility** depends on seed setting `dueDate = today − 6d` at seed time; document that re-running seed refreshes the demo clock.
