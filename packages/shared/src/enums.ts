// All enums per ARCHITECTURE §2. Source of truth — the DB stores plain strings
// validated against these zod enums.
import { z } from 'zod';

export const TransactionTypeSchema = z.enum(['income', 'expense']);
export type TransactionType = z.infer<typeof TransactionTypeSchema>;

export const TransactionSourceSchema = z.enum(['manual', 'receipt', 'bank']);
export type TransactionSource = z.infer<typeof TransactionSourceSchema>;

export const TransactionStatusSchema = z.enum(['pending_review', 'confirmed']);
export type TransactionStatus = z.infer<typeof TransactionStatusSchema>;

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

export const InsightStatusSchema = z.enum(['active', 'dismissed', 'actioned']);
export type InsightStatus = z.infer<typeof InsightStatusSchema>;

export const InsightSeveritySchema = z.enum(['info', 'warning', 'positive']);
export type InsightSeverity = z.infer<typeof InsightSeveritySchema>;

export const IntegrationTypeSchema = z.enum(['plaid', 'stripe', 'docusign', 'email', 'mcp_client']);
export type IntegrationType = z.infer<typeof IntegrationTypeSchema>;

export const IntegrationStatusSchema = z.enum(['connected', 'disconnected', 'mock']);
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

export const UserRoleSchema = z.enum(['owner']);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const ChatRoleSchema = z.enum(['user', 'assistant']);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatSessionStatusSchema = z.enum(['idle', 'running', 'awaiting_user']);
export type ChatSessionStatus = z.infer<typeof ChatSessionStatusSchema>;
