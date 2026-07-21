// W1 weekly brief: idempotent generation inside runDailyJobs (last completed
// Mon–Sun week only, catch-up-safe), contract-valid dataJson whose api_call
// actions are allowlist-legal by construction, deterministic composition in
// mock mode, prefs-routed push/email delivery, the latest endpoint, and the
// on-demand /reports/generate path with 'user' attribution. Created reports/
// devices are cleaned up so later files see only seed data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  ReportSchema,
  WeeklyBriefDataSchema,
  WeeklyBriefLatestResponseSchema,
} from '@hearth/shared';
import { DEMO_EMAIL } from '../../prisma/seed-constants';
import { deterministicBrief } from '../ai/weekly-brief';
import { buildApp } from '../app';
import { resetMockEmail, sentEmails } from '../integrations/mock/mock-email';
import { resetMockPush, sentPushes } from '../integrations/mock/mock-push';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import { accountTimezone } from '../services/account.service';
import { runDailyJobs } from '../services/jobs.service';
import * as pushService from '../services/push.service';
import * as reportService from '../services/report.service';

let app: FastifyInstance;
let accountId: string;
let tz: string;
let lastWeekStart: Date;

const TOKEN = 'weekly_brief_test_device';

async function demoBriefRows() {
  return prisma.report.findMany({
    where: { accountId, type: 'weekly_brief', periodStart: lastWeekStart },
  });
}

async function deleteDemoBriefs() {
  await prisma.report.deleteMany({ where: { accountId, type: 'weekly_brief' } });
}

beforeAll(async () => {
  app = await buildApp();
  accountId = await getDemoAccountId();
  tz = await accountTimezone(accountId);
  lastWeekStart = reportService.lastCompletedWeekStartInTz(new Date(), tz);
  // Earlier suites' runDailyJobs may have left a brief — start clean.
  await deleteDemoBriefs();
});

afterAll(async () => {
  await deleteDemoBriefs();
  await prisma.account.update({
    where: { id: accountId },
    data: { notificationPrefsJson: '{}' },
  });
  await prisma.pushDevice.deleteMany({ where: { token: TOKEN } });
  await app.close();
});

describe('runDailyJobs weekly brief generation', () => {
  it('creates exactly one brief for the last completed week; a second run creates none', async () => {
    const first = await runDailyJobs();
    expect(first.weeklyBriefsCreated).toBeGreaterThanOrEqual(1);
    const afterFirst = await demoBriefRows();
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.periodStart.getTime()).toBe(lastWeekStart.getTime());

    const second = await runDailyJobs();
    expect(second.weeklyBriefsCreated).toBe(0);
    expect(await demoBriefRows()).toHaveLength(1);

    // Scheduler-generated: audited as system.
    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'report.generated', entityId: afterFirst[0]!.id },
    });
    expect(audit?.actor).toBe('system');
    expect(JSON.parse(audit!.detailJson!)).toMatchObject({ type: 'weekly_brief' });
  });

  it('a deleted brief is recreated on the next run (catch-up, latest week only)', async () => {
    await deleteDemoBriefs();
    await runDailyJobs();
    const rows = await demoBriefRows();
    expect(rows).toHaveLength(1);
    // Only the most recent completed week — never a historical backfill.
    expect(
      await prisma.report.count({ where: { accountId, type: 'weekly_brief' } }),
    ).toBe(1);
  });

  it('dataJson parses with the shared schema and actions are allowlist-legal', async () => {
    const [row] = await demoBriefRows();
    expect(row).toBeDefined();
    const data = WeeklyBriefDataSchema.parse(JSON.parse(row!.dataJson));
    expect(data.items.length).toBeGreaterThanOrEqual(1);
    expect(data.items.length).toBeLessThanOrEqual(4);
    expect(data.headline.length).toBeGreaterThan(0);
    expect(data.summary.length).toBeGreaterThan(0);
    for (const item of data.items) {
      if (!item.action) continue;
      if (item.action.action.kind === 'api_call') {
        expect(item.action.action.path).toBe('/rent/reminders');
        expect(item.action.action.method).toBe('POST');
      } else {
        expect(item.action.action.to.startsWith('/')).toBe(true);
      }
    }
    // The seed's late tenants exist only in the CURRENT month, but the brief's
    // rent status covers the month the week's Sunday falls in — the fully-paid
    // PRIOR month whenever the suite runs in the first days of a month. Assert
    // against the actual facts instead of the wall clock.
    const facts = await reportService.buildWeeklyBriefFacts(accountId, lastWeekStart, tz);
    if (facts.lateRows.length > 0) {
      expect(data.items.some((i) => i.action?.action.kind === 'api_call')).toBe(true);
    } else {
      expect(facts.candidateActions.every((c) => c.action.kind === 'navigate')).toBe(true);
    }
  });

  it('mock-mode composition is deterministic: same facts, same brief', async () => {
    const facts = await reportService.buildWeeklyBriefFacts(accountId, lastWeekStart, tz);
    const factsAgain = await reportService.buildWeeklyBriefFacts(accountId, lastWeekStart, tz);
    expect(deterministicBrief(facts)).toEqual(deterministicBrief(factsAgain));
  });
});

