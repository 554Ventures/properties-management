// z.infer type re-exports — one type per schema, name = schema const minus
// the `Schema` suffix. Enum types live in enums.ts; SseEventName/SseEvent in
// schemas/chat.ts.
import type { z } from 'zod';
import type * as s from './schemas/api';

// Errors
export type ApiError = z.infer<typeof s.ApiErrorSchema>;

// Account / settings
export type Account = z.infer<typeof s.AccountSchema>;
export type AccountSettings = z.infer<typeof s.AccountSettingsSchema>;
export type UpdateAccountSettingsInput = z.infer<typeof s.UpdateAccountSettingsInputSchema>;

// Properties
export type Property = z.infer<typeof s.PropertySchema>;
export type CreatePropertyInput = z.infer<typeof s.CreatePropertyInputSchema>;
export type UpdatePropertyInput = z.infer<typeof s.UpdatePropertyInputSchema>;
export type PropertyWithStats = z.infer<typeof s.PropertyWithStatsSchema>;
export type PropertyListResponse = z.infer<typeof s.PropertyListResponseSchema>;
export type PnlTotals = z.infer<typeof s.PnlTotalsSchema>;
export type PnlSummary = z.infer<typeof s.PnlSummarySchema>;
export type PnlCategoryLine = z.infer<typeof s.PnlCategoryLineSchema>;
export type PropertyPnlResponse = z.infer<typeof s.PropertyPnlResponseSchema>;
export type LeaseWithTenants = z.infer<typeof s.LeaseWithTenantsSchema>;
export type PropertyDetailUnit = z.infer<typeof s.PropertyDetailUnitSchema>;
export type PropertyDetailResponse = z.infer<typeof s.PropertyDetailResponseSchema>;

// Units
export type Unit = z.infer<typeof s.UnitSchema>;
export type CreateUnitInput = z.infer<typeof s.CreateUnitInputSchema>;
export type UpdateUnitInput = z.infer<typeof s.UpdateUnitInputSchema>;

// Tenants
export type Tenant = z.infer<typeof s.TenantSchema>;
export type TenantStatus = z.infer<typeof s.TenantStatusSchema>;
export type CreateTenantInput = z.infer<typeof s.CreateTenantInputSchema>;
export type UpdateTenantInput = z.infer<typeof s.UpdateTenantInputSchema>;
export type TenantListRow = z.infer<typeof s.TenantListRowSchema>;
export type TenantListResponse = z.infer<typeof s.TenantListResponseSchema>;
export type TenantDocument = z.infer<typeof s.TenantDocumentSchema>;
export type TenantLease = z.infer<typeof s.TenantLeaseSchema>;
export type TenantDetailResponse = z.infer<typeof s.TenantDetailResponseSchema>;

// Leases
export type Lease = z.infer<typeof s.LeaseSchema>;
export type LeaseListResponse = z.infer<typeof s.LeaseListResponseSchema>;
export type CreateLeaseInput = z.infer<typeof s.CreateLeaseInputSchema>;
export type UpdateLeaseInput = z.infer<typeof s.UpdateLeaseInputSchema>;
export type RenewalDraftResponse = z.infer<typeof s.RenewalDraftResponseSchema>;
export type EsignEnvelopeResponse = z.infer<typeof s.EsignEnvelopeResponseSchema>;

// Lease management composites
export type LeaseWithContext = z.infer<typeof s.LeaseWithContextSchema>;
export type LeaseDetailResponse = z.infer<typeof s.LeaseDetailResponseSchema>;
export type AddLeaseTenantInput = z.infer<typeof s.AddLeaseTenantInputSchema>;
export type AcceptRenewalInput = z.infer<typeof s.AcceptRenewalInputSchema>;

