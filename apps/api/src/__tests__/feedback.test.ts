// Beta feedback: POST /feedback stores the submission (server-captured
// userAgent, no AuditLog, no permission gate) and emails FEEDBACK_NOTIFY_EMAIL
// fire-and-forget — a send failure must never fail the write. Everything
// created here is cleaned up so the seeded portfolio stays pristine.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FeedbackSchema } from '@hearth/shared';
import { buildApp } from '../app';
import { resetMockEmail, sentEmails } from '../integrations/mock/mock-email';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';

let app: FastifyInstance;
let accountId: string;

const createdFeedbackIds: string[] = [];

const API = '/api/v1';
const USER_AGENT = 'feedback-test-agent/1.0';

beforeAll(async () => {
  app = await buildApp();
  accountId = await getDemoAccountId();
});

beforeEach(() => {
  resetMockEmail();
  delete process.env.FEEDBACK_NOTIFY_EMAIL;
});

afterAll(async () => {
  delete process.env.FEEDBACK_NOTIFY_EMAIL;
  delete process.env.FEEDBACK_RATE_LIMIT_MAX;
  await prisma.feedback.deleteMany({ where: { id: { in: createdFeedbackIds } } });
  await app.close();
});

async function postFeedback(payload: unknown) {
  return app.inject({
    method: 'POST',
    url: `${API}/feedback`,
    headers: { 'user-agent': USER_AGENT },
    payload: payload as never,
  });
}

function track(id: string): void {
  createdFeedbackIds.push(id);
}

describe('POST /feedback — stores the submission', () => {
  it('201s with the shared shape; server captures userAgent; omitted pagePath is null', async () => {
    const res = await postFeedback({ category: 'bug', message: 'The rent chart is blank' });
    expect(res.statusCode).toBe(201);
    const feedback = FeedbackSchema.parse(res.json());
    track(feedback.id);

    expect(feedback.accountId).toBe(accountId);
    expect(feedback.userId).toBeNull(); // demo mode
    expect(feedback.category).toBe('bug');
    expect(feedback.message).toBe('The rent chart is blank');
    expect(feedback.pagePath).toBeNull();
    expect(feedback.userAgent).toBe(USER_AGENT);

    const row = await prisma.feedback.findUnique({ where: { id: feedback.id } });
    expect(row).not.toBeNull();
    expect(row!.accountId).toBe(accountId);
    expect(row!.category).toBe('bug');
    expect(row!.message).toBe('The rent chart is blank');
    expect(row!.pagePath).toBeNull();
    expect(row!.userAgent).toBe(USER_AGENT);
  });

  it('persists pagePath when the client sends it', async () => {
    const res = await postFeedback({
      category: 'idea',
      message: 'Show a per-unit rent history',
      pagePath: '/rent',
    });
    expect(res.statusCode).toBe(201);
    const feedback = FeedbackSchema.parse(res.json());
    track(feedback.id);
    expect(feedback.pagePath).toBe('/rent');
  });

  it('writes no AuditLog row (not money/tenant-touching)', async () => {
    const before = await prisma.auditLog.count({ where: { accountId } });
    const res = await postFeedback({ category: 'other', message: 'Just saying hi' });
    expect(res.statusCode).toBe(201);
    track(FeedbackSchema.parse(res.json()).id);
    expect(await prisma.auditLog.count({ where: { accountId } })).toBe(before);
  });

  it('rejects blank/oversized messages and unknown categories with the validation envelope', async () => {
    const blank = await postFeedback({ category: 'bug', message: '' });
    expect(blank.statusCode).toBe(400);
    expect(blank.json().error.code).toBe('validation_error');

    const oversized = await postFeedback({ category: 'bug', message: 'x'.repeat(2001) });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json().error.code).toBe('validation_error');

    const badCategory = await postFeedback({ category: 'complaint', message: 'Nope' });
    expect(badCategory.statusCode).toBe(400);
    expect(badCategory.json().error.code).toBe('validation_error');
  });
});

describe('owner notification email — fire-and-forget', () => {
  it('emails FEEDBACK_NOTIFY_EMAIL with the submission details when set', async () => {
    process.env.FEEDBACK_NOTIFY_EMAIL = 'owner@example.com';
    const res = await postFeedback({
      category: 'bug',
      message: 'Dashboard totals disagree with the ledger',
      pagePath: '/dashboard',
    });
    expect(res.statusCode).toBe(201);
    track(FeedbackSchema.parse(res.json()).id);

    expect(sentEmails).toHaveLength(1);
    const email = sentEmails[0]!;
    expect(email.to).toBe('owner@example.com');
    expect(email.subject).toBe(
      '[554 Properties feedback] bug: Dashboard totals disagree with the ledger',
    );
    expect(email.body).toContain('Dashboard totals disagree with the ledger');
    expect(email.body).toContain('Page: /dashboard');
    expect(email.body).toContain('Submitted by: demo mode'); // no userId in demo mode
    expect(email.body).toContain(`Account: ${accountId}`);
    expect(email.body).toContain(`User agent: ${USER_AGENT}`);
  });

  it('still 201s and persists the row when the email send throws (never-throw)', async () => {
    // "fail" in the address triggers the mock adapter's simulated outage.
    process.env.FEEDBACK_NOTIFY_EMAIL = 'fail@example.com';
    const res = await postFeedback({ category: 'bug', message: 'Submitted during an outage' });
    expect(res.statusCode).toBe(201);
    const feedback = FeedbackSchema.parse(res.json());
    track(feedback.id);

    expect(sentEmails).toHaveLength(0);
    expect(await prisma.feedback.findUnique({ where: { id: feedback.id } })).not.toBeNull();
  });

  it('sends nothing when FEEDBACK_NOTIFY_EMAIL is unset', async () => {
    const res = await postFeedback({ category: 'idea', message: 'No notification expected' });
    expect(res.statusCode).toBe(201);
    track(FeedbackSchema.parse(res.json()).id);
    expect(sentEmails).toHaveLength(0);
  });
});

describe('feedback rate limiting', () => {
  it('429s with the ApiError envelope once the per-account limit is hit', async () => {
    // Read at route registration (chat-hardening.test.ts precedent) — needs a
    // fresh app instance to take effect.
    process.env.FEEDBACK_RATE_LIMIT_MAX = '2';
    const limitedApp = await buildApp();
    try {
      const post = () =>
        limitedApp.inject({
          method: 'POST',
          url: `${API}/feedback`,
          payload: { category: 'other', message: 'Rate limit probe' },
        });

      const first = await post();
      const second = await post();
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      track(first.json().id);
      track(second.json().id);

      const third = await post();
      expect(third.statusCode).toBe(429);
      expect(third.json().error.code).toBe('rate_limited');
    } finally {
      delete process.env.FEEDBACK_RATE_LIMIT_MAX;
      await limitedApp.close();
    }
  });
});
