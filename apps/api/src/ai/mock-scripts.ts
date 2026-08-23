// Ordered regex scripts for the MockAiClient (ARCHITECTURE §6, binding).
// Scripts are generator-style: each step is invoked on the n-th model call of
// the current turn and can read the tool results the loop produced for the
// previous step — so every figure comes from the live seeded DB and the
// pause/resume path is exercised exactly like the real provider.
import {
  formatUsdWhole,
  type DashboardKpisResponse,
  type IncomeExpenseSeriesResponse,
  type PropertyDetailResponse,
  type PropertyListResponse,
  type Report,
  type ReportDetailResponse,
  type RentTrackerResponse,
  type WorkOrderListRow,
} from '@hearth/shared';
import type { ProviderEvent } from './client';

export interface MockAnswer {
  selected: string[];
  freeText?: string;
}

export interface MockStepContext {
  userText: string;
  /** Most recent parsed tool_result for a tool name (undefined if not called). */
  result: (toolName: string) => unknown;
  /** Parsed ask_user_question tool_result, when the turn was resumed. */
  answer: MockAnswer | null;
}

export type MockStep = (ctx: MockStepContext) => ProviderEvent[];

export interface MockScript {
  pattern: RegExp;
  steps: MockStep[];
}

/** Stream text in ~3-word deltas — byte-identical across runs. */
export function textDeltas(text: string): ProviderEvent[] {
  const words = text.split(' ');
  const out: ProviderEvent[] = [];
  for (let i = 0; i < words.length; i += 3) {
    const chunk = words.slice(i, i + 3).join(' ');
    out.push({ type: 'text_delta', text: i === 0 ? chunk : ` ${chunk}` });
  }
  return out;
}

const toolUse = (id: string, name: string, input: unknown): ProviderEvent => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const stopToolUse: ProviderEvent = { type: 'stop', reason: 'tool_use' };
const stopEndTurn: ProviderEvent = { type: 'stop', reason: 'end_turn' };

// ── script 1: cash flow — the chart script ────────────────────────────────────

const cashflowScript: MockScript = {
  pattern: /cash ?flow|how.*(doing|going)|this month/i,
  steps: [
    () => [
      toolUse('toolu_mock_kpis', 'get_dashboard_kpis', {}),
      toolUse('toolu_mock_series', 'get_income_expense_series', { months: 6 }),
      stopToolUse,
    ],
    (ctx) => {
      const kpis = ctx.result('get_dashboard_kpis') as DashboardKpisResponse;
      const series = ctx.result('get_income_expense_series') as IncomeExpenseSeriesResponse;
      const first = series[0];
      const last = series[series.length - 1];
      return [
        ...textDeltas(
          `Cash flow looks solid this month: you have netted ${formatUsdWhole(kpis.netCashFlowMtdCents)} so far, with ${kpis.paidUnits} of ${kpis.totalUnits} units paid (${kpis.rentCollectedPct}% collected) and ${formatUsdWhole(kpis.expensesMtdCents)} in expenses. Here is how income and expenses have tracked over the last six months.`,
        ),
        toolUse('toolu_mock_chart', 'render_chart', {
          type: 'chart',
          kind: 'line',
          title: 'Income vs. expenses — last 6 months',
          description: `Line chart comparing monthly income and expenses from ${first?.month} to ${last?.month}.`,
          yUnit: 'usd',
          series: [
            {
              label: 'Income',
              colorRole: 'positive',
              points: series.map((m) => ({ x: m.month, y: m.incomeCents })),
            },
            {
              label: 'Expenses',
              colorRole: 'warning',
              points: series.map((m) => ({ x: m.month, y: m.expenseCents })),
            },
          ],
        }),
        stopToolUse,
      ];
    },
    () => [stopEndTurn],
  ],
};

// ── script 2: taxes / schedule e — the scripted askUserQuestion flow ──────────

interface ScheduleEData {
  propertyRows: Array<{
    propertyLabel: string;
    rentsReceivedCents: number;
    expenseLines: Record<string, number>;
    totalExpensesCents: number;
    netCents: number;
  }>;
  totals: { rentsReceivedCents: number; totalExpensesCents: number; netCents: number };
}

