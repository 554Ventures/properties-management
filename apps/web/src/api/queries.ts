// TanStack Query hooks — one per ARCHITECTURE §3 endpoint the web app
// consumes. All shapes come from @hearth/shared; nothing is redeclared here.
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  AcceptRenewalInput,
  AccountSettings,
  ActivityItem,
  AddLeaseTenantInput,
  Category,
  ConfirmAllReviewResponse,
  ConfirmTransactionInput,
  Contractor,
  ContractorDetailResponse,
  ContractorListRow,
  CreateContractorInput,
  CreateLeaseInput,
  CreatePropertyInput,
  CreateTenantInput,
  CreateTransactionInput,
  CreateTransactionResponse,
  CreateUnitInput,
  DashboardKpisResponse,
  DismissAllReviewResponse,
  Document,
  DocumentListQuery,
  DocumentListResponse,
  EsignEnvelopeResponse,
  ExpenseBreakdownResponse,
  GenerateReportInput,
  ImportTransactionsResponse,
  IncomeExpenseSeriesResponse,
  Insight,
  InsightScope,
  InsightStatus,
  Integration,
  IntegrationType,
  Lease,
  LeaseDetailResponse,
  LeaseWithContext,
  LinkTokenResponse,
  LogContractorJobInput,
  LogContractorJobResponse,
  OnboardingState,
  Property,
  PropertyDetailResponse,
  PushDevice,
  PropertyNoiResponse,
  PropertyWithStats,
  ReceiptScanResponse,
  RecordRentPaymentInput,
  RentPayment,
  RentTrackerResponse,
  RenewalDraftResponse,
  Report,
  ReportDetailResponse,
  ReportType,
  ReportTypeInfo,
  ReviewQueueFilter,
  ReviewQueueResponse,
  SendRemindersInput,
  SendRemindersResponse,
  Tenant,
  TenantDetailResponse,
  TenantListRow,
  Transaction,
  TransactionListQuery,
  TransactionListResponse,
  Unit,
  UnitDetailResponse,
  UpdateAccountSettingsInput,
  UpdateContractorInput,
  UpdateDocumentInput,
  UpdateLeaseInput,
  UpdateOnboardingInput,
  UpdatePropertyInput,
  UpdateTenantInput,
  UpdateTransactionInput,
  UpdateUnitInput,
} from '@hearth/shared';
import { api, toQuery } from './client';

export type {
  Contractor,
  ContractorDetailResponse,
  ContractorListRow,
  CreateContractorInput,
  UpdateContractorInput,
};

const STALE_SHORT = 30_000; // live financial data
const STALE_LONG = 5 * 60_000; // near-static reference data

// ---------------------------------------------------------------- dashboard

export function useDashboardKpis() {
  return useQuery({
    queryKey: ['dashboard', 'kpis'],
    queryFn: () => api.get<DashboardKpisResponse>('/dashboard/kpis'),
    staleTime: STALE_SHORT,
  });
}

export function useCashflowSeries(months = 6) {
  return useQuery({
    queryKey: ['dashboard', 'cashflow-series', months],
    queryFn: () =>
      api.get<IncomeExpenseSeriesResponse>(`/dashboard/cashflow-series${toQuery({ months })}`),
    staleTime: STALE_SHORT,
  });
}

export function useExpenseBreakdown() {
  return useQuery({
    queryKey: ['dashboard', 'expense-breakdown'],
    queryFn: () => api.get<ExpenseBreakdownResponse>('/dashboard/expense-breakdown'),
    staleTime: STALE_SHORT,
  });
}

export function useNoiByProperty() {
  return useQuery({
    queryKey: ['dashboard', 'noi-by-property'],
    queryFn: () => api.get<PropertyNoiResponse>('/dashboard/noi-by-property'),
    staleTime: STALE_SHORT,
  });
}

export function useActivity(limit = 10) {
  return useQuery({
    queryKey: ['dashboard', 'activity', limit],
    queryFn: () => api.get<ActivityItem[]>(`/dashboard/activity${toQuery({ limit })}`),
    staleTime: STALE_SHORT,
  });
}

