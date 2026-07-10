// The single tool registry (ARCHITECTURE §4 A/A(write) markers) used by BOTH
// the chat agent loop and the MCP server. Each service tool binds a zod input
// schema to a service function; render tools carry the shared block schemas as
// their input and are handled by the loop itself (never executed here).
import {
  ActionCardBlockSchema,
  AskUserQuestionBlockSchema,
  ChartBlockSchema,
  ConfirmTransactionInputSchema,
  CreateContractorInputSchema,
  CreateTransactionInputSchema,
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
} from '@hearth/shared';
import type { ContentBlock, InsightScope, LeaseStatus } from '@hearth/shared';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { currentPeriod, yearRange } from '../lib/dates';
import * as categoryService from '../services/category.service';
import * as contractorService from '../services/contractor.service';
import * as dashboardService from '../services/dashboard.service';
import * as documentService from '../services/document.service';
import * as insightService from '../services/insight.service';
import * as leaseService from '../services/lease.service';
import * as propertyService from '../services/property.service';
import * as rentService from '../services/rent.service';
import * as reportService from '../services/report.service';
import * as tenantService from '../services/tenant.service';
import * as transactionService from '../services/transaction.service';
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
      'Full detail for one property: units with current lease + tenants, MTD/YTD P&L and any active insights.',
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
    execute: (accountId, input) => {
      const { propertyId, from, to } = input as z.infer<typeof PropertyPnlInputSchema>;
      const fallback = yearRange(new Date().getUTCFullYear());
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
    name: 'list_leases',
    description: 'All leases, optionally filtered by status (active | ended | pending_signature).',
    inputSchema: z.object({ status: LeaseStatusSchema.optional() }),
    write: false,
    execute: (accountId, input) =>
      leaseService.list(accountId, input as { status?: LeaseStatus }),
  },
  {
    name: 'draft_lease_renewal',
    description:
      'Draft renewal terms for a lease (suggested rent from the market-rent heuristic, proposed dates). Returns a proposal only — nothing is sent or saved.',
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
    name: 'list_contractors',
    description:
      'Contractor directory with usage stats derived from confirmed expense transactions matched by vendor name: jobsCount, avgCostCents and lastUsedAt per contractor. All amounts in integer cents.',
    inputSchema: NoInputSchema,
    write: false,
    execute: (accountId) => contractorService.list(accountId),
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
      rentService.getMonthStatus(accountId, (input as { period?: string }).period ?? currentPeriod()),
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
  // ── write tools — side effects stated plainly ───────────────────────────────
  {
    name: 'create_transaction',
    description:
      'WRITES to the ledger: creates a new income or expense transaction (amount in cents, always positive). This permanently records money movement and affects every report and KPI.',
    inputSchema: CreateTransactionInputSchema,
    write: true,
    execute: (accountId, input, actor) =>
      transactionService.create(accountId, input as z.infer<typeof CreateTransactionInputSchema>, {
        actor,
      }),
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
    name: 'confirm_transaction',
    description:
      'WRITES: confirms (categorizes) a pending-review transaction, moving it into the ledger. Pass categoryId to override the AI suggestion; omit it to accept the suggestion. Pass propertyId/unitId to attribute the transaction. Pass rentPaymentId to link a bank deposit to that expected rent payment and mark it paid (property/unit then come from the lease).',
    inputSchema: z.object({
      transactionId: z.string(),
      categoryId: z.string().optional(),
      rentPaymentId: z.string().optional(),
      propertyId: z.string().optional(),
      unitId: z.string().optional(),
    }),
    write: true,
    execute: (accountId, input, actor) => {
      const { transactionId, ...confirmInput } = input as {
        transactionId: string;
        categoryId?: string;
        rentPaymentId?: string;
        propertyId?: string;
        unitId?: string;
      };
      return transactionService.confirm(accountId, transactionId, confirmInput, actor);
    },
  },
  {
    name: 'record_rent_payment',
    description:
      'WRITES: records a rent payment for a lease/period as paid and creates the matching income transaction in the ledger. Cannot be undone from chat.',
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
    name: 'send_rent_reminders',
    description:
      'WRITES + SENDS EMAIL: sends a rent reminder email to the tenant behind each given rentPaymentId — irreversible. Already-paid rows are skipped.',
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
