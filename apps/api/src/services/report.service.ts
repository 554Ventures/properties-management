import {
  formatUsdWhole,
  type GenerateReportInput,
  type Report,
  type ReportDetailResponse,
  type ReportType,
  type ReportTypeInfo,
} from '@hearth/shared';
import type { Prisma, Report as DbReport } from '@prisma/client';
import { toCsv, type CsvColumn } from '../lib/csv';
import {
  addMonthsToPeriod,
  currentPeriod,
  iso,
  monthEndExclusive,
  monthStart,
  periodLabel,
  periodOf,
  trailingPeriods,
  yearRange,
} from '../lib/dates';
import { BadRequestError, NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { renderPdfPlaceholder } from '../lib/pdf';
import { mockEmail } from '../integrations/mock/mock-email';
import { writeAudit, type AuditActor } from './audit.service';
import { deriveRentStatus } from './rent.service';

// ── library ──────────────────────────────────────────────────────────────────

// Resolved decision #5: schedule_e, pnl, net_cashflow, rent_roll,
// general_ledger, tenant_ledger (and monthly_review) get real computed data;
// the rest are structurally-correct simplified outputs.
const LIBRARY: ReportTypeInfo[] = [
  { type: 'schedule_e', name: 'Schedule E', description: 'IRS Schedule E worksheet: rents received and expenses by line, per property.', maturity: 'full', supportedFilters: ['taxYear', 'property'] },
  { type: 'pnl', name: 'Profit & Loss', description: 'Income and expenses by category with net, for any period.', maturity: 'full', supportedFilters: ['taxYear', 'dateRange', 'property'] },
  { type: 'net_cashflow', name: 'Net Cash Flow', description: 'Month-by-month income vs. expenses and net cash flow.', maturity: 'full', supportedFilters: ['taxYear', 'dateRange', 'property'] },
  { type: 'rent_roll', name: 'Rent Roll', description: 'Every active lease: property, unit, tenant, rent and lease dates.', maturity: 'full', supportedFilters: ['property'] },
  { type: 'general_ledger', name: 'General Ledger', description: 'Every confirmed transaction in the period.', maturity: 'full', supportedFilters: ['taxYear', 'dateRange', 'property'] },
  { type: 'tenant_ledger', name: 'Tenant Ledger', description: 'Rent charges and payments per tenant.', maturity: 'full', supportedFilters: ['dateRange', 'property'] },
  { type: 'monthly_review', name: 'Monthly Review', description: 'AI-style monthly summary: bottom line, per-property nets and watch items.', maturity: 'full', supportedFilters: ['dateRange'] },
  { type: 'income_statement', name: 'Income Statement', description: 'Simplified income statement for the period.', maturity: 'simplified', supportedFilters: ['taxYear', 'dateRange', 'property'] },
  { type: 'balance_sheet', name: 'Balance Sheet', description: 'Simplified balance sheet: property cost basis and period cash.', maturity: 'simplified', supportedFilters: ['dateRange'] },
  { type: 'reo_schedule', name: 'REO Schedule', description: 'Real-estate-owned schedule: acquisition dates, cost basis and rents.', maturity: 'simplified', supportedFilters: [] },
  { type: 'capital_expenses', name: 'Capital Expenses', description: 'Capital improvement spending in the period.', maturity: 'simplified', supportedFilters: ['taxYear', 'dateRange', 'property'] },
  { type: 'escrow_ledger', name: 'Escrow Ledger', description: 'Escrow account activity (no escrow accounts in v1).', maturity: 'simplified', supportedFilters: [] },
  { type: 'tax_package', name: 'Tax Package', description: 'Year-end bundle: Schedule E totals plus supporting notes for your accountant.', maturity: 'simplified', supportedFilters: ['taxYear'] },
  { type: 'stress_test', name: 'Stress Test', description: 'What-if scenarios: vacancy, expense inflation and rate shocks vs. current net.', maturity: 'simplified', supportedFilters: ['dateRange', 'property'] },
];

export function listLibrary(): ReportTypeInfo[] {
  return LIBRARY;
}

function typeInfo(type: ReportType): ReportTypeInfo {
  const info = LIBRARY.find((i) => i.type === type);
  if (!info) throw new BadRequestError(`unknown report type ${type}`);
  return info;
}

// ── mapping ──────────────────────────────────────────────────────────────────

export function toApiReport(r: DbReport): Report {
  return {
    id: r.id,
    accountId: r.accountId,
    type: r.type as ReportType,
    title: r.title,
    periodStart: iso(r.periodStart),
    periodEnd: iso(r.periodEnd),
    taxYear: r.taxYear,
    propertyId: r.propertyId,
    generatedAt: iso(r.generatedAt),
  };
}

export async function listGenerated(
  accountId: string,
  filter: { type?: ReportType; taxYear?: number } = {},
): Promise<Report[]> {
  const rows = await prisma.report.findMany({
    where: {
      accountId,
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.taxYear !== undefined ? { taxYear: filter.taxYear } : {}),
    },
    orderBy: { generatedAt: 'desc' },
  });
  return rows.map(toApiReport);
}

