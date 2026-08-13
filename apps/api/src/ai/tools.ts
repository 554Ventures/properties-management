// The single tool registry (ARCHITECTURE §4 A/A(write) markers) used by BOTH
// the chat agent loop and the MCP server. Each service tool binds a zod input
// schema to a service function; render tools carry the shared block schemas as
// their input and are handled by the loop itself (never executed here).
import {
  AcceptRenewalInputSchema,
  ActionCardBlockSchema,
  AddLeaseTenantInputSchema,
  ApplyLateFeeInputSchema,
  AskUserQuestionBlockSchema,
  ChartBlockSchema,
  ConfirmTransactionInputSchema,
  CreateContractorInputSchema,
  CreateLeaseInputSchema,
  CreateMortgageInputSchema,
  CreatePropertyInputSchema,
  CreatePropertyValuationInputSchema,
  CreateRecurringTemplateInputSchema,
  CreateTenantInputSchema,
  CreateTransactionInputSchema,
  CreateUnitInputSchema,
  DataTableBlockSchema,
  DocumentEntityTypeSchema,
  DocumentTypeSchema,
  GenerateReportInputSchema,
  InsightScopeSchema,
  LeaseStatusSchema,
  PeriodSchema,
  RecordRentPaymentInputSchema,
  ReportTypeSchema,
  SendRemindersInputSchema,
  TransactionListQuerySchema,
  UpdateContractorInputSchema,
  UpdateLeaseInputSchema,
  UpdateMortgageFieldsSchema,
  UpdatePropertyInputSchema,
  UpdateTenantInputSchema,
  UpdateTransactionInputSchema,
  UpdateUnitInputSchema,
} from '@hearth/shared';
import type {
  ContentBlock,
  InsightScope,
  LeaseStatus,
  MemberPermission,
  UserRole,
} from '@hearth/shared';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { currentPeriodInTz, yearRangeInTz } from '../lib/dates';
import { accountTimezone } from '../services/account.service';
import * as categoryService from '../services/category.service';
import * as contractorService from '../services/contractor.service';
import * as dashboardService from '../services/dashboard.service';
import * as documentService from '../services/document.service';
import * as insightService from '../services/insight.service';
import * as leaseService from '../services/lease.service';
import * as mortgageService from '../services/mortgage.service';
import * as propertyService from '../services/property.service';
import * as recurringService from '../services/recurring.service';
import * as rentService from '../services/rent.service';
import * as reportService from '../services/report.service';
import * as tenantService from '../services/tenant.service';
import * as transactionService from '../services/transaction.service';
import * as unitService from '../services/unit.service';
import * as valuationService from '../services/valuation.service';
import type { AuditActor } from '../services/audit.service';

export interface ServiceToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  write: boolean;
  /** `actor` is the audit attribution for write tools ('system' when the model
   *  or an MCP client invoked the tool itself); read tools ignore it. */
  execute: (accountId: string, input: unknown, actor: AuditActor) => Promise<unknown>;
}

/** Tools whose input renders a shared content-block schema; the loop validates
 *  the model's args and injects `blockType` as the block's `type` itself —
 *  the model is never asked to echo back that literal discriminant (it's
 *  redundant with which tool it called, and unlike JSON-schema `const`
 *  fields, Anthropic tool-use generation doesn't reliably reproduce it). */
export interface RenderToolDef {
  name: string;
  description: string;
  blockType: ContentBlock['type'];
  inputSchema: z.ZodTypeAny;
}

const NoInputSchema = z.object({});