// The dashboard renders its insight deck from useInsights({ status:
// 'active' }); the single-card GET /dashboard/insight endpoint still exists
// for contract stability but the web app no longer consumes it.

// --------------------------------------------------------------- properties

export function useProperties() {
  return useQuery({
    queryKey: ['properties'],
    queryFn: () => api.get<PropertyWithStats[]>('/properties'),
    staleTime: STALE_SHORT,
  });
}

export function usePropertyDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['properties', id],
    queryFn: () => api.get<PropertyDetailResponse>(`/properties/${id}`),
    enabled: Boolean(id),
    staleTime: STALE_SHORT,
  });
}

function invalidateProperty(qc: ReturnType<typeof useQueryClient>, id?: string) {
  void qc.invalidateQueries({ queryKey: ['properties'] });
  if (id) void qc.invalidateQueries({ queryKey: ['properties', id] });
  void qc.invalidateQueries({ queryKey: ['dashboard'] });
  // Onboarding step completion derives from portfolio data, so entity writes
  // (here and in the tenant/lease/ledger helpers) refresh the checklist.
  void qc.invalidateQueries({ queryKey: ['onboarding'] });
}

export function useCreateProperty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePropertyInput) => api.post<Property>('/properties', input),
    onSuccess: () => invalidateProperty(qc),
  });
}

export function useUpdateProperty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdatePropertyInput & { id: string }) =>
      api.patch<Property>(`/properties/${id}`, input),
    onSuccess: (_data, { id }) => invalidateProperty(qc, id),
  });
}

export function useArchiveProperty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/properties/${id}`),
    onSuccess: (_data, id) => invalidateProperty(qc, id),
  });
}

export function useRestoreProperty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Property>(`/properties/${id}/restore`),
    onSuccess: (_data, id) => invalidateProperty(qc, id),
  });
}

// -------------------------------------------------------------------- units

export function useUnitDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['units', id],
    queryFn: () => api.get<UnitDetailResponse>(`/units/${id}`),
    enabled: Boolean(id),
    staleTime: STALE_SHORT,
  });
}

// A unit write ripples through its property (occupancy) and the unit's own
// detail page.
function invalidateUnit(qc: ReturnType<typeof useQueryClient>, id: string, propertyId: string) {
  invalidateProperty(qc, propertyId);
  void qc.invalidateQueries({ queryKey: ['units', id] });
}

export function useCreateUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ propertyId, ...input }: CreateUnitInput & { propertyId: string }) =>
      api.post<Unit>(`/properties/${propertyId}/units`, input),
    onSuccess: (_data, { propertyId }) => invalidateProperty(qc, propertyId),
  });
}

export function useUpdateUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, propertyId: _propertyId, ...input }: UpdateUnitInput & { id: string; propertyId: string }) =>
      api.patch<Unit>(`/units/${id}`, input),
    onSuccess: (_data, { id, propertyId }) => invalidateUnit(qc, id, propertyId),
  });
}

export function useArchiveUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; propertyId: string }) => api.delete(`/units/${id}`),
    onSuccess: (_data, { id, propertyId }) => invalidateUnit(qc, id, propertyId),
  });
}

export function useRestoreUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; propertyId: string }) =>
      api.post<Unit>(`/units/${id}/restore`),
    onSuccess: (_data, { id, propertyId }) => invalidateUnit(qc, id, propertyId),
  });
}

// ------------------------------------------------------------------ tenants

export function useTenants() {
  return useQuery({
    queryKey: ['tenants'],
    queryFn: () => api.get<TenantListRow[]>('/tenants'),
    staleTime: STALE_SHORT,
  });
}

export function useTenantDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['tenants', id],
    queryFn: () => api.get<TenantDetailResponse>(`/tenants/${id}`),
    enabled: Boolean(id),
    staleTime: STALE_SHORT,
  });
}

function invalidateTenant(qc: ReturnType<typeof useQueryClient>, id?: string) {
  void qc.invalidateQueries({ queryKey: ['tenants'] });
  if (id) void qc.invalidateQueries({ queryKey: ['tenants', id] });
  void qc.invalidateQueries({ queryKey: ['onboarding'] });
}

export function useCreateTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTenantInput) => api.post<Tenant>('/tenants', input),
    onSuccess: () => invalidateTenant(qc),
  });
}

export function useUpdateTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateTenantInput & { id: string }) =>
      api.patch<Tenant>(`/tenants/${id}`, input),
    onSuccess: (_data, { id }) => invalidateTenant(qc, id),
  });
}

export function useArchiveTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/tenants/${id}`),
    onSuccess: (_data, id) => invalidateTenant(qc, id),
  });
}

