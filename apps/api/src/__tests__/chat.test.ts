// (g) Chat agent loop in mock mode over the real SSE endpoints: script frames,
// the full askUserQuestion pause/resume round-trip (incl. across a simulated
// server restart), 409 guards and real ids inside proposed actions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  ActionCardBlockSchema,
  AskUserQuestionBlockSchema,
  ChartBlockSchema,
  ChatMessageListResponseSchema,
  ChatSessionSchema,
  DataTableBlockSchema,
  type SseEventName,
} from '@hearth/shared';
import { OKAFOR_NAME } from '../../prisma/seed-constants';
import { buildApp } from '../app';
import { currentPeriod } from '../lib/dates';
import { getDemoAccountId } from '../plugins/auth';
import * as dashboardService from '../services/dashboard.service';
import * as rentService from '../services/rent.service';

let app: FastifyInstance;
let accountId: string;

beforeAll(async () => {
  delete process.env.ANTHROPIC_API_KEY; // force deterministic mock mode
  app = await buildApp();
  accountId = await getDemoAccountId();
});

afterAll(async () => {
  await app.close();
});

interface SseFrame {
  event: SseEventName;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

function parseSse(body: string): SseFrame[] {
  return body
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const event = chunk.match(/^event: (.+)$/m)?.[1];
      const data = chunk.match(/^data: (.+)$/m)?.[1];
      expect(event, `malformed SSE frame: ${chunk}`).toBeTruthy();
      expect(data, `malformed SSE frame: ${chunk}`).toBeTruthy();
      return { event: event as SseEventName, data: JSON.parse(data as string) };
    });
}

async function createSession(instance: FastifyInstance): Promise<string> {
  const res = await instance.inject({ method: 'POST', url: '/api/v1/chat/sessions', payload: {} });
  expect(res.statusCode).toBe(201);
  return ChatSessionSchema.parse(res.json()).id;
}

async function sendMessage(
  instance: FastifyInstance,
  sessionId: string,
  text: string,
): Promise<SseFrame[]> {
  const res = await instance.inject({
    method: 'POST',
    url: `/api/v1/chat/sessions/${sessionId}/messages`,
    payload: { text },
  });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toContain('text/event-stream');
  return parseSse(res.body);
}

async function getSessionStatus(instance: FastifyInstance, sessionId: string): Promise<string> {
  const res = await instance.inject({ method: 'GET', url: '/api/v1/chat/sessions' });
  const sessions = res.json() as Array<{ id: string; status: string }>;
  return sessions.find((s) => s.id === sessionId)?.status ?? 'missing';
}

describe('mock script 1 — cash flow chart over SSE', () => {
  it('streams the §5 event sequence with a valid ChartBlock built from seeded data', async () => {
    const sessionId = await createSession(app);
    const frames = await sendMessage(app, sessionId, 'How is my cash flow this month?');
    const events = frames.map((f) => f.event);

    // Order: message_start → tool_activity → text deltas → block_complete → message_complete.
    expect(events[0]).toBe('message_start');
    expect(events[events.length - 1]).toBe('message_complete');
    expect(frames[0]!.data.messageId).toBe(frames[frames.length - 1]!.data.messageId);

    const activity = frames
      .filter((f) => f.event === 'tool_activity')
      .map((f) => `${f.data.name}:${f.data.status}`);
    expect(activity).toEqual([
      'get_dashboard_kpis:running',
      'get_dashboard_kpis:done',
      'get_income_expense_series:running',
      'get_income_expense_series:done',
    ]);
    expect(events.indexOf('tool_activity')).toBeLessThan(events.indexOf('text_delta'));
    expect(events.indexOf('text_delta')).toBeLessThan(events.indexOf('block_complete'));
    expect(events.filter((e) => e === 'text_delta').length).toBeGreaterThan(3);

    const chartFrame = frames.find(
      (f) => f.event === 'block_complete' && f.data.block?.type === 'chart',
    );
    expect(chartFrame).toBeTruthy();
    const chart = ChartBlockSchema.parse(chartFrame!.data.block);
    expect(chart.kind).toBe('line');
    expect(chart.yUnit).toBe('usd');

    // Chart series data matches the seeded cashflow series exactly.
    const expected = await dashboardService.getIncomeExpenseSeries(accountId, 6);
    expect(chart.series.map((s) => s.label)).toEqual(['Income', 'Expenses']);
    expect(chart.series[0]!.colorRole).toBe('positive');
    expect(chart.series[1]!.colorRole).toBe('warning');
    expect(chart.series[0]!.points).toEqual(expected.map((m) => ({ x: m.month, y: m.incomeCents })));
    expect(chart.series[1]!.points).toEqual(expected.map((m) => ({ x: m.month, y: m.expenseCents })));

    // Persisted transcript: user text message + assistant message with text + chart.
    const messagesRes = await app.inject({
      method: 'GET',
      url: `/api/v1/chat/sessions/${sessionId}/messages`,
    });
    const messages = ChatMessageListResponseSchema.parse(messagesRes.json());
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('user');
    expect(messages[1]!.role).toBe('assistant');
    expect(messages[1]!.blocks.map((b) => b.type)).toEqual(['text', 'chart']);
    expect(await getSessionStatus(app, sessionId)).toBe('idle');
  });
});