const PropertyPnlInputSchema = z.object({
  propertyId: z.string(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const serviceTools: ServiceToolDef[] = [
  {
    name: 'get_portfolio_summary',
    description:
      'One-paragraph portfolio summary with the key numbers: property/unit counts, net cash flow month-to-date, rent collected, expenses and tax set-aside.',
    inputSchema: NoInputSchema,
    write: false,
    execute: (accountId) => dashboardService.getPortfolioSummary(accountId),
  },
  {
    name: 'get_dashboard_kpis',
    description:
      'Dashboard KPIs: net cash flow MTD, rent collected % (paid/total units), expenses MTD, tax set-aside — each with a trend vs. last month. All money in integer cents.',
    inputSchema: NoInputSchema,
    write: false,
    execute: (accountId) => dashboardService.getKpis(accountId),
  },
  {
    name: 'get_income_expense_series',
    description:
      'Month-by-month income vs. expense totals (cents) for the trailing N months, ending with the current month.',
    inputSchema: z.object({ months: z.number().int().min(1).max(24).default(6) }),
    write: false,
    execute: (accountId, input) =>
      dashboardService.getIncomeExpenseSeries(accountId, (input as { months: number }).months),
  },
  {
    name: 'get_expense_breakdown',
    description:
      'Month-to-date expenses grouped by category (cents per category). Follows the P&L classification rules, so transfers and owner contributions are excluded and refunds net against their category.',
    inputSchema: NoInputSchema,
    write: false,
    execute: (accountId) => dashboardService.getExpenseBreakdown(accountId),
  },
  {
    name: 'get_noi_by_property',
    description:
      'Net operating income per property for the current period (income minus ordinary expenses, integer cents) — the comparison used to rank which properties are carrying the portfolio.',
    inputSchema: NoInputSchema,
    write: false,
    execute: (accountId) => dashboardService.getNoiByProperty(accountId),
  },
  {
    name: 'get_recent_activity',
    description:
      'Recent account activity feed (most recent first) — what changed lately across properties, tenants, money and rent.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
    write: false,
    execute: (accountId, input) =>
      dashboardService.getActivity(accountId, (input as { limit: number }).limit),
  },
  {
    name: 'list_properties',
    description:
      'All properties with derived stats: unit count, occupied count, monthly rent (cents) and a status label like "Full" or "1 late".',
    inputSchema: NoInputSchema,
    write: false,
    execute: (accountId) => propertyService.list(accountId),
  },
  {
    name: 'get_property',
    description:
      'Full detail for one property: address, acquisition date/cost (cents), units with current lease + tenants, MTD/YTD P&L, any active insights, and financing — mortgages with their derived current balance, the latest owner-provided valuation, and computed equity (asset value from the latest valuation or, absent one, acquisition cost, minus mortgage balances). The mortgages list also includes archived (paid-off or removed) mortgages, identified by a non-null archivedAt; those are NOT owed and are already excluded from the equity figure, so never add them to a balance you report. Equity is null when the property has neither a valuation nor an acquisition cost.',
    inputSchema: z.object({ propertyId: z.string() }),
    write: false,
    execute: (accountId, input) =>
      propertyService.getDetail(accountId, (input as { propertyId: string }).propertyId),
  },
  {
    name: 'get_property_pnl',
    description:
      'Income and expenses by category plus net (cents) for one property over a date range. Defaults to the current calendar year when from/to are omitted.',
    inputSchema: PropertyPnlInputSchema,
    write: false,
    execute: async (accountId, input) => {
      const { propertyId, from, to } = input as z.infer<typeof PropertyPnlInputSchema>;
      // Default calendar-year range on the account's timezone (WS4).
      const tz = await accountTimezone(accountId);
      const fallback = yearRangeInTz(Number(currentPeriodInTz(tz).slice(0, 4)), tz);
      return propertyService.getPnl(accountId, propertyId, {
        from: from ? new Date(from) : fallback.from,
        to: to ? new Date(to) : fallback.to,
      });
    },
  },
  {
    name: 'list_tenants',
    description:
      'All tenants with their unit/property, rent (cents), lease end date and derived status (current | renew_soon | late).',
    inputSchema: NoInputSchema,
    write: false,
    execute: (accountId) => tenantService.list(accountId),
  },
  {
    name: 'get_tenant',
    description: 'Full detail for one tenant: contact info, leases, payment history and documents.',
    inputSchema: z.object({ tenantId: z.string() }),
    write: false,
    execute: (accountId, input) =>
      tenantService.getDetail(accountId, (input as { tenantId: string }).tenantId),
  },
  {
    name: 'get_unit',
    description:
      'Full detail for one unit: property context, current + historical leases with tenants, rent payment history and MTD/YTD P&L.',
    inputSchema: z.object({ unitId: z.string() }),
    write: false,
    execute: (accountId, input) =>
      unitService.getDetail(accountId, (input as { unitId: string }).unitId),
  },
  {
    name: 'list_leases',
    description: 'All leases, optionally filtered by status (active | ended | pending_signature).',
    inputSchema: z.object({ status: LeaseStatusSchema.optional() }),
    write: false,
    execute: (accountId, input) =>
      leaseService.list(accountId, input as { status?: LeaseStatus }),
  },
  {
    name: 'get_lease',
    description:
      'Full detail for one lease: terms (rent, due day, late-fee override, dates, status), unit/property context, the tenants on it with their rent shares, and the full rent-charge history with derived status.',
    inputSchema: z.object({ leaseId: z.string() }),
    write: false,
    execute: (accountId, input) =>
      leaseService.getDetail(accountId, (input as { leaseId: string }).leaseId),
  },
  {
    name: 'draft_lease_renewal',
    description:
      'Draft renewal terms for a lease (suggested rent from the market-rent heuristic, proposed dates). Returns a proposal only — nothing is saved. Use renew_lease to actually enact the terms once the user has agreed to them.',
    inputSchema: z.object({ leaseId: z.string() }),
    write: false,
    execute: (accountId, input) =>
      leaseService.draftRenewal(accountId, (input as { leaseId: string }).leaseId),
  },
  {
    name: 'list_transactions',
    description:
      'Ledger transactions with optional filters (from/to ISO datetimes, propertyId, type, status, categoryId) and cursor pagination.',
    inputSchema: TransactionListQuerySchema,
    write: false,
    execute: (accountId, input) =>
      transactionService.list(accountId, input as z.infer<typeof TransactionListQuerySchema>),
  },
  {
    name: 'get_review_queue',
    description:
      'Transactions pending review (bank/receipt imports) with their AI-suggested category and confidence.',
    inputSchema: NoInputSchema,
    write: false,
    execute: (accountId) => transactionService.getReviewQueue(accountId),
  },
  {
    name: 'list_bank_discrepancies',
    description:
      'Imported bank transactions that disagree with what the ledger already records (amount or date mismatches against a matched entry) — the reconciliation exceptions awaiting a decision.',
    inputSchema: NoInputSchema,
    write: false,
    execute: (accountId) => transactionService.listBankDiscrepancies(accountId),
  },
  {
    name: 'list_contractors',
    description:
      'Contractor directory with usage stats derived from confirmed expense transactions matched by vendor name: jobsCount, avgCostCents and lastUsedAt per contractor. All amounts in integer cents.',
    inputSchema: NoInputSchema,
    write: false,
    execute: (accountId) => contractorService.list(accountId),
  },
  {
    name: 'get_contractor',
    description:
      'One contractor in full detail, including the confirmed expense transactions matched to them (their job history) and the derived usage stats.',
    inputSchema: z.object({ contractorId: z.string() }),
    write: false,
    execute: (accountId, input) =>
      contractorService.detail(accountId, (input as { contractorId: string }).contractorId),
  },
  {
    name: 'list_categories',
    description: 'All transaction categories (system IRS-aligned set plus custom ones).',
    inputSchema: NoInputSchema,
    write: false,
    execute: (accountId) => categoryService.list(accountId),
  },
  {
    name: 'get_rent_status',
    description:
      'Rent tracker for a period ("YYYY-MM", default current month): collected/outstanding cents, paid/total units and per-tenant rows with status and days late.',
    inputSchema: z.object({ period: PeriodSchema.optional() }),
    write: false,
    execute: (accountId, input) =>
      rentService.getMonthStatus(accountId, (input as { period?: string }).period),
  },
  {
    name: 'list_open_charges',
    description:
      'Every rent charge with a positive remaining balance (amountCents minus paidCents), across all periods — what is actually still owed. Use this rather than get_rent_status when picking a charge to apply a payment to.',
    inputSchema: NoInputSchema,
    write: false,
    execute: (accountId) => rentService.listOpenCharges(accountId),
  },
  {
    name: 'list_unlinked_deposits',
    description:
      'Confirmed income transactions for a period ("YYYY-MM", default current month) that look like rent but are not linked to a rent charge yet — the reconciliation gap between the bank feed and the rent tracker.',
    inputSchema: z.object({ period: PeriodSchema.optional() }),
    write: false,
    execute: (accountId, input) =>
      rentService.findUnlinkedRentDeposits(accountId, (input as { period?: string }).period),
  },
  {
    name: 'list_insights',
    description: 'Active insights, optionally filtered by scope (portfolio | property | tenant).',
    inputSchema: z.object({ scope: InsightScopeSchema.optional() }),
    write: false,
    execute: (accountId, input) =>
      insightService.listActive(accountId, (input as { scope?: InsightScope }).scope),
  },
  {
    name: 'list_reports',
    description: 'Previously generated reports (archive metadata, no data), filterable by type and taxYear.',
    inputSchema: z.object({
      type: ReportTypeSchema.optional(),
      taxYear: z.number().int().optional(),
    }),
    write: false,
    execute: (accountId, input) =>
      reportService.listGenerated(
        accountId,
        input as Parameters<typeof reportService.listGenerated>[1],
      ),
  },
  {
    name: 'get_report',
    description: 'One generated report including its snapshotted data (tables and totals).',
    inputSchema: z.object({ reportId: z.string() }),
    write: false,
    execute: (accountId, input) =>
      reportService.getById(accountId, (input as { reportId: string }).reportId),
  },
  {
    name: 'list_monthly_reviews',
    description:
      'The AI-generated monthly review archive (metadata only). Fetch one in full with get_report — a monthly review IS a report, so it needs no separate detail tool.',
    inputSchema: NoInputSchema,
    write: false,
    execute: (accountId) => reportService.listGenerated(accountId, { type: 'monthly_review' }),
  },
  {
    name: 'get_latest_weekly_brief',
    description:
      'The most recent weekly brief for this account, or null if none has been generated yet.',
    inputSchema: NoInputSchema,
    write: false,
    execute: (accountId) => reportService.getLatestWeeklyBrief(accountId),
  },
  {
    name: 'list_documents',
    description:
      'List uploaded documents. Filter by the entity they are attached to (entityType + entityId), by property or tenant (includes documents attached to their related units, leases and transactions), by document type, or by a name search.',
    inputSchema: z.object({
      entityType: DocumentEntityTypeSchema.optional(),
      entityId: z.string().optional(),
      propertyId: z.string().optional(),
      tenantId: z.string().optional(),
      type: DocumentTypeSchema.optional(),
      query: z.string().optional(),
    }),
    write: false,
    execute: (accountId, input) => {
      const { query, ...filters } = input as {
        query?: string;
      } & Parameters<typeof documentService.list>[1];
      return documentService.list(accountId, { ...filters, q: query });
    },
  },
  {
    name: 'list_recurring_templates',
    description:
      'Recurring transaction templates — standing instructions like "the mortgage is $2,400 on the 1st", NOT ledger rows. Each includes its derived nextOccurrence and lastDraftedOccurrence. Non-archived (active) only by default; pass includeArchived to also see paused ones. A template never posts a transaction itself — the nightly scheduler drafts its currently-due occurrence into the review queue as pending_review, and the user still has to confirm it there.',
    inputSchema: z.object({ includeArchived: z.boolean().optional() }),
    write: false,
    execute: (accountId, input) =>
      recurringService.list(accountId, input as { includeArchived?: boolean }),
  },
  // ── write tools — side effects stated plainly ───────────────────────────────
  {
    name: 'create_transaction',
    description:
      'WRITES to the ledger: creates a new income or expense transaction (amount in cents, always positive). This permanently records money movement and affects every report and KPI. If the result includes a rentMatch, the income looks like an expected rent payment — offer to link it via confirm_transaction with that rentPaymentId; never also call record_rent_payment for the same money (that would create a second ledger row).',
    inputSchema: CreateTransactionInputSchema,
    write: true,
    execute: (accountId, input, actor) =>
      transactionService.create(accountId, input as z.infer<typeof CreateTransactionInputSchema>, {
        actor,
      }),
  },
  {
    name: 'update_transaction',
    description:
      "WRITES to the ledger: edits an existing transaction's fields (date, amount in cents, type, description, property/unit attribution, category, vendor, classification, splits). Only the provided fields change; every report and KPI recomputes from the new values. `classification: null` clears back to ordinary; `splits` replaces the split lines wholesale (they must sum to the amount) and `splits: null` collapses back to a single category. A row backing a rent deposit refuses amount/date/type/classification edits.",
    inputSchema: UpdateTransactionInputSchema.extend({ transactionId: z.string() }),
    write: true,
    execute: (accountId, input, actor) => {
      const { transactionId, ...patch } = input as z.infer<typeof UpdateTransactionInputSchema> & {
        transactionId: string;
      };
      return transactionService.update(accountId, transactionId, patch, actor);
    },
  },
  {
    name: 'create_contractor',
    description:
      'WRITES: adds a contractor to the directory (name, trade, optional 1-5 rating, phone, email, website, notes). Usage stats then derive from expense transactions whose vendor matches the name.',
    inputSchema: CreateContractorInputSchema,
    write: true,
    execute: (accountId, input, actor) =>
      contractorService.create(accountId, input as z.infer<typeof CreateContractorInputSchema>, actor),
  },
  {
    name: 'update_contractor',
    description:
      "WRITES: edits a contractor's directory entry (name, trade, rating, phone, email, website, notes). Only the provided fields change; an explicit null clears an optional field. Renaming a contractor re-derives their usage stats, which match expense transactions by vendor name. Archiving is not available from chat.",
    inputSchema: UpdateContractorInputSchema.extend({ contractorId: z.string() }),
    write: true,
    execute: (accountId, input, actor) => {
      const { contractorId, ...patch } = input as z.infer<typeof UpdateContractorInputSchema> & {
        contractorId: string;
      };
      return contractorService.update(accountId, contractorId, patch, actor);
    },
  },
  {
    name: 'create_property',
    description:
      'WRITES: adds a property to the portfolio with its initial units (units array, at least one). Optional nickname, acquisition date (ISO)/cost (cents) and notes. The property immediately counts in every dashboard figure and derivation.',
    inputSchema: CreatePropertyInputSchema,
    write: true,
    execute: (accountId, input, actor) =>
      propertyService.create(accountId, input as z.infer<typeof CreatePropertyInputSchema>, actor),
  },
  {
    name: 'update_property',
    description:
      "WRITES: edits a property's fields (nickname, address, acquisition date/cost, notes). Only the provided fields change; units are managed with create_unit/update_unit. Archiving is not available from chat.",
    inputSchema: UpdatePropertyInputSchema.extend({ propertyId: z.string() }),
    write: true,
    execute: (accountId, input, actor) => {
      const { propertyId, ...patch } = input as z.infer<typeof UpdatePropertyInputSchema> & {
        propertyId: string;
      };
      return propertyService.update(accountId, propertyId, patch, actor);
    },
  },
  {
    name: 'create_unit',
    description:
      'WRITES: adds a unit to an existing property (label required; optional bedrooms, bathrooms, market rent in cents). The unit starts vacant until a lease is created.',
    inputSchema: CreateUnitInputSchema.extend({ propertyId: z.string() }),
    write: true,
    execute: (accountId, input, actor) => {
      const { propertyId, ...unitInput } = input as z.infer<typeof CreateUnitInputSchema> & {
        propertyId: string;
      };
      return unitService.create(accountId, propertyId, unitInput, actor);
    },
  },
  {
    name: 'update_unit',
    description:
      "WRITES: edits a unit's fields (label, bedrooms, bathrooms, market rent in cents). Only the provided fields change. Archiving is not available from chat.",
    inputSchema: UpdateUnitInputSchema.extend({ unitId: z.string() }),
    write: true,
    execute: (accountId, input, actor) => {
      const { unitId, ...patch } = input as z.infer<typeof UpdateUnitInputSchema> & {
        unitId: string;
      };
      return unitService.update(accountId, unitId, patch, actor);
    },
  },
  {
    name: 'create_mortgage',
    description:
      'WRITES: adds a mortgage to a property (lender, and a statement checkpoint — balanceCents + balanceAsOfDate, the balance the lender showed and the date it was true on; optional originalPrincipalCents, startDate, interestRateMilliPct in thousandths of a percent (6.375% = 6375), escrowNote, notes). Multiple mortgages per property are allowed (HELOCs/seconds exist). The property\'s current balance and equity recompute immediately from the checkpoint.',
    inputSchema: CreateMortgageInputSchema.extend({ propertyId: z.string() }),
    write: true,
    execute: (accountId, input, actor) => {
      const { propertyId, ...mortgageInput } = input as z.infer<typeof CreateMortgageInputSchema> & {
        propertyId: string;
      };
      return mortgageService.create(accountId, propertyId, mortgageInput, actor);
    },
  },
  {
    name: 'update_mortgage',
    description:
      'WRITES: edits an existing mortgage. This is also how to re-checkpoint the balance — e.g. "my statement says the balance is $310k now": balanceCents and balanceAsOfDate must be provided TOGETHER (a new balance is only meaningful with the date it was true on; the app rejects one without the other). Other fields (lender, originalPrincipalCents, startDate, interestRateMilliPct, escrowNote, notes) may be edited independently, and only the provided fields change. Archiving is not available from chat.',
    // Must stay a flat object schema: `zodToJsonSchema` turns an intersection
    // into `allOf` with no top-level `properties`, which the Anthropic tool API
    // rejects. `UpdateMortgageFieldsSchema` is the unrefined shape for exactly
    // this; the balanceCents/balanceAsOfDate pairing rule is enforced in
    // `mortgage.service.update`, so composing here can't bypass it.
    inputSchema: UpdateMortgageFieldsSchema.extend({ mortgageId: z.string() }),
    write: true,
    execute: (accountId, input, actor) => {
      const { mortgageId, ...patch } = input as z.infer<typeof UpdateMortgageFieldsSchema> & {
        mortgageId: string;
      };
      return mortgageService.update(accountId, mortgageId, patch, actor);
    },
  },
  {
    name: 'record_property_valuation',
    description:
      'WRITES: records an owner-provided value for a property as of a date (valueCents, asOfDate ISO, source: "owner_estimate"|"appraisal"|"tax_assessment"|"other", optional notes). This is always an owner-entered figure, never a market estimate. The latest valuation as of today feeds the property\'s equity figure; deleting a valuation is not available from chat.',
    inputSchema: CreatePropertyValuationInputSchema.extend({ propertyId: z.string() }),
    write: true,
    execute: (accountId, input, actor) => {
      const { propertyId, ...valuationInput } = input as z.infer<
        typeof CreatePropertyValuationInputSchema
      > & { propertyId: string };
      return valuationService.create(accountId, propertyId, valuationInput, actor);
    },
  },
  {
    name: 'create_recurring_template',
    description:
      'WRITES: adds a recurring transaction template — a standing instruction like "the mortgage is $2,400 on the 1st" (description, type "income"|"expense", amountCents, cadence "monthly"|"quarterly"|"annual", anchorDate "YYYY-MM-DD" — the first occurrence, a calendar date in the account\'s own timezone with no time part; optional vendor, propertyId, unitId, categoryId, and for a mortgage payment mortgageId + principalCents, which stamps that breakdown onto every row it drafts). This does NOT record a payment or touch the ledger itself: the nightly scheduler drafts only the currently-due occurrence into the review queue as a pending row, and the user still confirms it there like any other transaction — nothing here is ever auto-confirmed. If the current occurrence is already due, one row drafts immediately on creation.',
    inputSchema: CreateRecurringTemplateInputSchema,
    write: true,
    execute: (accountId, input, actor) =>
      recurringService.create(
        accountId,
        input as z.infer<typeof CreateRecurringTemplateInputSchema>,
        actor,
      ),
  },
  {
    name: 'create_tenant',
    description:
      'WRITES: adds a person to the tenant directory (full name required; optional email, phone, notes). This only creates the record — put them on a unit with create_lease or add_tenant_to_lease. Archiving is not available from chat.',
    inputSchema: CreateTenantInputSchema,
    write: true,
    execute: (accountId, input, actor) =>
      tenantService.create(accountId, input as z.infer<typeof CreateTenantInputSchema>, actor),
  },
  {
    name: 'update_tenant',
    description:
      "WRITES: edits a tenant's contact record (full name, email, phone, notes). Only the provided fields change; leases and payment history are untouched. Archiving and PII erasure are not available from chat.",
    inputSchema: UpdateTenantInputSchema.extend({ tenantId: z.string() }),
    write: true,
    execute: (accountId, input, actor) => {
      const { tenantId, ...patch } = input as z.infer<typeof UpdateTenantInputSchema> & {
        tenantId: string;
      };
      return tenantService.update(accountId, tenantId, patch, actor);
    },
  },
  {
    name: 'create_lease',
    description:
      'WRITES: creates a real active lease on a unit (unitId, tenantIds — the first is the primary tenant — rentCents, dueDay 1-31, startDate and endDate as ISO datetimes; endDate is the inclusive last day). Optional lateFeeCents overrides the account default (0 = no late fee for this lease). The unit counts as occupied immediately and rent charges start being billed for the covered months; a date range overlapping an existing lease on that unit is rejected.',
    inputSchema: CreateLeaseInputSchema,
    write: true,
    execute: (accountId, input, actor) =>
      leaseService.create(accountId, input as z.infer<typeof CreateLeaseInputSchema>, actor),
  },
  {
    name: 'update_lease',
    description:
      "WRITES: edits an existing lease's terms (rentCents, dueDay, lateFeeCents, startDate, endDate, status). Only the provided fields change. Rent and date changes affect what the tenant is billed going forward; `lateFeeCents: null` clears back to the account default. To end a lease use terminate_lease and to replace it with new terms use renew_lease — don't do either by editing status or dates here.",
    inputSchema: UpdateLeaseInputSchema.extend({ leaseId: z.string() }),
    write: true,
    execute: (accountId, input, actor) => {
      const { leaseId, ...patch } = input as z.infer<typeof UpdateLeaseInputSchema> & {
        leaseId: string;
      };
      return leaseService.update(accountId, leaseId, patch, actor);
    },
  },
  {
    name: 'renew_lease',
    description:
      'WRITES: enacts a renewal — creates a REAL new active lease on the same unit with the given terms (rentCents, dueDay, startDate, endDate) and ends the current lease on the new start date. Tenants carry over unless tenantIds overrides them. Open rent charges are re-prorated across the switchover month so the unit is never billed twice. This is the executing counterpart to draft_lease_renewal; confirm the terms with the user before calling it.',
    inputSchema: AcceptRenewalInputSchema.extend({ leaseId: z.string() }),
    write: true,
    execute: (accountId, input, actor) => {
      const { leaseId, ...renewalInput } = input as z.infer<typeof AcceptRenewalInputSchema> & {
        leaseId: string;
      };
      return leaseService.createRenewal(accountId, leaseId, renewalInput, actor);
    },
  },
  {
    name: 'terminate_lease',
    description:
      'WRITES: ends an active lease now — status becomes "ended" and the end date moves to today (unless it was already in the past). The tenancy is over: the unit reads vacant, unpaid charges for months the lease no longer covers are voided, and the final month re-prorates to the days actually occupied. There is no undo from chat. Only do this when the user has explicitly asked to end that specific lease.',
    inputSchema: z.object({ leaseId: z.string() }),
    write: true,
    execute: (accountId, input, actor) =>
      leaseService.terminate(accountId, (input as { leaseId: string }).leaseId, actor),
  },
  {
    name: 'add_tenant_to_lease',
    description:
      'WRITES: adds an existing tenant to a lease as a co-tenant (tenantId; isPrimary promotes them and demotes the current primary; shareCents sets their expected portion of the rent, omitted = even split). The tenant record must already exist — create it with create_tenant first.',
    inputSchema: AddLeaseTenantInputSchema.extend({ leaseId: z.string() }),
    write: true,
    execute: (accountId, input, actor) => {
      const { leaseId, ...tenantInput } = input as z.infer<typeof AddLeaseTenantInputSchema> & {
        leaseId: string;
      };
      return leaseService.addTenant(accountId, leaseId, tenantInput, actor);
    },
  },
  {
    // The one removal-shaped write tool. It deletes no record — only the
    // lease↔tenant link — is guarded so a lease always keeps at least one
    // tenant, auto-promotes a new primary, and is fully restorable with
    // add_tenant_to_lease. Without it, add_tenant_to_lease is a one-way door
    // the assistant can't correct. Deliberately NOT on the web action-card
    // allowlist (it's a DELETE at the REST layer).
    name: 'remove_tenant_from_lease',
    description:
      "WRITES: takes a tenant off a lease's roster (their rent share is dropped and a co-tenant is promoted to primary if the removed one was). The tenant record, their payment history and the lease itself all stay — only the link is removed. Rejected if it would leave the lease with no tenants. Reversible with add_tenant_to_lease.",
    inputSchema: z.object({ leaseId: z.string(), tenantId: z.string() }),
    write: true,
    execute: (accountId, input, actor) => {
      const { leaseId, tenantId } = input as { leaseId: string; tenantId: string };
      return leaseService.removeTenant(accountId, leaseId, tenantId, actor);
    },
  },
  {
    name: 'confirm_transaction',
    description:
      'WRITES: confirms (categorizes) a pending-review transaction, moving it into the ledger. Pass categoryId to override the AI suggestion; omit it to accept the suggestion. Pass propertyId/unitId to attribute the transaction. Pass rentPaymentId to link an income transaction (a bank deposit or an already-confirmed manual entry) to that expected rent payment and mark it paid — amounts must match exactly, and property/unit then come from the lease. For a MORTGAGE PAYMENT (the row carries a mortgageId, stamped when its vendor matched a lender): pass principalCents for the portion that repays the loan — it is not an expense and it reduces the mortgage balance — and put the remainder on categoryId (usually Mortgage Interest) or across splits, which must sum to amountCents minus principalCents. Never estimate the principal: it comes from the lender statement, so ask the user for the figure rather than deriving one from the rate or balance.',
    // The REST contract itself, so this tool cannot silently fall behind it —
    // it did exactly that when confirm gained the mortgage breakdown, leaving
    // the assistant able to confirm a mortgage payment only by expensing the
    // whole debit. `linkSource` is deliberately omitted: it decides whether a
    // rent link audits as the user's own choice, which a model-invoked write
    // must not be able to claim.
    inputSchema: ConfirmTransactionInputSchema.omit({ linkSource: true }).extend({
      transactionId: z.string(),
    }),
    write: true,
    execute: (accountId, input, actor) => {
      const { transactionId, ...confirmInput } = input as z.infer<
        typeof ConfirmTransactionInputSchema
      > & { transactionId: string };
      return transactionService.confirm(accountId, transactionId, confirmInput, actor);
    },
  },
  {
    name: 'record_rent_payment',
    description:
      'WRITES: records a rent payment for a lease/period as paid and creates the matching income transaction in the ledger. Cannot be undone from chat. amountCents may be at most the remaining balance for the period (charge minus what is already paid); a smaller amount records a partial payment and the charge shows "partial" until fully covered.',
    inputSchema: RecordRentPaymentInputSchema,
    write: true,
    execute: (accountId, input, actor) =>
      rentService.recordPayment(
        accountId,
        input as z.infer<typeof RecordRentPaymentInputSchema>,
        actor,
      ),
  },
  {
    name: 'apply_late_fee',
    description:
      'WRITES: applies a late fee to a rent charge that is past its grace period, stamping the fee on the charge so it is added to what the tenant owes (total due = rent + late fee). No money is recorded — nothing has been received yet; the fee shows up in the ledger only when the tenant pays it. Only for a charge that is currently late (or a partial payment past grace) and has no fee applied yet — one fee per charge. Omit feeCents to use the configured policy (the lease override, else the account default); a charge with no policy configured is rejected. Waiving a fee is a Rent-page action, not available here.',
    inputSchema: ApplyLateFeeInputSchema.extend({ rentPaymentId: z.string() }),
    write: true,
    execute: (accountId, input, actor) => {
      const { rentPaymentId, ...feeInput } = input as z.infer<typeof ApplyLateFeeInputSchema> & {
        rentPaymentId: string;
      };
      return rentService.applyLateFee(accountId, rentPaymentId, feeInput, actor);
    },
  },
  {
    name: 'send_rent_reminders',
    description:
      'WRITES: composes a rent reminder email for the tenant behind each given rentPaymentId and marks it reminded. Invoked from chat/MCP this composes ONLY — it returns a mailto: link for the landlord to review and send from their own mail client; no email is ever sent server-side by the model itself. A real server-side send happens only when the user triggers it (the Rent page button or clicking an action card, which calls the REST route). Already-paid rows are skipped.',
    inputSchema: SendRemindersInputSchema,
    write: true,
    execute: (accountId, input, actor) =>
      rentService.sendReminders(accountId, input as z.infer<typeof SendRemindersInputSchema>, actor),
  },
  {
    name: 'generate_report',
    description:
      'WRITES: generates and archives a report snapshot (type + taxYear or from/to, optional propertyId). Returns the report metadata; fetch data with get_report.',
    inputSchema: GenerateReportInputSchema,
    write: true,
    execute: (accountId, input, actor) =>
      reportService.generate(accountId, input as z.infer<typeof GenerateReportInputSchema>, actor),
  },
  {
    name: 'email_report',
    description:
      'SENDS EMAIL: emails a generated report to the given address (e.g. an accountant) — irreversible.',
    inputSchema: z.object({ reportId: z.string(), to: z.string().email() }),
    write: true,
    execute: async (accountId, input, actor) => {
      const { reportId, to } = input as { reportId: string; to: string };
      await reportService.emailToAccountant(accountId, reportId, to, actor);
      return { sent: true, to };
    },
  },
  {
    name: 'dismiss_insight',
    description: 'WRITES: dismisses an insight — it stays hidden until a materially new one is generated.',
    inputSchema: z.object({ insightId: z.string() }),
    write: true,
    execute: (accountId, input, actor) =>
      insightService.dismiss(accountId, (input as { insightId: string }).insightId, actor),
  },
];

// ── render tools (loop-handled; input IS the shared block schema) ─────────────

export const ASK_USER_QUESTION_TOOL = 'ask_user_question';

/** ask_user_question input = the block minus type (injected by the loop from
 *  `blockType`), questionId (assigned by the loop) and allowFreeText (always
 *  true). */
export const AskUserQuestionInputSchema = AskUserQuestionBlockSchema.omit({
  type: true,
  questionId: true,
  allowFreeText: true,
});

export const renderTools: RenderToolDef[] = [
  {
    name: 'render_chart',
    description:
      'Render a chart in the chat transcript. Use for any numeric comparison or trend. y values are integer cents when yUnit is "usd". description is required alt text.',
    blockType: 'chart',
    inputSchema: ChartBlockSchema.omit({ type: true }),
  },
  {
    name: 'render_table',
    description:
      'Render a data table in the chat transcript. Use for lists of records or per-entity breakdowns. Column format "usd" expects integer cents in the rows.',
    blockType: 'data_table',
    inputSchema: DataTableBlockSchema.omit({ type: true }),
  },
  {
    name: 'propose_action',
    description:
      'Show an action card with buttons the USER can click to perform a change (api_call against the normal REST API, or navigate). Use this for anything that changes data instead of doing it yourself.',
    blockType: 'action_card',
    inputSchema: ActionCardBlockSchema.omit({ type: true }),
  },
  {
    name: ASK_USER_QUESTION_TOOL,
    description:
      'Pause and ask the user a clarifying preference question with 2-4 mutually exclusive options (e.g. which tax year). Only for genuine user-preference ambiguity — never for things a tool can answer.',
    blockType: 'ask_user_question',
    inputSchema: AskUserQuestionInputSchema,
  },
];

export function findServiceTool(name: string): ServiceToolDef | undefined {
  return serviceTools.find((t) => t.name === name);
}

// Maps each write tool to the MemberPermission area that gates the equivalent
// REST route, so a member can't bypass a route guard via the assistant
// (docs/WHATS_NEXT.md §4). Write tools absent from this map (e.g. dismiss_insight,
// which has no gated REST area) require only the 'ai' capability below.
export const WRITE_TOOL_PERMISSIONS: Partial<Record<string, MemberPermission>> = {
  create_transaction: 'money',
  update_transaction: 'money',
  confirm_transaction: 'money',
  // A template's whole job is minting ledger rows on a schedule, so it needs
  // the same 'money' grant as create_transaction — not 'properties', even
  // though it may reference a property.
  create_recurring_template: 'money',
  create_contractor: 'properties',
  update_contractor: 'properties',
  create_property: 'properties',
  update_property: 'properties',
  create_unit: 'properties',
  update_unit: 'properties',
  create_mortgage: 'properties',
  update_mortgage: 'properties',
  record_property_valuation: 'properties',
  // Leases are part of tenant management → same 'tenants' grant the
  // /leases and /tenants write routes use (routes/leases.ts).
  create_tenant: 'tenants',
  update_tenant: 'tenants',
  create_lease: 'tenants',
  update_lease: 'tenants',
  renew_lease: 'tenants',
  terminate_lease: 'tenants',
  add_tenant_to_lease: 'tenants',
  remove_tenant_from_lease: 'tenants',
  record_rent_payment: 'rent',
  apply_late_fee: 'rent',
  send_rent_reminders: 'rent',
  generate_report: 'reports',
  email_report: 'reports',
};

/** Names of write tools the acting user may NOT run in chat. Owners (and demo
 *  mode) are unrestricted. A member needs the 'ai' capability to run any write
 *  tool at all, plus the tool's mapped area permission where one applies. */
export function deniedWriteTools(role: UserRole, permissions: MemberPermission[]): Set<string> {
  if (role === 'owner') return new Set();
  const writeNames = serviceTools.filter((t) => t.write).map((t) => t.name);
  if (!permissions.includes('ai')) return new Set(writeNames);
  return new Set(
    writeNames.filter((name) => {
      const area = WRITE_TOOL_PERMISSIONS[name];
      return area !== undefined && !permissions.includes(area);
    }),
  );
}

export function findRenderTool(name: string): RenderToolDef | undefined {
  return renderTools.find((t) => t.name === name);
}

/** All tools (service + render) in Anthropic tool format. */
export function anthropicToolDefs(): Tool[] {
  return [...serviceTools, ...renderTools].map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: zodToJsonSchema(t.inputSchema, { $refStrategy: 'none' }) as Tool['input_schema'],
  }));
}
