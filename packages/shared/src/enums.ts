// All enums per ARCHITECTURE §2. Source of truth — the DB stores plain strings
// validated against these zod enums.
import { z } from 'zod';

export const TransactionTypeSchema = z.enum(['income', 'expense']);
export type TransactionType = z.infer<typeof TransactionTypeSchema>;

// 'recurring' = drafted by the scheduler from a RecurringTemplate. Additive:
// it lands in the review queue like any other unconfirmed row and is never
// auto-confirmed.
export const TransactionSourceSchema = z.enum(['manual', 'receipt', 'bank', 'recurring']);
export type TransactionSource = z.infer<typeof TransactionSourceSchema>;

// How often a RecurringTemplate comes due. Insurance is often annual and HOA
// dues quarterly, so monthly alone would not cover the real cases.
export const RecurrenceCadenceSchema = z.enum(['monthly', 'quarterly', 'annual']);
export type RecurrenceCadence = z.infer<typeof RecurrenceCadenceSchema>;

// 'dismissed' = denied from the review queue: kept (so bank-import dedup by
// externalId still holds) but excluded from reports/dashboards, which only
// count 'confirmed' rows.
export const TransactionStatusSchema = z.enum(['pending_review', 'confirmed', 'dismissed']);
export type TransactionStatus = z.infer<typeof TransactionStatusSchema>;

// Money movement that isn't plain income/expense (plan §D1). `transfer` and
// `owner_contribution` are excluded from P&L/KPIs entirely (moving your own
// money isn't income); `refund` stays in reports but nets against its expense
// category instead of counting as income. Null/absent = ordinary row.
export const TransactionClassificationSchema = z.enum([
  'transfer',
  'owner_contribution',
  'refund',
]);
export type TransactionClassification = z.infer<typeof TransactionClassificationSchema>;

export const RentPaymentStatusSchema = z.enum(['due', 'processing', 'paid', 'failed']);
export type RentPaymentStatus = z.infer<typeof RentPaymentStatusSchema>;

export const RentPaymentMethodSchema = z.enum(['online', 'manual', 'bank']);
export type RentPaymentMethod = z.infer<typeof RentPaymentMethodSchema>;

// How Account.graceDays is measured: 'calendar' counts every day (default);
// 'business' counts only Mon–Fri (holidays out of scope — see dates.ts
// businessDaysBetweenInTz). Grace-period eligibility (late/partial-past-grace,
// and therefore late-fee eligibility) is basis-aware; the *displayed*
// days-late figure always stays a calendar-day count regardless of basis.
export const GraceDaysBasisSchema = z.enum(['calendar', 'business']);
export type GraceDaysBasis = z.infer<typeof GraceDaysBasisSchema>;

export const LeaseStatusSchema = z.enum(['active', 'ended', 'pending_signature']);
export type LeaseStatus = z.infer<typeof LeaseStatusSchema>;

export const EsignStatusSchema = z.enum(['sent', 'viewed', 'signed']);
export type EsignStatus = z.infer<typeof EsignStatusSchema>;

export const ReportTypeSchema = z.enum([
  'balance_sheet',
  'income_statement',
  'pnl',
  'net_cashflow',
  'rent_roll',
  'reo_schedule',
  'capital_expenses',
  'general_ledger',
  'tenant_ledger',
  'escrow_ledger',
  'schedule_e',
  'tax_package',
  'stress_test',
  'monthly_review',
  'weekly_brief',
]);
export type ReportType = z.infer<typeof ReportTypeSchema>;

// Notification routing (schemas/notification.ts): each category can be
// delivered per channel according to the recipient's NotificationPrefs.
export const NotificationCategorySchema = z.enum([
  'warning_insights',
  'weekly_brief',
  'monthly_review',
]);
export type NotificationCategory = z.infer<typeof NotificationCategorySchema>;

export const NotificationChannelSchema = z.enum(['push', 'email']);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const InsightScopeSchema = z.enum(['portfolio', 'property', 'tenant']);
export type InsightScope = z.infer<typeof InsightScopeSchema>;

// 'resolved' = the condition that triggered the insight is no longer true
// (currently only late_rent auto-resolves this way — see insight.service.ts).
export const InsightStatusSchema = z.enum(['active', 'dismissed', 'actioned', 'resolved']);
export type InsightStatus = z.infer<typeof InsightStatusSchema>;

export const InsightSeveritySchema = z.enum(['info', 'warning', 'positive']);
export type InsightSeverity = z.infer<typeof InsightSeveritySchema>;

// 'stripe' is rent payments (deferred); 'stripe_fc' is Stripe Financial
// Connections — a bank-transaction feed alongside Plaid, not a payment rail.
export const IntegrationTypeSchema = z.enum([
  'plaid',
  'stripe',
  'stripe_fc',
  'docusign',
  'email',
  'mcp_client',
]);
export type IntegrationType = z.infer<typeof IntegrationTypeSchema>;

export const IntegrationStatusSchema = z.enum(['connected', 'disconnected', 'mock']);
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

// 'owner' is the account creator (full control, incl. team/billing/settings);
// 'member' is an invited teammate whose write access is the set of
// MemberPermissions the owner granted them. Reads are open to both.
export const UserRoleSchema = z.enum(['owner', 'member']);
export type UserRole = z.infer<typeof UserRoleSchema>;