export async function getById(accountId: string, id: string): Promise<ReportDetailResponse> {
  const row = await prisma.report.findFirst({ where: { id, accountId } });
  if (!row) throw new NotFoundError('report', id);
  return { ...toApiReport(row), data: JSON.parse(row.dataJson) };
}

// ── shared data helpers ──────────────────────────────────────────────────────

interface ReportTable {
  columns: CsvColumn[];
  rows: Array<Record<string, string | number | null>>;
}

function confirmedWhere(
  accountId: string,
  range: { from: Date; to: Date },
  propertyId?: string,
): Prisma.TransactionWhereInput {
  return {
    accountId,
    status: 'confirmed',
    date: { gte: range.from, lt: range.to },
    ...(propertyId ? { propertyId } : {}),
  };
}

async function fetchLedger(accountId: string, range: { from: Date; to: Date }, propertyId?: string) {
  return prisma.transaction.findMany({
    where: confirmedWhere(accountId, range, propertyId),
    include: { category: true, property: true },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
  });
}

// ── builders (real computed data) ────────────────────────────────────────────

async function buildPnl(accountId: string, range: { from: Date; to: Date }, propertyId?: string) {
  const txns = await fetchLedger(accountId, range, propertyId);
  const lines = new Map<string, { categoryName: string; type: string; totalCents: number }>();
  let incomeCents = 0;
  let expenseCents = 0;
  for (const t of txns) {
    if (t.type === 'income') incomeCents += t.amountCents;
    else expenseCents += t.amountCents;
    const key = `${t.type}:${t.category?.name ?? 'Uncategorized'}`;
    const line = lines.get(key) ?? {
      categoryName: t.category?.name ?? 'Uncategorized',
      type: t.type,
      totalCents: 0,
    };
    line.totalCents += t.amountCents;
    lines.set(key, line);
  }
  const rows = [...lines.values()].sort(
    (a, b) => a.type.localeCompare(b.type) || b.totalCents - a.totalCents,
  );
  return {
    lines: rows,
    totals: { incomeCents, expenseCents, netCents: incomeCents - expenseCents },
    table: {
      columns: [
        { key: 'type', label: 'Type' },
        { key: 'categoryName', label: 'Category' },
        { key: 'totalCents', label: 'Total (cents)' },
      ],
      rows,
    } satisfies ReportTable,
  };
}