function chosenTaxYear(answer: MockAnswer | null): number {
  // Deliberately UTC (WS4): a deterministic year label for the offline demo
  // script, not account-scoped period bucketing (mock scripts have no account
  // context; the report service still buckets the chosen year on account tz).
  const currentYear = new Date().getUTCFullYear();
  const picked = answer?.selected[0] ?? '';
  if (/year to date/i.test(picked)) return currentYear;
  if (/^\d{4}$/.test(picked)) return Number(picked);
  const fromFreeText = answer?.freeText?.match(/\d{4}/)?.[0];
  return fromFreeText ? Number(fromFreeText) : currentYear;
}

const taxScript: MockScript = {
  pattern: /tax(es)?|schedule e/i,
  steps: [
    () => {
      // Deliberately UTC (WS4): demo prompt label only — see chosenTaxYear.
      const year = new Date().getUTCFullYear();
      return [
        toolUse('toolu_mock_ask_year', 'ask_user_question', {
          type: 'ask_user_question',
          header: 'Tax prep',
          question: 'Which tax year should I pull together?',
          multiSelect: false,
          options: [
            {
              id: 'current_ytd',
              label: `${year} (year to date)`,
              description: `January 1 through today, ${year}`,
            },
            { id: 'last_year', label: `${year - 1}`, description: `The full ${year - 1} calendar year` },
            { id: 'other', label: 'Other', description: 'Tell me which year you need' },
          ],
        }),
        stopToolUse,
      ];
    },
    (ctx) => [
      toolUse('toolu_mock_gen_sched_e', 'generate_report', {
        type: 'schedule_e',
        taxYear: chosenTaxYear(ctx.answer),
      }),
      stopToolUse,
    ],
    (ctx) => {
      const report = ctx.result('generate_report') as Report;
      return [toolUse('toolu_mock_get_sched_e', 'get_report', { reportId: report.id }), stopToolUse];
    },
    (ctx) => {
      const report = ctx.result('generate_report') as Report;
      const detail = ctx.result('get_report') as ReportDetailResponse;
      const data = detail.data as ScheduleEData;
      const rows = data.propertyRows.map((r) => {
        const repairs = r.expenseLines['Line 14 – Repairs'] ?? 0;
        return {
          property: r.propertyLabel,
          rents: r.rentsReceivedCents,
          repairs,
          other: r.totalExpensesCents - repairs,
          net: r.netCents,
        };
      });
      return [
        ...textDeltas(
          `Your ${report.taxYear} Schedule E is ready: ${formatUsdWhole(data.totals.rentsReceivedCents)} in rents received against ${formatUsdWhole(data.totals.totalExpensesCents)} in expenses, netting ${formatUsdWhole(data.totals.netCents)}. Here is the per-property breakdown.`,
        ),
        toolUse('toolu_mock_sched_e_table', 'render_table', {
          type: 'data_table',
          title: `Schedule E ${report.taxYear} — per property`,
          columns: [
            { key: 'property', label: 'Property' },
            { key: 'rents', label: 'Rents received', align: 'right', format: 'usd' },
            { key: 'repairs', label: 'Repairs', align: 'right', format: 'usd' },
            { key: 'other', label: 'Other expenses', align: 'right', format: 'usd' },
            { key: 'net', label: 'Net', align: 'right', format: 'usd' },
          ],
          rows,
        }),
        toolUse('toolu_mock_sched_e_action', 'propose_action', {
          type: 'action_card',
          title: 'Open the full Schedule E',
          body: 'Review the line-level worksheet, then export it or email it to your accountant.',
          actions: [
            {
              id: 'open_schedule_e',
              label: 'Open report',
              style: 'primary',
              action: { kind: 'navigate', to: `/reports/${report.id}` },
            },
          ],
        }),
        stopToolUse,
      ];
    },
    () => [stopEndTurn],
  ],
};

// ── script 3: late rent ───────────────────────────────────────────────────────

