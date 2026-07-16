// All enums per ARCHITECTURE §2. Source of truth — the DB stores plain strings
// validated against these zod enums.
import { z } from 'zod';

export const TransactionTypeSchema = z.enum(['income', 'expense']);
export type TransactionType = z.infer<typeof TransactionTypeSchema>;

export const TransactionSourceSchema = z.enum(['manual', 'receipt', 'bank']);
export type TransactionSource = z.infer<typeof TransactionSourceSchema>;

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
]);
export type ReportType = z.infer<typeof ReportTypeSchema>;

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
]);
export type DocumentEntityType = z.infer<typeof DocumentEntityTypeSchema>;

// iOS-only for now (Phase 2 mobile shell); android joins here when it ships.
export const PushPlatformSchema = z.enum(['ios']);
export type PushPlatform = z.infer<typeof PushPlatformSchema>;

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