async function buildNetCashflow(
  accountId: string,
  range: { from: Date; to: Date },
  propertyId?: string,
) {
  const txns = await fetchLedger(accountId, range, propertyId);
  const months = new Map<string, { month: string; incomeCents: number; expenseCents: number; netCents: number }>();
  for (const t of txns) {
    const month = periodOf(t.date);
    const row = months.get(month) ?? { month, incomeCents: 0, expenseCents: 0, netCents: 0 };
    if (t.type === 'income') row.incomeCents += t.amountCents;
    else row.expenseCents += t.amountCents;
    row.netCents = row.incomeCents - row.expenseCents;
    months.set(month, row);
  }
  const rows = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  const totals = rows.reduce(
    (acc, r) => ({
      incomeCents: acc.incomeCents + r.incomeCents,
      expenseCents: acc.expenseCents + r.expenseCents,
      netCents: acc.netCents + r.netCents,
    }),
    { incomeCents: 0, expenseCents: 0, netCents: 0 },
  );
  return {
    months: rows,
    totals,
    table: {
      columns: [
        { key: 'month', label: 'Month' },
        { key: 'incomeCents', label: 'Income (cents)' },
        { key: 'expenseCents', label: 'Expenses (cents)' },
        { key: 'netCents', label: 'Net (cents)' },
      ],
      rows,
    } satisfies ReportTable,
  };
}

async function buildRentRoll(accountId: string, propertyId?: string) {
  const leases = await prisma.lease.findMany({
    where: {
      status: 'active',
      unit: { property: { accountId, ...(propertyId ? { id: propertyId } : {}) } },
    },
    include: {
      unit: { include: { property: true } },
      leaseTenants: { include: { tenant: true }, orderBy: { isPrimary: 'desc' } },
    },
    orderBy: { rentCents: 'desc' },
  });
  const rows = leases.map((l) => ({
    propertyLabel: l.unit.property.nickname ?? l.unit.property.addressLine1,
    unitLabel: l.unit.label,
    tenantName: l.leaseTenants[0]?.tenant.fullName ?? '',
    rentCents: l.rentCents,
    dueDay: l.dueDay,
    leaseStart: iso(l.startDate),
    leaseEnd: iso(l.endDate),
  }));
  return {
    rows,
    totals: { monthlyRentCents: rows.reduce((sum, r) => sum + r.rentCents, 0), leaseCount: rows.length },
    table: {
      columns: [
        { key: 'propertyLabel', label: 'Property' },
        { key: 'unitLabel', label: 'Unit' },
        { key: 'tenantName', label: 'Tenant' },
        { key: 'rentCents', label: 'Rent (cents)' },
        { key: 'dueDay', label: 'Due day' },
        { key: 'leaseStart', label: 'Lease start' },
        { key: 'leaseEnd', label: 'Lease end' },
      ],
      rows,
    } satisfies ReportTable,
  };
}

async function buildGeneralLedger(
  accountId: string,
  range: { from: Date; to: Date },
  propertyId?: string,
) {
  const txns = await fetchLedger(accountId, range, propertyId);
  const rows = txns.map((t) => ({
    date: iso(t.date),
    description: t.description,
    vendor: t.vendor,
    propertyLabel: t.property ? (t.property.nickname ?? t.property.addressLine1) : null,
    categoryName: t.category?.name ?? null,
    type: t.type,
    amountCents: t.amountCents,
  }));
  const incomeCents = txns.filter((t) => t.type === 'income').reduce((s, t) => s + t.amountCents, 0);
  const expenseCents = txns.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amountCents, 0);
  return {
    rows,
    totals: { incomeCents, expenseCents, netCents: incomeCents - expenseCents, count: rows.length },
    table: {
      columns: [
        { key: 'date', label: 'Date' },
        { key: 'description', label: 'Description' },
        { key: 'vendor', label: 'Vendor' },
        { key: 'propertyLabel', label: 'Property' },
        { key: 'categoryName', label: 'Category' },
        { key: 'type', label: 'Type' },
        { key: 'amountCents', label: 'Amount (cents)' },
      ],
      rows,
    } satisfies ReportTable,
  };
}