const lateRentScript: MockScript = {
  pattern: /late|behind|owes?/i,
  steps: [
    () => [toolUse('toolu_mock_rent_status', 'get_rent_status', {}), stopToolUse],
    (ctx) => {
      const tracker = ctx.result('get_rent_status') as RentTrackerResponse;
      const late = tracker.rows
        .filter((r) => r.status === 'late')
        .sort((a, b) => (b.daysLate ?? 0) - (a.daysLate ?? 0));
      if (late.length === 0) {
        return [
          ...textDeltas(
            `Good news — nobody is behind on rent for ${tracker.period}. ${formatUsdWhole(tracker.collectedCents)} collected across ${tracker.paidUnits} of ${tracker.totalUnits} units.`,
          ),
          stopEndTurn,
        ];
      }
      const most = late[0]!;
      const summary = late
        .map((r) => `${r.tenantName} (${r.daysLate} days late, ${formatUsdWhole(r.amountCents)})`)
        .join(' and ');
      const actions = [
        {
          id: 'remind_most_late',
          label: `Send reminder to ${most.tenantName}`,
          style: 'primary',
          action: {
            kind: 'api_call',
            method: 'POST',
            path: '/rent/reminders',
            body: { rentPaymentIds: [most.rentPaymentId] },
          },
        },
        ...(late.length > 1
          ? [
              {
                id: 'remind_all_late',
                label: 'Remind all late tenants',
                style: 'secondary',
                action: {
                  kind: 'api_call',
                  method: 'POST',
                  path: '/rent/reminders',
                  body: { rentPaymentIds: late.map((r) => r.rentPaymentId) },
                },
              },
            ]
          : []),
      ];
      return [
        ...textDeltas(
          `${late.length === 1 ? 'One tenant is' : `${late.length} tenants are`} behind on rent for ${tracker.period}: ${summary}. That is ${formatUsdWhole(tracker.outstandingCents)} outstanding.`,
        ),
        toolUse('toolu_mock_late_table', 'render_table', {
          type: 'data_table',
          title: `Late rent — ${tracker.period}`,
          columns: [
            { key: 'tenant', label: 'Tenant' },
            { key: 'unit', label: 'Property / unit' },
            { key: 'amount', label: 'Amount', align: 'right', format: 'usd' },
            { key: 'dueDate', label: 'Due date', format: 'date' },
            { key: 'late', label: 'Status' },
          ],
          rows: late.map((r) => ({
            tenant: r.tenantName,
            unit: `${r.propertyLabel} ${r.unitLabel}`,
            amount: r.amountCents,
            dueDate: r.dueDate,
            late: `${r.daysLate} days late`,
          })),
        }),
        toolUse('toolu_mock_late_action', 'propose_action', {
          type: 'action_card',
          title: 'Send rent reminders',
          body: "Sends the reminder email to the tenant — or opens it in your mail app when email sending isn't set up.",
          actions,
        }),
        stopToolUse,
      ];
    },
    () => [stopEndTurn],
  ],
};

// ── script 4: financing / equity — real get_property call (PLAN-REAL-EQUITY §4)

const equityScript: MockScript = {
  pattern: /equity|worth|mortgage/i,
  steps: [
    () => [toolUse('toolu_mock_equity_list', 'list_properties', {}), stopToolUse],
    (ctx) => {
      const properties = ctx.result('list_properties') as PropertyListResponse;
      const first = properties[0];
      if (!first) {
        return [...textDeltas('You do not have any properties on file yet.'), stopEndTurn];
      }
      return [
        toolUse('toolu_mock_equity_detail', 'get_property', { propertyId: first.id }),
        stopToolUse,
      ];
    },
    (ctx) => {
      const detail = ctx.result('get_property') as PropertyDetailResponse | undefined;
      if (!detail) return [stopEndTurn];
      const { property, mortgages, latestValuation, equity } = detail;
      const label = property.nickname ?? property.addressLine1;
      // `mortgages[]` includes archived (paid-off) rows so the hub can restore
      // them; they are not owed, and the equity figure below already excludes
      // them — summing them here would contradict it in the same breath.
      const owed = (mortgages ?? []).filter((m) => m.archivedAt === null);
      const mortgageSummary =
        owed.length > 0
          ? owed.map((m) => `${m.lender} at ${formatUsdWhole(m.currentBalanceCents)}`).join(' and ')
          : 'no mortgages on file';
      const valuationSummary = latestValuation
        ? `an owner-provided valuation of ${formatUsdWhole(latestValuation.valueCents)} as of ${latestValuation.asOfDate.slice(0, 10)}`
        : property.acquisitionCostCents != null
          ? `no valuation on file, so value is estimated at cost (${formatUsdWhole(property.acquisitionCostCents)})`
          : 'no valuation or acquisition cost on file';
      const equitySummary = equity
        ? `Estimated equity is ${formatUsdWhole(equity.equityCents)} — ${formatUsdWhole(equity.assetValueCents)} in value (${equity.assetBasis === 'valuation' ? 'from your latest valuation' : 'at cost basis'}) minus ${formatUsdWhole(equity.liabilityCents)} in mortgage balances.`
        : 'There is not enough data yet to estimate equity — add a valuation or acquisition cost.';
      return [
        ...textDeltas(`For ${label}: ${mortgageSummary}, and ${valuationSummary}. ${equitySummary}`),
        stopEndTurn,
      ];
    },
    () => [stopEndTurn],
  ],
};