// Transactions
export type Transaction = z.infer<typeof s.TransactionSchema>;
export type CreateTransactionInput = z.infer<typeof s.CreateTransactionInputSchema>;
export type UpdateTransactionInput = z.infer<typeof s.UpdateTransactionInputSchema>;
export type ConfirmTransactionInput = z.infer<typeof s.ConfirmTransactionInputSchema>;
export type TransactionListQuery = z.infer<typeof s.TransactionListQuerySchema>;
export type TransactionSortField = z.infer<typeof s.TransactionSortFieldSchema>;
export type TransactionListResponse = z.infer<typeof s.TransactionListResponseSchema>;
export type RentMatchSuggestion = z.infer<typeof s.RentMatchSuggestionSchema>;
export type ReviewQueueItem = z.infer<typeof s.ReviewQueueItemSchema>;
export type ReviewQueueFilter = z.infer<typeof s.ReviewQueueFilterSchema>;
export type ReviewQueueQuery = z.infer<typeof s.ReviewQueueQuerySchema>;
export type ReviewQueueResponse = z.infer<typeof s.ReviewQueueResponseSchema>;
export type ConfirmAllReviewResponse = z.infer<typeof s.ConfirmAllReviewResponseSchema>;
export type DismissAllReviewResponse = z.infer<typeof s.DismissAllReviewResponseSchema>;
export type ReceiptScanResponse = z.infer<typeof s.ReceiptScanResponseSchema>;
export type ImportTransactionsResponse = z.infer<typeof s.ImportTransactionsResponseSchema>;

// Categories
export type Category = z.infer<typeof s.CategorySchema>;
export type CategoryListResponse = z.infer<typeof s.CategoryListResponseSchema>;
export type CreateCategoryInput = z.infer<typeof s.CreateCategoryInputSchema>;

// Rent
export type Period = z.infer<typeof s.PeriodSchema>;
export type RentStatus = z.infer<typeof s.RentStatusSchema>;
export type RentPayment = z.infer<typeof s.RentPaymentSchema>;
export type RentPaymentRow = z.infer<typeof s.RentPaymentRowSchema>;
export type RentTrackerRow = z.infer<typeof s.RentTrackerRowSchema>;
export type RentTrackerResponse = z.infer<typeof s.RentTrackerResponseSchema>;
export type RecordRentPaymentInput = z.infer<typeof s.RecordRentPaymentInputSchema>;
export type PaymentLinkResponse = z.infer<typeof s.PaymentLinkResponseSchema>;
export type SendRemindersInput = z.infer<typeof s.SendRemindersInputSchema>;
export type SendReminderResult = z.infer<typeof s.SendReminderResultSchema>;
export type SendRemindersResponse = z.infer<typeof s.SendRemindersResponseSchema>;

// Reports
export type Report = z.infer<typeof s.ReportSchema>;
export type ReportListResponse = z.infer<typeof s.ReportListResponseSchema>;
export type ReportDetailResponse = z.infer<typeof s.ReportDetailResponseSchema>;
export type ReportMaturity = z.infer<typeof s.ReportMaturitySchema>;
export type ReportFilter = z.infer<typeof s.ReportFilterSchema>;
export type ReportTypeInfo = z.infer<typeof s.ReportTypeInfoSchema>;
export type ReportLibraryResponse = z.infer<typeof s.ReportLibraryResponseSchema>;
export type GenerateReportInput = z.infer<typeof s.GenerateReportInputSchema>;
export type EmailReportInput = z.infer<typeof s.EmailReportInputSchema>;

// Insights
export type Insight = z.infer<typeof s.InsightSchema>;
export type InsightListResponse = z.infer<typeof s.InsightListResponseSchema>;

// Dashboard
export type DashboardKpisResponse = z.infer<typeof s.DashboardKpisResponseSchema>;
export type IncomeExpensePoint = z.infer<typeof s.IncomeExpensePointSchema>;
export type IncomeExpenseSeriesResponse = z.infer<typeof s.IncomeExpenseSeriesResponseSchema>;
export type ExpenseBreakdownSlice = z.infer<typeof s.ExpenseBreakdownSliceSchema>;
export type ExpenseBreakdownResponse = z.infer<typeof s.ExpenseBreakdownResponseSchema>;
export type PropertyNoi = z.infer<typeof s.PropertyNoiSchema>;
export type PropertyNoiResponse = z.infer<typeof s.PropertyNoiResponseSchema>;
export type ActivityKind = z.infer<typeof s.ActivityKindSchema>;
export type ActivityItem = z.infer<typeof s.ActivityItemSchema>;
export type ActivityListResponse = z.infer<typeof s.ActivityListResponseSchema>;
export type DashboardInsightResponse = z.infer<typeof s.DashboardInsightResponseSchema>;