async function buildTenantLedger(
  accountId: string,
  range: { from: Date; to: Date },
  propertyId?: string,
) {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const payments = await prisma.rentPayment.findMany({
    where: {
      dueDate: { gte: range.from, lt: range.to },
      lease: { unit: { property: { accountId, ...(propertyId ? { id: propertyId } : {}) } } },
    },
    include: {
      lease: {
        include: {
          unit: { include: { property: true } },
          leaseTenants: { include: { tenant: true }, orderBy: { isPrimary: 'desc' } },
        },
      },
    },
    orderBy: [{ dueDate: 'asc' }],
  });
  const rows = payments.map((p) => {
    const derived = deriveRentStatus(p, account.graceDays);
    return {
      tenantName: p.lease.leaseTenants[0]?.tenant.fullName ?? '',
      propertyLabel: p.lease.unit.property.nickname ?? p.lease.unit.property.addressLine1,
      unitLabel: p.lease.unit.label,
      period: p.period,
      dueDate: iso(p.dueDate),
      amountCents: p.amountCents,
      status: derived.status,
      paidAt: p.paidAt ? iso(p.paidAt) : null,
    };
  });
  return {
    rows,
    totals: {
      chargedCents: rows.reduce((s, r) => s + r.amountCents, 0),
      collectedCents: rows.filter((r) => r.status === 'paid').reduce((s, r) => s + r.amountCents, 0),
    },
    table: {
      columns: [
        { key: 'tenantName', label: 'Tenant' },
        { key: 'propertyLabel', label: 'Property' },
        { key: 'unitLabel', label: 'Unit' },
        { key: 'period', label: 'Period' },
        { key: 'dueDate', label: 'Due date' },
        { key: 'amountCents', label: 'Amount (cents)' },
        { key: 'status', label: 'Status' },
        { key: 'paidAt', label: 'Paid at' },
      ],
      rows,
    } satisfies ReportTable,
  };
}

async function buildScheduleE(
  accountId: string,
  range: { from: Date; to: Date },
  propertyId?: string,
) {
  const txns = await fetchLedger(accountId, range, propertyId);
  interface PropertyRow {
    propertyId: string | null;
    propertyLabel: string;
    rentsReceivedCents: number;
    otherIncomeCents: number; // income whose category maps off Line 3
    expenseLines: Record<string, number>; // IRS line label → cents
    totalExpensesCents: number;
    netCents: number;
  }
  const rowsByProperty = new Map<string, PropertyRow>();
  for (const t of txns) {
    const key = t.propertyId ?? '__portfolio__';
    const row = rowsByProperty.get(key) ?? {
      propertyId: t.propertyId,
      propertyLabel: t.property
        ? (t.property.nickname ?? t.property.addressLine1)
        : 'Portfolio / unassigned',
      rentsReceivedCents: 0,
      otherIncomeCents: 0,
      expenseLines: {},
      totalExpensesCents: 0,
      netCents: 0,
    };
    if (t.type === 'income') {
      // Income maps through the category's IRS line like expenses do
      // (uncategorized defaults to rents); a category mapped off Line 3
      // stays out of "Rents received" instead of silently inflating it.
      const line = t.category?.irsScheduleELine ?? 'Line 3 – Rents received';
      if (line === 'Line 3 – Rents received') row.rentsReceivedCents += t.amountCents;
      else row.otherIncomeCents += t.amountCents;
    } else {
      const line = t.category?.irsScheduleELine ?? 'Line 19 – Other';
      row.expenseLines[line] = (row.expenseLines[line] ?? 0) + t.amountCents;
      row.totalExpensesCents += t.amountCents;
    }
    row.netCents = row.rentsReceivedCents + row.otherIncomeCents - row.totalExpensesCents;
    rowsByProperty.set(key, row);
  }
  const propertyRows = [...rowsByProperty.values()].sort((a, b) =>
    a.propertyLabel.localeCompare(b.propertyLabel),
  );
  const totals = propertyRows.reduce(
    (acc, r) => ({
      rentsReceivedCents: acc.rentsReceivedCents + r.rentsReceivedCents,
      otherIncomeCents: acc.otherIncomeCents + r.otherIncomeCents,
      totalExpensesCents: acc.totalExpensesCents + r.totalExpensesCents,
      netCents: acc.netCents + r.netCents,
    }),
    { rentsReceivedCents: 0, otherIncomeCents: 0, totalExpensesCents: 0, netCents: 0 },
  );
  const tableRows = propertyRows.map((r) => ({
    propertyLabel: r.propertyLabel,
    rentsReceivedCents: r.rentsReceivedCents,
    otherIncomeCents: r.otherIncomeCents,
    totalExpensesCents: r.totalExpensesCents,
    netCents: r.netCents,
  }));
  return {
    propertyRows,
    totals,
    disclaimer:
      'Estimate for tax preparation only — not tax advice. Verify with your accountant before filing.',
    table: {
      columns: [
        { key: 'propertyLabel', label: 'Property' },
        { key: 'rentsReceivedCents', label: 'Rents received (cents)' },
        { key: 'otherIncomeCents', label: 'Other income (cents)' },
        { key: 'totalExpensesCents', label: 'Total expenses (cents)' },
        { key: 'netCents', label: 'Net (cents)' },
      ],
      rows: tableRows,
    } satisfies ReportTable,
  };
}