// ── script 5: maintenance / work orders — real list_work_orders call ─────────

const WORK_ORDER_STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const WORK_ORDER_PRIORITY_LABEL: Record<string, string> = {
  emergency: 'Emergency',
  normal: 'Normal',
  low: 'Low',
};

const WORK_ORDER_PRIORITY_RANK: Record<string, number> = { emergency: 0, normal: 1, low: 2 };

const maintenanceScript: MockScript = {
  pattern: /maintenance|repair|work order/i,
  steps: [
    () => [
      toolUse('toolu_mock_work_orders', 'list_work_orders', { openOnly: true }),
      stopToolUse,
    ],
    (ctx) => {
      const open = ctx.result('list_work_orders') as WorkOrderListRow[];
      if (open.length === 0) {
        return [
          ...textDeltas(
            'No open work orders right now — everything on the maintenance side is closed out.',
          ),
          stopEndTurn,
        ];
      }
      const emergencyCount = open.filter((w) => w.priority === 'emergency').length;
      const overdueCount = open.filter((w) => w.overdue).length;
      // Most urgent first: overdue, then priority, then longest-open within a tier.
      const sorted = [...open].sort((a, b) => {
        if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
        const byPriority =
          (WORK_ORDER_PRIORITY_RANK[a.priority] ?? 1) - (WORK_ORDER_PRIORITY_RANK[b.priority] ?? 1);
        if (byPriority !== 0) return byPriority;
        return b.daysOpen - a.daysOpen;
      });
      const extra = [
        emergencyCount > 0 ? `${emergencyCount} marked emergency` : null,
        overdueCount > 0 ? `${overdueCount} past due` : null,
      ].filter((s): s is string => s !== null);
      return [
        ...textDeltas(
          `${open.length} open work order${open.length === 1 ? '' : 's'}${extra.length > 0 ? ` (${extra.join(', ')})` : ''}. Here is the list, most urgent first.`,
        ),
        toolUse('toolu_mock_work_orders_table', 'render_table', {
          type: 'data_table',
          title: 'Open work orders',
          columns: [
            { key: 'title', label: 'Work order' },
            { key: 'property', label: 'Property / unit' },
            { key: 'status', label: 'Status' },
            { key: 'priority', label: 'Priority' },
            { key: 'contractor', label: 'Assigned to' },
            // reportedOn is a calendar date ("YYYY-MM-DD"), not an instant —
            // format: 'date' would parse it as UTC midnight and render a day
            // early west of UTC (the PLAN-REAL-EQUITY Phase 2b lesson), so this
            // column stays 'text' and shows the raw calendar date as-is.
            { key: 'reported', label: 'Reported' },
            { key: 'cost', label: 'Cost so far', align: 'right', format: 'usd' },
          ],
          rows: sorted.map((w) => ({
            title: w.title,
            property: w.unitLabel ? `${w.propertyLabel} ${w.unitLabel}` : w.propertyLabel,
            status: WORK_ORDER_STATUS_LABEL[w.status] ?? w.status,
            priority: WORK_ORDER_PRIORITY_LABEL[w.priority] ?? w.priority,
            contractor: w.contractorName ?? 'Unassigned',
            reported: w.reportedOn,
            cost: w.costCents,
          })),
        }),
        stopToolUse,
      ];
    },
    () => [stopEndTurn],
  ],
};

// ── script 6: fallback ────────────────────────────────────────────────────────

const fallbackScript: MockScript = {
  pattern: /.*/,
  steps: [
    () => [toolUse('toolu_mock_summary', 'get_portfolio_summary', {}), stopToolUse],
    (ctx) => {
      const { summary } = ctx.result('get_portfolio_summary') as { summary: string };
      return [
        ...textDeltas(`${summary} Ask me about cash flow, late rent, or tax prep for more detail.`),
        stopEndTurn,
      ];
    },
    () => [stopEndTurn],
  ],
};

/** Ordered — first pattern match wins; the last entry always matches. */
export const MOCK_SCRIPTS: MockScript[] = [
  cashflowScript,
  taxScript,
  lateRentScript,
  equityScript,
  maintenanceScript,
  fallbackScript,
];