export function useRestoreTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Tenant>(`/tenants/${id}/restore`),
    onSuccess: (_data, id) => invalidateTenant(qc, id),
  });
}

// -------------------------------------------------------------- contractors

export function useContractors() {
  return useQuery({
    queryKey: ['contractors'],
    queryFn: () => api.get<ContractorListRow[]>('/contractors'),
    staleTime: STALE_SHORT,
  });
}

export function useContractor(id: string | undefined) {
  return useQuery({
    queryKey: ['contractors', id],
    queryFn: () => api.get<ContractorDetailResponse>(`/contractors/${id}`),
    enabled: Boolean(id),
    staleTime: STALE_SHORT,
  });
}

function invalidateContractors(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['contractors'] });
}

export function useCreateContractor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateContractorInput) => api.post<Contractor>('/contractors', input),
    onSuccess: () => invalidateContractors(qc),
  });
}

export function useUpdateContractor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateContractorInput & { id: string }) =>
      api.patch<Contractor>(`/contractors/${id}`, input),
    onSuccess: () => invalidateContractors(qc),
  });
}

export function useArchiveContractor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/contractors/${id}`),
    onSuccess: () => invalidateContractors(qc),
  });
}

// POST /contractors/:id/restore exists on the API for parity with tenants,
// but no UI surface exposes archived contractors yet — add a restore hook
// alongside that surface when it lands.

// POST /contractors/:id/jobs — logs a manual job as a real confirmed expense
// transaction. A `possible_duplicate` response created nothing server-side
// (it's an advisory candidate list, mirroring the review queue's rent-match
// suggestion), so only invalidate contractor data when the job was actually
// `created`.
export function useLogContractorJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ contractorId, ...input }: LogContractorJobInput & { contractorId: string }) =>
      api.post<LogContractorJobResponse>(`/contractors/${contractorId}/jobs`, input),
    onSuccess: (response) => {
      // A created job is a real expense transaction, not just a contractor
      // stat — refresh the surfaces that show it too.
      if (response.status === 'created') {
        invalidateContractors(qc);
        void qc.invalidateQueries({ queryKey: ['transactions'] });
        void qc.invalidateQueries({ queryKey: ['dashboard'] });
      }
    },
  });
}

// ------------------------------------------------------------------- leases

export function useLeaseDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['leases', id],
    queryFn: () => api.get<LeaseDetailResponse>(`/leases/${id}`),
    enabled: Boolean(id),
    staleTime: STALE_SHORT,
  });
}

// Lease writes ripple through occupancy (properties), tenant status (tenants),
// the rent schedule (rent), and the dashboard KPIs.
function invalidateLease(qc: ReturnType<typeof useQueryClient>, leaseId?: string) {
  void qc.invalidateQueries({ queryKey: ['properties'] });
  void qc.invalidateQueries({ queryKey: ['tenants'] });
  void qc.invalidateQueries({ queryKey: ['units'] });
  void qc.invalidateQueries({ queryKey: ['rent'] });
  void qc.invalidateQueries({ queryKey: ['dashboard'] });
  void qc.invalidateQueries({ queryKey: ['onboarding'] });
  if (leaseId) void qc.invalidateQueries({ queryKey: ['leases', leaseId] });
}

export function useCreateLease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLeaseInput) => api.post<Lease>('/leases', input),
    onSuccess: () => invalidateLease(qc),
  });
}

export function useUpdateLease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateLeaseInput & { id: string }) =>
      api.patch<Lease>(`/leases/${id}`, input),
    onSuccess: (_data, { id }) => invalidateLease(qc, id),
  });
}

export function useTerminateLease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Lease>(`/leases/${id}/terminate`),
    onSuccess: (_data, id) => invalidateLease(qc, id),
  });
}

export function useAddLeaseTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ leaseId, ...input }: AddLeaseTenantInput & { leaseId: string }) =>
      api.post<LeaseWithContext>(`/leases/${leaseId}/tenants`, input),
    onSuccess: (_data, { leaseId }) => invalidateLease(qc, leaseId),
  });
}

export function useRemoveLeaseTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ leaseId, tenantId }: { leaseId: string; tenantId: string }) =>
      api.delete(`/leases/${leaseId}/tenants/${tenantId}`),
    onSuccess: (_data, { leaseId }) => invalidateLease(qc, leaseId),
  });
}

export function useCreateRenewal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ leaseId, ...input }: AcceptRenewalInput & { leaseId: string }) =>
      api.post<Lease>(`/leases/${leaseId}/renewal`, input),
    onSuccess: (_data, { leaseId }) => invalidateLease(qc, leaseId),
  });
}

export function useDraftRenewal() {
  return useMutation({
    mutationFn: (leaseId: string) =>
      api.post<RenewalDraftResponse>(`/leases/${leaseId}/renewal-draft`),
  });
}

export function useSendEsign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (leaseId: string) => api.post<EsignEnvelopeResponse>(`/leases/${leaseId}/esign`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenants'] });
      void qc.invalidateQueries({ queryKey: ['properties'] });
      void qc.invalidateQueries({ queryKey: ['units'] });
    },
  });
}

// ------------------------------------------------------------- transactions

export function useTransactions(query: TransactionListQuery = {}) {
  return useQuery({
    queryKey: ['transactions', 'list', query],
    queryFn: () =>
      api.get<TransactionListResponse>(
        `/transactions${toQuery(query as Record<string, string | number | undefined>)}`,
      ),
    staleTime: STALE_SHORT,
    // Keep the current page visible while the next server page loads so paging
    // and filtering don't flash an empty table.
    placeholderData: keepPreviousData,
  });
}

/**
 * Cursor-paged review queue. `data.pages[0].total` is the full filtered count
 * (all pages); fetchNextPage loads the next cursor page.
 */
export function useReviewQueue(filters: ReviewQueueFilter = {}) {
  return useInfiniteQuery({
    queryKey: ['transactions', 'review', filters],
    queryFn: ({ pageParam }) =>
      api.get<ReviewQueueResponse>(`/transactions/review${toQuery({ ...filters, cursor: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: STALE_SHORT,
  });
}

