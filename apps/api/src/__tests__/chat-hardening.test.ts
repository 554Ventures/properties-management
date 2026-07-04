// Chat hardening (deployment plan §4.5): per-account rate limiting on
// turn-starting chat routes, and per-model-call token-usage logging.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runUserTurn, type UsageLog } from '../ai/agent-loop';
import { buildApp } from '../app';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import * as chatService from '../services/chat.service';

let app: FastifyInstance;
const createdSessionIds: string[] = [];

beforeAll(async () => {
  process.env.CHAT_RATE_LIMIT_MAX = '2'; // read at route registration
  app = await buildApp();
});

afterAll(async () => {
  delete process.env.CHAT_RATE_LIMIT_MAX;
  if (createdSessionIds.length > 0) {
    await prisma.chatSession.deleteMany({ where: { id: { in: createdSessionIds } } });
  }
  await app.close();
});

describe('chat rate limiting', () => {
  it('429s with the ApiError envelope once the per-account limit is hit', async () => {
    const post = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/chat/sessions',
        payload: {},
      });

    const first = await post();
    const second = await post();
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    createdSessionIds.push(first.json().id, second.json().id);

    const third = await post();
    expect(third.statusCode).toBe(429);
    const body = third.json();
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.message).toMatch(/retry/i);
  });

  it('does not limit chat reads', async () => {
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/v1/chat/sessions' });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe('token-usage logging', () => {
  it('logs one aiUsage entry per model call with account/session attribution', async () => {
    const accountId = await getDemoAccountId();
    const session = await chatService.createSession(accountId, {});
    createdSessionIds.push(session.id);

    const usageLines: Array<Record<string, unknown>> = [];
    const log: UsageLog = (data) => {
      if ('aiUsage' in data) usageLines.push(data.aiUsage as Record<string, unknown>);
    };

    const fresh = await prisma.chatSession.findUniqueOrThrow({ where: { id: session.id } });
    await runUserTurn({
      accountId,
      session: fresh,
      text: 'How is rent collection going this month?',
      emit: () => {},
      log,
    });

    // The mock script for this prompt runs tool calls, so the loop makes
    // multiple model calls — each one must produce a usage line.
    expect(usageLines.length).toBeGreaterThanOrEqual(2);
    for (const line of usageLines) {
      expect(line.accountId).toBe(accountId);
      expect(line.sessionId).toBe(session.id);
      expect(line.model).toBe('mock');
      expect(typeof line.messageId).toBe('string');
      expect(line.inputTokens as number).toBeGreaterThan(0);
      expect(line.outputTokens as number).toBeGreaterThanOrEqual(0);
    }
  });
});