// Grantable write areas for a member (owner-configurable per member). Reads are
// always allowed; only writes are gated. Owner-only actions (team management,
// billing/seats, account settings, account deletion, integrations) are never
// grantable and are gated by role instead.
export const MemberPermissionSchema = z.enum([
  'properties', // create/edit/archive properties & units
  'tenants', // create/edit tenants & leases
  'money', // transactions, categories, bank import/review-queue confirms
  'rent', // rent tracker, record payments, send reminders
  'reports', // generate/email reports
  'ai', // use the chat assistant's write tools
]);
export type MemberPermission = z.infer<typeof MemberPermissionSchema>;

/** Every grantable permission — the full set an owner implicitly holds. */
export const ALL_MEMBER_PERMISSIONS: MemberPermission[] = MemberPermissionSchema.options;

export const ChatRoleSchema = z.enum(['user', 'assistant']);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatSessionStatusSchema = z.enum(['idle', 'running', 'awaiting_user']);
export type ChatSessionStatus = z.infer<typeof ChatSessionStatusSchema>;

// The single entity a Document attaches to; display context (e.g. a lease doc
// appearing on its tenants and property) is derived, never stored.
export const DocumentEntityTypeSchema = z.enum([
  'property',
  'unit',
  'tenant',
  'lease',
  'transaction',
  // Photos of the problem, the contractor's quote, the signed invoice.
  'work_order',
]);
export type DocumentEntityType = z.infer<typeof DocumentEntityTypeSchema>;

// iOS-only for now (Phase 2 mobile shell); android joins here when it ships.
// Maintenance work orders (PRD §5.10, PLAN-MAINTENANCE §3).
//
// Status is *stored*, not derived — `in_progress` and `cancelled` have no date
// proxy, and "I've done it" is a statement only the user can make. Lateness is
// derived from `dueBy` instead, exactly the RentPayment split (stored status,
// derived late/partial). Transitions are validated in work-order.service, not
// in a route refine, so chat/MCP and REST share one rule and tool schemas stay
// flat objects.
export const WorkOrderStatusSchema = z.enum([
  'open',
  'scheduled',
  'in_progress',
  'completed',
  'cancelled',
]);
export type WorkOrderStatus = z.infer<typeof WorkOrderStatusSchema>;

/** Terminal states — no cost accrues to a cancelled order, and both are excluded from "open work". */
export const TERMINAL_WORK_ORDER_STATUSES: readonly WorkOrderStatus[] = ['completed', 'cancelled'];

// Three levels, not the conventional four. For a single-digit-property
// portfolio the only distinction that changes behaviour is "drop everything";
// a high-vs-normal choice with no behavioural consequence is a field that gets
// filled in at random. `emergency` is the one carrying habitability weight.
export const WorkOrderPrioritySchema = z.enum(['emergency', 'normal', 'low']);
export type WorkOrderPriority = z.infer<typeof WorkOrderPrioritySchema>;

// Where the report came from. v1 only ever writes 'landlord'; the value exists
// so a phase-2 tenant portal adds a case rather than a subsystem (PRD §11).
export const WorkOrderSourceSchema = z.enum(['landlord', 'tenant']);
export type WorkOrderSource = z.infer<typeof WorkOrderSourceSchema>;

export const PushPlatformSchema = z.enum(['ios']);
export type PushPlatform = z.infer<typeof PushPlatformSchema>;

// Beta feedback triage buckets ("Send feedback" in the app shell).
export const FeedbackCategorySchema = z.enum(['bug', 'idea', 'other']);
export type FeedbackCategory = z.infer<typeof FeedbackCategorySchema>;

// Onboarding (getting-started checklist for new accounts). `completed` is
// always derived — the API returns it when every step is completed or skipped;
// only not_started | in_progress | dismissed are ever stored.
export const OnboardingStatusSchema = z.enum([
  'not_started',
  'in_progress',
  'completed',
  'dismissed',
]);
export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>;

export const OnboardingStepIdSchema = z.enum([
  'add_property',
  'add_tenant',
  'create_lease',
  'connect_bank',
]);
export type OnboardingStepId = z.infer<typeof OnboardingStepIdSchema>;

// `completed` is derived from real portfolio data (the entity exists), never
// stored; `skipped` is the user's explicit choice and is persisted.
export const OnboardingStepStateSchema = z.enum(['pending', 'completed', 'skipped']);
export type OnboardingStepState = z.infer<typeof OnboardingStepStateSchema>;

// Where a PropertyValuation figure came from. Every value is entered by the
// user — the PRD excludes external estimate integrations — so the UI must
// always label these as owner-provided, never as market data.
export const ValuationSourceSchema = z.enum([
  'owner_estimate',
  'appraisal',
  'tax_assessment',
  'other',
]);
export type ValuationSource = z.infer<typeof ValuationSourceSchema>;

export const DocumentTypeSchema = z.enum([
  'lease',
  'insurance',
  'receipt',
  'inspection',
  'notice',
  'tax',
  'other',
]);
export type DocumentType = z.infer<typeof DocumentTypeSchema>;