describe('mock script 2 — the full askUserQuestion round-trip', () => {
  it('pauses on the question, then resumes across a fresh app instance', async () => {
    const sessionId = await createSession(app);
    const frames = await sendMessage(app, sessionId, 'I need help with my taxes');
    const events = frames.map((f) => f.event);

    // Paused turn: question block arrives whole, stream ends on awaiting_input.
    expect(events[0]).toBe('message_start');
    expect(events[events.length - 1]).toBe('awaiting_input');
    expect(events).not.toContain('message_complete');
    const messageId = frames[0]!.data.messageId as string;

    const questionFrame = frames.find((f) => f.event === 'block_complete');
    const question = AskUserQuestionBlockSchema.parse(questionFrame!.data.block);
    expect(question.multiSelect).toBe(false);
    expect(question.options.map((o) => o.id)).toEqual(['current_ytd', 'last_year', 'other']);
    expect(frames[frames.length - 1]!.data).toEqual({
      messageId,
      questionIndex: questionFrame!.data.index,
    });
    expect(await getSessionStatus(app, sessionId)).toBe('awaiting_user');

    // The partial assistant message (question block included) is persisted.
    const midMessages = ChatMessageListResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/v1/chat/sessions/${sessionId}/messages` })).json(),
    );
    expect(midMessages[1]!.blocks.map((b) => b.type)).toEqual(['ask_user_question']);

    // Simulate a server restart: answer through a brand-new app instance, so
    // the resume state must come entirely from ChatSession.providerStateJson.
    const app2 = await buildApp();
    try {
      const answerRes = await app2.inject({
        method: 'POST',
        url: `/api/v1/chat/sessions/${sessionId}/answer`,
        payload: { questionId: question.questionId, selectedOptionIds: ['current_ytd'] },
      });
      expect(answerRes.statusCode).toBe(200);
      const resumeFrames = parseSse(answerRes.body);
      const resumeEvents = resumeFrames.map((f) => f.event);

      // Same assistant turn continues on the new stream.
      expect(resumeFrames[0]!.data.messageId).toBe(messageId);
      expect(resumeEvents[resumeEvents.length - 1]).toBe('message_complete');
      const resumeActivity = resumeFrames
        .filter((f) => f.event === 'tool_activity' && f.data.status === 'done')
        .map((f) => f.data.name);
      expect(resumeActivity).toEqual(['generate_report', 'get_report']);

      const blocks = resumeFrames
        .filter((f) => f.event === 'block_complete')
        .map((f) => f.data.block);
      const table = DataTableBlockSchema.parse(blocks.find((b) => b.type === 'data_table'));
      expect(table.columns.map((c) => c.key)).toEqual(['property', 'rents', 'repairs', 'other', 'net']);
      expect(table.rows.length).toBeGreaterThan(0);

      const card = ActionCardBlockSchema.parse(blocks.find((b) => b.type === 'action_card'));
      const action = card.actions[0]!.action;
      expect(action.kind).toBe('navigate');
      // The navigate target points at the really-generated schedule_e report.
      const reportId = (action as { kind: 'navigate'; to: string }).to.replace('/reports/', '');
      const reportRes = await app2.inject({ method: 'GET', url: `/api/v1/reports/${reportId}` });
      expect(reportRes.statusCode).toBe(200);
      expect(reportRes.json()).toMatchObject({
        type: 'schedule_e',
        taxYear: new Date().getUTCFullYear(),
      });

      // The single assistant ChatMessage now carries ALL blocks: pre-pause + post-resume.
      const finalMessages = ChatMessageListResponseSchema.parse(
        (
          await app2.inject({ method: 'GET', url: `/api/v1/chat/sessions/${sessionId}/messages` })
        ).json(),
      );
      expect(finalMessages).toHaveLength(2);
      expect(finalMessages[1]!.id).toBe(messageId);
      expect(finalMessages[1]!.blocks.map((b) => b.type)).toEqual([
        'ask_user_question',
        'text',
        'data_table',
        'action_card',
      ]);
      expect(await getSessionStatus(app2, sessionId)).toBe('idle');
    } finally {
      await app2.close();
    }
  });
});

describe('409 guards', () => {
  it('rejects a new message while the session awaits an answer', async () => {
    const sessionId = await createSession(app);
    await sendMessage(app, sessionId, 'schedule e please'); // pauses on the question
    expect(await getSessionStatus(app, sessionId)).toBe('awaiting_user');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chat/sessions/${sessionId}/messages`,
      payload: { text: 'never mind' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'conflict' } });
  });

  it('rejects an answer on a session with no pending question', async () => {
    const sessionId = await createSession(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chat/sessions/${sessionId}/answer`,
      payload: { questionId: 'nope', selectedOptionIds: ['current_ytd'] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'conflict' } });
  });

  it('rejects an answer that references the wrong question', async () => {
    const sessionId = await createSession(app);
    await sendMessage(app, sessionId, 'help with taxes');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chat/sessions/${sessionId}/answer`,
      payload: { questionId: 'not-the-pending-one', selectedOptionIds: ['current_ytd'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'bad_request' } });
  });
});