describe('weekly brief delivery through notification prefs', () => {
  it('default prefs: push goes out, email does not', async () => {
    await pushService.registerDevice(accountId, { platform: 'ios', token: TOKEN }, null);
    await deleteDemoBriefs();
    resetMockPush();
    resetMockEmail();

    await runDailyJobs();

    const push = sentPushes.find(
      (p) => p.deviceToken === TOKEN && p.message.title === 'Your weekly brief is ready',
    );
    expect(push).toBeDefined();
    const [row] = await demoBriefRows();
    expect(push!.message.deepLink).toBe(`/reports/${row!.id}`);
    expect(sentEmails.filter((e) => e.to === DEMO_EMAIL)).toHaveLength(0);
  });

  it('with weekly_brief email opted in, the brief is emailed to the account address', async () => {
    // A dedicated account (no User rows, so the account-level store governs):
    // the demo account may carry a leftover Supabase-linked User row from
    // auth.test.ts in a full-suite run, which correctly flips notifyCategory
    // into per-user routing there.
    const emailTo = 'weekly-brief-email@brieftest.example';
    const account = await prisma.account.create({
      data: {
        name: 'Weekly Brief Email',
        email: emailTo,
        notificationPrefsJson: JSON.stringify({ weekly_brief: { push: true, email: true } }),
      },
    });
    resetMockEmail();
    try {
      await runDailyJobs();
      const email = sentEmails.find((e) => e.to === emailTo);
      expect(email).toBeDefined();
      expect(email!.subject).toMatch(/^Weekly brief — /);
      expect(email!.body).toContain('Open 554 Properties');
    } finally {
      await prisma.account.delete({ where: { id: account.id } });
    }
  });
});

describe('weekly brief read/generate surfaces', () => {
  it('GET /reports/weekly-brief/latest returns the newest brief, shared-schema parsed', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reports/weekly-brief/latest' });
    expect(res.statusCode).toBe(200);
    const latest = WeeklyBriefLatestResponseSchema.parse(res.json());
    expect(latest).not.toBeNull();
    expect(latest!.report.type).toBe('weekly_brief');
    expect(latest!.brief.items.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /reports/weekly-brief/latest is null-bodied with no briefs (never 500)', async () => {
    await deleteDemoBriefs();
    const res = await app.inject({ method: 'GET', url: '/api/v1/reports/weekly-brief/latest' });
    expect(res.statusCode).toBe(200);
    expect(WeeklyBriefLatestResponseSchema.parse(res.json())).toBeNull();
  });

  it("POST /reports/generate {type:'weekly_brief'} works and audits as user", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/reports/generate',
      payload: { type: 'weekly_brief' },
    });
    expect(res.statusCode).toBe(201);
    const report = ReportSchema.parse(res.json());
    expect(report.type).toBe('weekly_brief');
    expect(new Date(report.periodStart).getTime()).toBe(lastWeekStart.getTime());

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'report.generated', entityId: report.id },
    });
    expect(audit?.actor).toBe('user');
    expect(JSON.parse(audit!.detailJson!)).toMatchObject({ type: 'weekly_brief' });

    // The on-demand report parses with the same contract as the scheduled one.
    const detail = await reportService.getById(accountId, report.id);
    WeeklyBriefDataSchema.parse(detail.data);

    // Idempotent per period (partial unique index + P2002 re-read): a second
    // manual generate returns the existing snapshot, never a duplicate row.
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/reports/generate',
      payload: { type: 'weekly_brief' },
    });
    expect(again.statusCode).toBe(201);
    expect(ReportSchema.parse(again.json()).id).toBe(report.id);
    expect(await prisma.report.count({ where: { accountId, type: 'weekly_brief' } })).toBe(1);
  });

  it('rejects a brief for the current (incomplete) week so the scheduler still owns it', async () => {
    await deleteDemoBriefs();
    // A `from` inside the current week would collide with the periodStart key
    // the scheduler checks, permanently suppressing the end-of-week brief.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/reports/generate',
      payload: { type: 'weekly_brief', from: new Date().toISOString() },
    });
    expect(res.statusCode).toBe(400);
    expect(await prisma.report.count({ where: { accountId, type: 'weekly_brief' } })).toBe(0);

    // The scheduler still generates + notifies for the last completed week.
    // Registered here (idempotent upsert) so this test holds under -t filtering.
    await pushService.registerDevice(accountId, { platform: 'ios', token: TOKEN }, null);
    resetMockPush();
    await runDailyJobs();
    expect(await demoBriefRows()).toHaveLength(1);
    expect(
      sentPushes.some(
        (p) => p.deviceToken === TOKEN && p.message.title === 'Your weekly brief is ready',
      ),
    ).toBe(true);
  });
});
