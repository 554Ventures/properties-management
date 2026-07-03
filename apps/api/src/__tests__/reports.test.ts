// (e) schedule_e totals reconcile with the ledger.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ReportDetailResponseSchema, ReportSchema } from '@hearth/shared';
import { buildApp } from '../app';
import { yearRange } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import * as reportService from '../services/report.service';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

interface ScheduleEData {
  propertyRows: Array<{ rentsReceivedCents: number; totalExpensesCents: number }>;
  totals: { rentsReceivedCents: number; totalExpensesCents: number; netCents: number };
}

describe('schedule_e report', () => {
  it('totals reconcile with the confirmed ledger for the tax year', async () => {
    const accountId = await getDemoAccountId();
    const taxYear = new Date().getUTCFullYear();
    const report = ReportSchema.parse(
      await reportService.generate(accountId, { type: 'schedule_e', taxYear }),
    );
    expect(report.taxYear).toBe(taxYear);

    const detail = await reportService.getById(accountId, report.id);
    const data = detail.data as ScheduleEData;

    // Independent ledger aggregation over the same range.
    const { from, to } = yearRange(taxYear);
    const grouped = await prisma.transaction.groupBy({
      by: ['type'],
      where: { accountId, status: 'confirmed', date: { gte: from, lt: to } },
      _sum: { amountCents: true },
    });
    const ledgerIncome = grouped.find((g) => g.type === 'income')?._sum.amountCents ?? 0;
    const ledgerExpense = grouped.find((g) => g.type === 'expense')?._sum.amountCents ?? 0;

    expect(data.totals.rentsReceivedCents).toBe(ledgerIncome);
    expect(data.totals.totalExpensesCents).toBe(ledgerExpense);
    expect(data.totals.netCents).toBe(ledgerIncome - ledgerExpense);

    // Per-property rows sum to the totals (portfolio row included).
    const rowIncome = data.propertyRows.reduce((s, r) => s + r.rentsReceivedCents, 0);
    const rowExpense = data.propertyRows.reduce((s, r) => s + r.totalExpensesCents, 0);
    expect(rowIncome).toBe(ledgerIncome);
    expect(rowExpense).toBe(ledgerExpense);

    // Audit trail for the generation.
    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'report.generated', entityId: report.id },
    });
    expect(audit).not.toBeNull();
  });

  it('GET /reports/:id returns the snapshot and export produces CSV', async () => {
    const accountId = await getDemoAccountId();
    const report = await reportService.generate(accountId, {
      type: 'pnl',
      taxYear: new Date().getUTCFullYear(),
    });

    const detailRes = await app.inject({ method: 'GET', url: `/api/v1/reports/${report.id}` });
    expect(detailRes.statusCode).toBe(200);
    ReportDetailResponseSchema.parse(detailRes.json());

    const csvRes = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${report.id}/export?format=csv`,
    });
    expect(csvRes.statusCode).toBe(200);
    expect(csvRes.headers['content-type']).toContain('text/csv');
    expect(csvRes.body).toContain('Category');

    const pdfRes = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${report.id}/export?format=pdf`,
    });
    expect(pdfRes.statusCode).toBe(200);
    expect(pdfRes.headers['content-type']).toContain('application/pdf');
  });

  it('monthly review exists from seed and has real data', async () => {
    const accountId = await getDemoAccountId();
    const reviews = await reportService.listGenerated(accountId, { type: 'monthly_review' });
    expect(reviews.length).toBeGreaterThanOrEqual(1);
    const first = reviews[0];
    const detail = await reportService.getById(accountId, first!.id);
    const data = detail.data as { bottomLine: string; propertyNets: unknown[]; watchItems: string[] };
    expect(data.bottomLine).toContain('You netted');
    expect(data.propertyNets).toHaveLength(9);
    expect(data.watchItems.length).toBeGreaterThanOrEqual(2);
  });
});