function invalidateLedger(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['transactions'] });
  void qc.invalidateQueries({ queryKey: ['dashboard'] });
  void qc.invalidateQueries({ queryKey: ['properties'] });
  void qc.invalidateQueries({ queryKey: ['onboarding'] });
}

export function useCreateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTransactionInput) =>
      api.post<CreateTransactionResponse>('/transactions', input),
    onSuccess: () => invalidateLedger(qc),
  });
}

export function useConfirmTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: ConfirmTransactionInput & { id: string }) =>
      api.post<Transaction>(`/transactions/${id}/confirm`, input),
    onSuccess: () => {
      // Confirming with a rentPaymentId flips a RentPayment to paid, so the
      // tracker and tenant payment history change alongside the ledger.
      invalidateLedger(qc);
      void qc.invalidateQueries({ queryKey: ['rent'] });
      void qc.invalidateQueries({ queryKey: ['tenants'] });
    },
  });
}

/** POST /transactions/:id/dismiss — deny a pending item; it never hits reports. */
export function useDismissTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Transaction>(`/transactions/${id}/dismiss`, {}),
    onSuccess: () => invalidateLedger(qc),
  });
}

/** Bulk-confirm the filtered queue (AI suggestions only; rent matches skipped). */
export function useConfirmAllReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (filters: ReviewQueueFilter) =>
      api.post<ConfirmAllReviewResponse>('/transactions/review/confirm-all', filters),
    onSuccess: () => invalidateLedger(qc),
  });
}