// ── builders (structurally-correct simplified outputs) ───────────────────────

async function buildBalanceSheet(accountId: string, range: { from: Date; to: Date }) {
  const properties = await prisma.property.findMany({ where: { accountId } });
  const pnl = await buildPnl(accountId, range);
  const assetRows = [
    ...properties.map((p) => ({
      item: `${p.nickname ?? p.addressLine1} (at cost)`,
      amountCents: p.acquisitionCostCents ?? 0,
    })),
    { item: 'Operating cash (period net)', amountCents: pnl.totals.netCents },
  ];
  const totalAssetsCents = assetRows.reduce((s, r) => s + r.amountCents, 0);
  return {
    simplified: true,
    assets: assetRows,
    liabilities: [] as Array<{ item: string; amountCents: number }>,
    totals: { totalAssetsCents, totalLiabilitiesCents: 0, equityCents: totalAssetsCents },
    table: {
      columns: [
        { key: 'item', label: 'Item' },
        { key: 'amountCents', label: 'Amount (cents)' },
      ],
      rows: assetRows,
    } satisfies ReportTable,
  };
}

async function buildReoSchedule(accountId: string) {
  const properties = await prisma.property.findMany({
    where: { accountId },
    include: { units: { include: { leases: { where: { status: 'active' } } } } },
    orderBy: { createdAt: 'asc' },
  });
  const rows = properties.map((p) => ({
    propertyLabel: p.nickname ?? p.addressLine1,
    address: `${p.addressLine1}, ${p.city}, ${p.state} ${p.zip}`,
    acquisitionDate: p.acquisitionDate ? iso(p.acquisitionDate) : null,
    acquisitionCostCents: p.acquisitionCostCents,
    units: p.units.length,
    monthlyRentCents: p.units.reduce((s, u) => s + (u.leases[0]?.rentCents ?? 0), 0),
  }));
  return {
    simplified: true,
    rows,
    totals: {
      acquisitionCostCents: rows.reduce((s, r) => s + (r.acquisitionCostCents ?? 0), 0),
      monthlyRentCents: rows.reduce((s, r) => s + r.monthlyRentCents, 0),
    },
    table: {
      columns: [
        { key: 'propertyLabel', label: 'Property' },
        { key: 'address', label: 'Address' },
        { key: 'acquisitionDate', label: 'Acquired' },
        { key: 'acquisitionCostCents', label: 'Cost basis (cents)' },
        { key: 'units', label: 'Units' },
        { key: 'monthlyRentCents', label: 'Monthly rent (cents)' },
      ],
      rows,
    } satisfies ReportTable,
  };
}

async function buildCapitalExpenses(
  accountId: string,
  range: { from: Date; to: Date },
  propertyId?: string,
) {
  const capCategory = await prisma.category.findFirst({ where: { name: 'Capital Improvements' } });
  const txns = await prisma.transaction.findMany({
    where: {
      ...confirmedWhere(accountId, range, propertyId),
      categoryId: capCategory?.id ?? '__none__',
    },
    include: { property: true },
    orderBy: { date: 'asc' },
  });
  const rows = txns.map((t) => ({
    date: iso(t.date),
    description: t.description,
    propertyLabel: t.property ? (t.property.nickname ?? t.property.addressLine1) : null,
    amountCents: t.amountCents,
  }));
  return {
    simplified: true,
    rows,
    totals: { totalCents: rows.reduce((s, r) => s + r.amountCents, 0) },
    table: {
      columns: [
        { key: 'date', label: 'Date' },
        { key: 'description', label: 'Description' },
        { key: 'propertyLabel', label: 'Property' },
        { key: 'amountCents', label: 'Amount (cents)' },
      ],
      rows,
    } satisfies ReportTable,
  };
}

