// TanStack Query hooks — one per ARCHITECTURE §3 endpoint the web app
// consumes. All shapes come from @hearth/shared; nothing is redeclared here.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AcceptRenewalInput,
  AccountSettings,
  ActivityItem,
  AddLeaseTenantInput,
  Category,
  ConfirmTransactionInput,
  CreateLeaseInput,
  CreatePropertyInput,
  CreateTenantInput,
  CreateTransactionInput,
  CreateUnitInput,
  DashboardInsightResponse,
  DashboardKpisResponse,
  EsignEnvelopeResponse,
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
  Property,
  PropertyDetailResponse,
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
  ReviewQueueResponse,
  SendRemindersInput,
  SendRemindersResponse,
  Tenant,
  TenantDetailResponse,
  TenantListRow,
  Transaction,
  TransactionListResponse,
  TransactionStatus,
  TransactionType,
  Unit,
  UpdateAccountSettingsInput,
  UpdateLeaseInput,
  UpdatePropertyInput,
  UpdateTenantInput,
  UpdateUnitInput,
} from '@hearth/shared';
import { api, toQuery } from './client';

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

export function useActivity(limit = 10) {
  return useQuery({
    queryKey: ['dashboard', 'activity', limit],
    queryFn: () => api.get<ActivityItem[]>(`/dashboard/activity${toQuery({ limit })}`),
    staleTime: STALE_SHORT,
  });
}

export function useDashboardInsight() {
  return useQuery({
    queryKey: ['dashboard', 'insight'],
    queryFn: () => api.get<DashboardInsightResponse>('/dashboard/insight'),
    staleTime: STALE_SHORT,
  });
}

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
    onSuccess: (_data, { propertyId }) => invalidateProperty(qc, propertyId),
  });
}

export function useArchiveUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; propertyId: string }) => api.delete(`/units/${id}`),
    onSuccess: (_data, { propertyId }) => invalidateProperty(qc, propertyId),
  });
}

export function useRestoreUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; propertyId: string }) =>
      api.post<Unit>(`/units/${id}/restore`),
    onSuccess: (_data, { propertyId }) => invalidateProperty(qc, propertyId),
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
  void qc.invalidateQueries({ queryKey: ['rent'] });
  void qc.invalidateQueries({ queryKey: ['dashboard'] });
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
    },
  });
}

// ------------------------------------------------------------- transactions

export interface TransactionFilters {
  propertyId?: string;
  type?: TransactionType;
  status?: TransactionStatus;
  categoryId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export function useTransactions(filters: TransactionFilters = {}) {
  return useQuery({
    queryKey: ['transactions', 'list', filters],
    queryFn: () =>
      api.get<TransactionListResponse>(
        `/transactions${toQuery({ limit: 100, ...filters })}`,
      ),
    staleTime: STALE_SHORT,
  });
}

export function useReviewQueue() {
  return useQuery({
    queryKey: ['transactions', 'review'],
    queryFn: () => api.get<ReviewQueueResponse>('/transactions/review'),
    staleTime: STALE_SHORT,
  });
}

function invalidateLedger(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['transactions'] });
  void qc.invalidateQueries({ queryKey: ['dashboard'] });
  void qc.invalidateQueries({ queryKey: ['properties'] });
}

export function useCreateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTransactionInput) => api.post<Transaction>('/transactions', input),
    onSuccess: () => invalidateLedger(qc),
  });
}

export function useConfirmTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: ConfirmTransactionInput & { id: string }) =>
      api.post<Transaction>(`/transactions/${id}/confirm`, input),
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
      void qc.invalidateQueries({ queryKey: ['transactions'] });
    },
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
      void qc.invalidateQueries({ queryKey: ['monthly-reviews'] });
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
      void qc.invalidateQueries({ queryKey: ['dashboard', 'insight'] });
      void qc.invalidateQueries({ queryKey: ['properties'] });
      void qc.invalidateQueries({ queryKey: ['tenants'] });
    },
  });
}

export function useMonthlyReviews() {
  return useQuery({
    queryKey: ['monthly-reviews'],
    queryFn: () => api.get<Report[]>('/insights/monthly-reviews'),
    staleTime: STALE_SHORT,
  });
}

export function useMonthlyReviewDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['monthly-reviews', id],
    queryFn: () => api.get<ReportDetailResponse>(`/insights/monthly-reviews/${id}`),
    enabled: Boolean(id),
    staleTime: STALE_LONG,
  });
}

export function useGenerateMonthlyReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<Report>('/insights/monthly-reviews/generate'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['monthly-reviews'] });
      void qc.invalidateQueries({ queryKey: ['insights'] });
      void qc.invalidateQueries({ queryKey: ['reports'] });
    },
  });
}

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

export function useIntegrations() {
  return useQuery({
    queryKey: ['integrations'],
    queryFn: () => api.get<Integration[]>('/integrations'),
    staleTime: STALE_SHORT,
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