describe('mock script 3 — late rent action card carries real rentPaymentIds', () => {
  it('proposes POST /rent/reminders with ids straight from the tracker', async () => {
    const tracker = await rentService.getMonthStatus(accountId, currentPeriod());
    const late = tracker.rows
      .filter((r) => r.status === 'late')
      .sort((a, b) => (b.daysLate ?? 0) - (a.daysLate ?? 0));
    expect(late.length).toBe(2); // seed: Okafor (6d) + Park (3d)
    expect(late[0]!.tenantName).toBe(OKAFOR_NAME);

    const sessionId = await createSession(app);
    const frames = await sendMessage(app, sessionId, 'Who is late on rent?');
    const blocks = frames.filter((f) => f.event === 'block_complete').map((f) => f.data.block);

    const table = DataTableBlockSchema.parse(blocks.find((b) => b.type === 'data_table'));
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]!.tenant).toBe(OKAFOR_NAME);
    expect(table.rows[0]!.late).toBe('6 days late');

    const card = ActionCardBlockSchema.parse(blocks.find((b) => b.type === 'action_card'));
    const primary = card.actions.find((a) => a.style === 'primary')!;
    expect(primary.label).toBe(`Send reminder to ${OKAFOR_NAME}`);
    expect(primary.action).toMatchObject({
      kind: 'api_call',
      method: 'POST',
      path: '/rent/reminders',
      body: { rentPaymentIds: [late[0]!.rentPaymentId] },
    });
    const secondary = card.actions.find((a) => a.style === 'secondary')!;
    expect(secondary.action).toMatchObject({
      body: { rentPaymentIds: late.map((r) => r.rentPaymentId) },
    });
  });
});