function buildEscrowLedger() {
  return {
    simplified: true,
    note: 'No escrow accounts are configured in v1.',
    rows: [] as Array<Record<string, string | number | null>>,
    totals: { balanceCents: 0 },
    table: {
      columns: [
        { key: 'date', label: 'Date' },
        { key: 'description', label: 'Description' },
        { key: 'amountCents', label: 'Amount (cents)' },
      ],
      rows: [],
    } satisfies ReportTable,
  };
}

async function buildTaxPackage(accountId: string, range: { from: Date; to: Date }, taxYear: number) {
  const scheduleE = await buildScheduleE(accountId, range);
  return {
    simplified: true,
    taxYear,
    note: 'Simplified bundle — generate the full Schedule E report for line-level detail.',
    scheduleETotals: scheduleE.totals,
    propertyCount: scheduleE.propertyRows.filter((r) => r.propertyId !== null).length,
    table: scheduleE.table,
  };
}

async function buildStressTest(
  accountId: string,
  range: { from: Date; to: Date },
  propertyId?: string,
) {
  const pnl = await buildPnl(accountId, range, propertyId);
  const base = pnl.totals;
  const scenarios = [
    { scenario: 'Base (period actuals)', netCents: base.netCents },
    { scenario: 'Vacancy +10%', netCents: Math.round(base.incomeCents * 0.9) - base.expenseCents },
    { scenario: 'Expenses +15%', netCents: base.incomeCents - Math.round(base.expenseCents * 1.15) },
    {
      scenario: 'Vacancy +10% and expenses +15%',
      netCents: Math.round(base.incomeCents * 0.9) - Math.round(base.expenseCents * 1.15),
    },
  ];
  return {
    simplified: true,
    base,
    scenarios,
    table: {
      columns: [
        { key: 'scenario', label: 'Scenario' },
        { key: 'netCents', label: 'Net (cents)' },
      ],
      rows: scenarios,
    } satisfies ReportTable,
  };
}