/** Bulk-dismiss the filtered queue. */
export function useDismissAllReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (filters: ReviewQueueFilter) =>
      api.post<DismissAllReviewResponse>('/transactions/review/dismiss-all', filters),
    onSuccess: () => invalidateLedger(qc),
  });
}

export function useUpdateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateTransactionInput & { id: string }) =>
      api.patch<Transaction>(`/transactions/${id}`, input),
    onSuccess: () => invalidateLedger(qc),
  });
}

/** POST /transactions/receipt — pre-fills the form; never saves. */
export function useScanReceipt() {
  return useMutation({
    mutationFn: (form: FormData) => api.postForm<ReceiptScanResponse>('/transactions/receipt', form),
  });
}

export function useImportTransactions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<ImportTransactionsResponse>('/transactions/import'),
    onSuccess: () => {
      // Imports create/update/delete ledger rows and stamp the plaid
      // integration's lastSyncedAt.
      invalidateLedger(qc);
      void qc.invalidateQueries({ queryKey: ['integrations'] });
    },
  });
}

// ---------------------------------------------------------------- documents

export function useDocuments(query: DocumentListQuery = {}) {
  return useQuery({
    queryKey: ['documents', query],
    queryFn: () =>
      api.get<DocumentListResponse>(
        `/documents${toQuery(query as Record<string, string | number | undefined>)}`,
      ),
    staleTime: STALE_SHORT,
  });
}

function invalidateDocuments(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['documents'] });
}

/** POST /documents — multipart FormData: file + entityType/entityId/type/name?. */
export function useUploadDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (form: FormData) => api.postForm<Document>('/documents', form),
    onSuccess: (_doc, form) => {
      invalidateDocuments(qc);
      // A receipt upload sets the transaction's receiptUrl server-side.
      if (form.get('entityType') === 'transaction') {
        void qc.invalidateQueries({ queryKey: ['transactions'] });
      }
    },
  });
}

export function useUpdateDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateDocumentInput & { id: string }) =>
      api.patch<Document>(`/documents/${id}`, input),
    onSuccess: () => invalidateDocuments(qc),
  });
}