// Integrations
export type Integration = z.infer<typeof s.IntegrationSchema>;
export type IntegrationListResponse = z.infer<typeof s.IntegrationListResponseSchema>;
export type LinkTokenResponse = z.infer<typeof s.LinkTokenResponseSchema>;
export type ExchangePublicTokenInput = z.infer<typeof s.ExchangePublicTokenInputSchema>;

// Documents
export type Document = z.infer<typeof s.DocumentSchema>;
export type CreateDocumentFields = z.infer<typeof s.CreateDocumentFieldsSchema>;
export type UpdateDocumentInput = z.infer<typeof s.UpdateDocumentInputSchema>;
export type DocumentListQuery = z.infer<typeof s.DocumentListQuerySchema>;
export type DocumentListRow = z.infer<typeof s.DocumentListRowSchema>;
export type DocumentListResponse = z.infer<typeof s.DocumentListResponseSchema>;

// Chat content blocks
export type ColorRole = z.infer<typeof s.ColorRoleSchema>;
export type TextBlock = z.infer<typeof s.TextBlockSchema>;
export type ChartPoint = z.infer<typeof s.ChartPointSchema>;
export type ChartSeries = z.infer<typeof s.ChartSeriesSchema>;
export type ChartBlock = z.infer<typeof s.ChartBlockSchema>;
export type DataTableColumn = z.infer<typeof s.DataTableColumnSchema>;
export type DataTableBlock = z.infer<typeof s.DataTableBlockSchema>;
export type ApiCallAction = z.infer<typeof s.ApiCallActionSchema>;
export type NavigateAction = z.infer<typeof s.NavigateActionSchema>;
export type ActionCardAction = z.infer<typeof s.ActionCardActionSchema>;
export type ActionCardBlock = z.infer<typeof s.ActionCardBlockSchema>;
export type AskUserQuestionOption = z.infer<typeof s.AskUserQuestionOptionSchema>;
export type AskUserQuestionBlock = z.infer<typeof s.AskUserQuestionBlockSchema>;
export type ContentBlock = z.infer<typeof s.ContentBlockSchema>;
export type ContentBlockType = z.infer<typeof s.ContentBlockTypeSchema>;
export type AskUserQuestionAnswer = z.infer<typeof s.AskUserQuestionAnswerSchema>;

// Chat sessions/messages + SSE payloads
export type ChatSession = z.infer<typeof s.ChatSessionSchema>;
export type ChatSessionListResponse = z.infer<typeof s.ChatSessionListResponseSchema>;
export type ChatMessage = z.infer<typeof s.ChatMessageSchema>;
export type ChatMessageListResponse = z.infer<typeof s.ChatMessageListResponseSchema>;
export type CreateChatSessionInput = z.infer<typeof s.CreateChatSessionInputSchema>;
export type SendChatMessageInput = z.infer<typeof s.SendChatMessageInputSchema>;
export type SseMessageStart = z.infer<typeof s.SseMessageStartSchema>;
export type SseBlockStart = z.infer<typeof s.SseBlockStartSchema>;
export type SseTextDelta = z.infer<typeof s.SseTextDeltaSchema>;
export type SseBlockComplete = z.infer<typeof s.SseBlockCompleteSchema>;
export type SseToolActivity = z.infer<typeof s.SseToolActivitySchema>;
export type SseAwaitingInput = z.infer<typeof s.SseAwaitingInputSchema>;
export type SseMessageComplete = z.infer<typeof s.SseMessageCompleteSchema>;
export type SseError = z.infer<typeof s.SseErrorSchema>;