async function buildMonthlyReview(accountId: string, period: string) {
  const range = { from: monthStart(period), to: monthEndExclusive(period) };
  const pnl = await buildPnl(accountId, range);
  const properties = await prisma.property.findMany({ where: { accountId }, include: { units: true } });
  const grouped = await prisma.transaction.groupBy({
    by: ['propertyId', 'type'],
    where: confirmedWhere(accountId, range),
    _sum: { amountCents: true },
  });
  const netByProperty = new Map<string, number>();
  for (const g of grouped) {
    if (!g.propertyId) continue;
    const signed = (g._sum.amountCents ?? 0) * (g.type === 'income' ? 1 : -1);
    netByProperty.set(g.propertyId, (netByProperty.get(g.propertyId) ?? 0) + signed);
  }
  const propertyNets = properties.map((p) => ({
    propertyLabel: p.nickname ?? p.addressLine1,
    units: p.units.length,
    netCents: netByProperty.get(p.id) ?? 0,
  }));

  // Watch items: expense categories that spiked vs. the prior 3 months, plus
  // upcoming renewals.
  const watchItems: string[] = [];
  const priorStart = monthStart(addMonthsToPeriod(period, -3));
  const currentByCat = await prisma.transaction.groupBy({
    by: ['categoryId'],
    where: { ...confirmedWhere(accountId, range), type: 'expense', categoryId: { not: null } },
    _sum: { amountCents: true },
  });
  const priorByCat = await prisma.transaction.groupBy({
    by: ['categoryId'],
    where: {
      ...confirmedWhere(accountId, { from: priorStart, to: range.from }),
      type: 'expense',
    },
    _sum: { amountCents: true },
  });
  const priorMap = new Map(priorByCat.map((g) => [g.categoryId ?? '', g._sum.amountCents ?? 0]));
  const categories = await prisma.category.findMany();
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const spikes = currentByCat
    .map((g) => ({
      name: categoryName.get(g.categoryId as string) ?? 'Uncategorized',
      current: g._sum.amountCents ?? 0,
      avg: (priorMap.get(g.categoryId as string) ?? 0) / 3,
    }))
    .filter((s) => s.avg > 0 && s.current > s.avg * 1.25)
    .sort((a, b) => b.current - a.current)
    .slice(0, 2);
  for (const s of spikes) {
    watchItems.push(
      `${s.name} ran ${formatUsdWhole(s.current)} in ${periodLabel(period)} vs a ${formatUsdWhole(Math.round(s.avg))} three-month average.`,
    );
  }
  const renewCount = await prisma.lease.count({
    where: {
      status: 'active',
      unit: { property: { accountId } },
      endDate: { gte: range.to, lte: new Date(range.to.getTime() + 60 * 86_400_000) },
    },
  });
  if (renewCount > 0) {
    watchItems.push(`${renewCount} lease${renewCount === 1 ? '' : 's'} come up for renewal within 60 days.`);
  }

  return {
    period,
    bottomLine: `You netted ${formatUsdWhole(pnl.totals.netCents)} in ${periodLabel(period)} — ${formatUsdWhole(pnl.totals.incomeCents)} collected against ${formatUsdWhole(pnl.totals.expenseCents)} in expenses.`,
    totals: pnl.totals,
    propertyNets,
    watchItems,
    table: {
      columns: [
        { key: 'propertyLabel', label: 'Property' },
        { key: 'units', label: 'Units' },
        { key: 'netCents', label: 'Net (cents)' },
      ],
      rows: propertyNets,
    } satisfies ReportTable,
  };
}

// ── generate / export / email ────────────────────────────────────────────────

function resolveRange(input: GenerateReportInput): {
  from: Date;
  to: Date;
  taxYear: number | null;
  label: string;
} {
  if (input.taxYear !== undefined) {
    const { from, to } = yearRange(input.taxYear);
    return { from, to, taxYear: input.taxYear, label: String(input.taxYear) };
  }
  if (input.from && input.to) {
    const from = new Date(input.from);
    const to = new Date(input.to);
    return {
      from,
      to,
      taxYear: null,
      label: `${from.toISOString().slice(0, 10)} – ${to.toISOString().slice(0, 10)}`,
    };
  }
  const year = new Date().getUTCFullYear();
  const { from, to } = yearRange(year);
  return { from, to, taxYear: year, label: String(year) };
}

async function buildData(
  accountId: string,
  type: ReportType,
  range: { from: Date; to: Date },
  taxYear: number | null,
  propertyId?: string,
): Promise<unknown> {
  switch (type) {
    case 'pnl':
    case 'income_statement':
      return buildPnl(accountId, range, propertyId);
    case 'net_cashflow':
      return buildNetCashflow(accountId, range, propertyId);
    case 'rent_roll':
      return buildRentRoll(accountId, propertyId);
    case 'general_ledger':
      return buildGeneralLedger(accountId, range, propertyId);
    case 'tenant_ledger':
      return buildTenantLedger(accountId, range, propertyId);
    case 'schedule_e':
      return buildScheduleE(accountId, range, propertyId);
    case 'balance_sheet':
      return buildBalanceSheet(accountId, range);
    case 'reo_schedule':
      return buildReoSchedule(accountId);
    case 'capital_expenses':
      return buildCapitalExpenses(accountId, range, propertyId);
    case 'escrow_ledger':
      return buildEscrowLedger();
    case 'tax_package':
      return buildTaxPackage(accountId, range, taxYear ?? new Date().getUTCFullYear());
    case 'stress_test':
      return buildStressTest(accountId, range, propertyId);
    case 'monthly_review':
      return buildMonthlyReview(accountId, periodOf(range.from));
  }
}