export function useDeleteDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/documents/${id}`),
    onSuccess: () => invalidateDocuments(qc),
  });
}

// --------------------------------------------------------------- categories

export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<Category[]>('/categories'),
    staleTime: STALE_LONG,
  });
}

// --------------------------------------------------------------------- rent

export function useRentTracker(period: string) {
  return useQuery({
    queryKey: ['rent', 'tracker', period],
    queryFn: () => api.get<RentTrackerResponse>(`/rent/tracker${toQuery({ period })}`),
    staleTime: STALE_SHORT,
  });
}

export function useRecordPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RecordRentPaymentInput) => api.post<RentPayment>('/rent/payments', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rent'] });
      void qc.invalidateQueries({ queryKey: ['tenants'] });
      invalidateLedger(qc);
    },
  });
}

export function useSendReminders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SendRemindersInput) =>
      api.post<SendRemindersResponse>('/rent/reminders', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rent'] });
      void qc.invalidateQueries({ queryKey: ['tenants'] });
      void qc.invalidateQueries({ queryKey: ['dashboard', 'activity'] });
    },
  });
}

// ------------------------------------------------------------------ reports

export function useReportsLibrary() {
  return useQuery({
    queryKey: ['reports', 'library'],
    queryFn: () => api.get<ReportTypeInfo[]>('/reports/library'),
    staleTime: STALE_LONG,
  });
}

export function useReports(filters: { type?: ReportType; taxYear?: number } = {}) {
  return useQuery({
    queryKey: ['reports', 'list', filters],
    queryFn: () => api.get<Report[]>(`/reports${toQuery(filters)}`),
    staleTime: STALE_SHORT,
  });
}

export function useReportDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['reports', 'detail', id],
    queryFn: () => api.get<ReportDetailResponse>(`/reports/${id}`),
    enabled: Boolean(id),
    staleTime: STALE_LONG, // reports are snapshots — they never change
  });
}

export function useGenerateReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: GenerateReportInput) => api.post<Report>('/reports/generate', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reports'] });
    },
  });
}

export function useEmailReport() {
  return useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) =>
      api.post<void>(`/reports/${id}/email`, { to }),
  });
}

// ----------------------------------------------------------------- insights

export function useInsights(filters: { status?: InsightStatus; scope?: InsightScope } = {}) {
  return useQuery({
    queryKey: ['insights', filters],
    queryFn: () => api.get<Insight[]>(`/insights${toQuery(filters)}`),
    staleTime: STALE_SHORT,
  });
}

export function useDismissInsight() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Insight>(`/insights/${id}/dismiss`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['insights'] });
      void qc.invalidateQueries({ queryKey: ['properties'] });
      void qc.invalidateQueries({ queryKey: ['tenants'] });
    },
  });
}

/** Records that the user executed the insight's suggested action (the server
 *  audits it as ai_suggested_user_confirmed). Same invalidations as dismiss —
 *  the card leaves every active list. */
export function useMarkInsightActioned() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Insight>(`/insights/${id}/actioned`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['insights'] });
      void qc.invalidateQueries({ queryKey: ['properties'] });
      void qc.invalidateQueries({ queryKey: ['tenants'] });
    },
  });
}

// Monthly reviews are plain Report rows — they list, view, and generate
// through the /reports hooks above (the dedicated /insights/monthly-reviews
// API routes still exist for contract stability, but the web app no longer
// needs them since the standalone AI Insights page was retired).

// ------------------------------------------------------ settings/integrations

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<AccountSettings>('/settings/account'),
    staleTime: STALE_LONG,
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAccountSettingsInput) =>
      api.patch<AccountSettings>('/settings/account', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] }); // tax rate affects set-aside
    },
  });
}

// --------------------------------------------------------------- onboarding

export function useOnboarding() {
  return useQuery({
    queryKey: ['onboarding'],
    queryFn: () => api.get<OnboardingState>('/onboarding'),
    staleTime: STALE_SHORT,
  });
}

export function useUpdateOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateOnboardingInput) =>
      api.patch<OnboardingState>('/onboarding', input),
    onSuccess: (state) => {
      qc.setQueryData(['onboarding'], state);
    },
  });
}

export function useIntegrations() {
  return useQuery({
    queryKey: ['integrations'],
    queryFn: () => api.get<Integration[]>('/integrations'),
    staleTime: STALE_SHORT,
  });
}

/** Registered push devices — fetched only in the iOS shell (Settings card). */
export function usePushDevices(enabled = true) {
  return useQuery({
    queryKey: ['devices'],
    queryFn: () => api.get<PushDevice[]>('/devices'),
    staleTime: STALE_SHORT,
    enabled,
  });
}

export function useConnectIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (type: IntegrationType) => api.post<Integration>(`/integrations/${type}/connect`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['integrations'] });
    },
  });
}

export function useDisconnectIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/integrations/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['integrations'] });
    },
  });
}

export function useCreatePlaidLinkToken() {
  return useMutation({
    mutationFn: () => api.post<LinkTokenResponse>('/integrations/plaid/link-token'),
  });
}

export function useExchangePlaidPublicToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (publicToken: string) =>
      api.post<Integration>('/integrations/plaid/exchange', { publicToken }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['integrations'] });
    },
  });
}