/** Generates and snapshots a report (dataJson never silently changes later). */
export async function generate(
  accountId: string,
  input: GenerateReportInput,
  actor: AuditActor = 'user',
): Promise<Report> {
  if (input.type === 'monthly_review') {
    const period = input.from ? periodOf(new Date(input.from)) : addMonthsToPeriod(currentPeriod(), -1);
    return generateMonthlyReviewReport(accountId, period, actor);
  }
  const info = typeInfo(input.type);
  const { from, to, taxYear, label } = resolveRange(input);
  const data = await buildData(accountId, input.type, { from, to }, taxYear, input.propertyId);
  const row = await prisma.report.create({
    data: {
      accountId,
      type: input.type,
      title: `${info.name} — ${label}`,
      periodStart: from,
      periodEnd: to,
      taxYear,
      propertyId: input.propertyId ?? null,
      dataJson: JSON.stringify(data),
    },
  });
  await writeAudit(accountId, {
    actor,
    action: 'report.generated',
    entityType: 'report',
    entityId: row.id,
    detail: { type: input.type, taxYear, propertyId: input.propertyId ?? null },
  });
  return toApiReport(row);
}

// Defaults to 'system' — the daily scheduler is the canonical caller;
// generate() passes the surface's actor through.
export async function generateMonthlyReviewReport(
  accountId: string,
  period: string,
  actor: AuditActor = 'system',
): Promise<Report> {
  const data = await buildMonthlyReview(accountId, period);
  const row = await prisma.report.create({
    data: {
      accountId,
      type: 'monthly_review',
      title: `Monthly review — ${periodLabel(period)}`,
      periodStart: monthStart(period),
      periodEnd: monthEndExclusive(period),
      taxYear: null,
      propertyId: null,
      dataJson: JSON.stringify(data),
    },
  });
  await writeAudit(accountId, {
    actor,
    action: 'report.generated',
    entityType: 'report',
    entityId: row.id,
    detail: { type: 'monthly_review', period },
  });
  return toApiReport(row);
}

interface SnapshotTable {
  table?: { columns: CsvColumn[]; rows: Array<Record<string, unknown>> };
  totals?: Record<string, unknown>;
}

export async function exportCsv(
  accountId: string,
  id: string,
): Promise<{ filename: string; csv: string }> {
  const report = await getById(accountId, id);
  const data = report.data as SnapshotTable;
  let csv: string;
  if (data.table) {
    csv = toCsv(data.table.columns, data.table.rows);
  } else {
    const entries = Object.entries(data.totals ?? {}).map(([key, value]) => ({
      key,
      value: value as string | number,
    }));
    csv = toCsv(
      [
        { key: 'key', label: 'Metric' },
        { key: 'value', label: 'Value' },
      ],
      entries,
    );
  }
  return { filename: `${report.type}-${report.id}.csv`, csv };
}

export async function exportPdf(
  accountId: string,
  id: string,
): Promise<{ filename: string; buffer: Buffer }> {
  const report = await getById(accountId, id);
  const data = report.data as SnapshotTable;
  const lines: string[] = [
    `Period: ${report.periodStart} → ${report.periodEnd}`,
    `Totals: ${JSON.stringify(data.totals ?? {})}`,
    `Rows: ${data.table?.rows.length ?? 0}`,
  ];
  return {
    filename: `${report.type}-${report.id}.pdf`,
    buffer: renderPdfPlaceholder(report.title, lines),
  };
}

export async function emailToAccountant(
  accountId: string,
  id: string,
  to: string,
  actor: AuditActor = 'user',
): Promise<void> {
  const report = await getById(accountId, id);
  await mockEmail.send({
    to,
    subject: `554 Properties report: ${report.title}`,
    body: `Your report "${report.title}" is attached (mock email — no attachment actually sent).`,
  });
  await writeAudit(accountId, {
    actor,
    action: 'report.emailed',
    entityType: 'report',
    entityId: id,
    detail: { to },
  });
}
