// Regression test for a production bug: real Claude tool_use calls sometimes
// omit the `type` discriminant on render tools (render_chart/render_table/
// propose_action/ask_user_question) because Anthropic tool-use argument
// generation isn't schema-constrained decoding — it doesn't reliably
// reproduce a `const`-only field that's redundant with the tool name. That
// used to throw an uncaught ZodError and crash the whole SSE turn. Fixed in
// agent-loop.ts/tools.ts by never asking the model for `type` and injecting
// it server-side; this test drives that path with a fake AiClient standing
// in for the real (non-mock) provider, since MockAiClient always gets it
// right and can't reproduce the bug.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  ActionCardBlockSchema,
  ChatSessionSchema,
  type SseEventName,
} from '@hearth/shared';

type FakeScript = Array<Record<string, unknown>>;
const scriptQueue: FakeScript[] = [];

vi.mock('../ai/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/client')>();
  return {
    ...actual,
    createAiClient: () => ({
      async *stream() {
        const script = scriptQueue.shift();
        if (!script) {
          throw new Error('FakeAiClient: no script queued — every ai.stream() call needs one');
        }
        for (const ev of script) yield ev;
      },
    }),
  };
});

import { anthropicToolDefs } from '../ai/tools';
import { buildApp } from '../app';

let app: FastifyInstance;

beforeAll(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  app = await buildApp();
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

async function createSession(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/chat/sessions', payload: {} });
  expect(res.statusCode).toBe(201);
  return ChatSessionSchema.parse(res.json()).id;
}

async function sendMessage(sessionId: string, text: string): Promise<SseFrame[]> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/chat/sessions/${sessionId}/messages`,
    payload: { text },
  });
  expect(res.statusCode).toBe(200);
  return parseSse(res.body);
}

async function getSessionStatus(sessionId: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/api/v1/chat/sessions' });
  const sessions = res.json() as Array<{ id: string; status: string }>;
  return sessions.find((s) => s.id === sessionId)?.status ?? 'missing';
}

describe('render tool schemas never ask the model to echo back `type`', () => {
  it.each(['render_chart', 'render_table', 'propose_action', 'ask_user_question'])(
    '%s input_schema omits the type discriminant',
    (name) => {
      const tool = anthropicToolDefs().find((t) => t.name === name);
      expect(tool).toBeTruthy();
      const schema = tool!.input_schema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(schema.properties ?? {}).not.toHaveProperty('type');
      expect(schema.required ?? []).not.toContain('type');
    },
  );
});

describe('propose_action tool_use omitting `type` (real Claude behavior)', () => {
  it('still renders a correctly-typed action_card instead of crashing the turn', async () => {
    const sessionId = await createSession();
    scriptQueue.push(
      [
        {
          type: 'tool_use',
          id: 'tu_missing_type',
          name: 'propose_action',
          input: {
            // No `type` field — this is exactly what triggered the bug in prod.
            title: 'Confirm rent reminder',
            actions: [
              { id: 'a1', label: 'Send', style: 'primary', action: { kind: 'navigate', to: '/rent' } },
            ],
          },
        },
      ],
      [{ type: 'text_delta', text: 'Done.' }],
    );

    const frames = await sendMessage(sessionId, 'anything');
    const events = frames.map((f) => f.event);
    expect(events).not.toContain('error');
    expect(events[events.length - 1]).toBe('message_complete');

    const cardFrame = frames.find(
      (f) => f.event === 'block_complete' && f.data.block?.type === 'action_card',
    );
    expect(cardFrame).toBeTruthy();
    const card = ActionCardBlockSchema.parse(cardFrame!.data.block);
    expect(card.title).toBe('Confirm rent reminder');

    expect(await getSessionStatus(sessionId)).toBe('idle');
  });
});

describe('a genuinely malformed render tool call (unrelated to `type`)', () => {
  it('degrades to a retryable tool_result error instead of aborting the SSE stream', async () => {
    const sessionId = await createSession();
    scriptQueue.push(
      [
        {
          type: 'tool_use',
          id: 'tu_bad_actions',
          name: 'propose_action',
          input: { title: 'Broken card', actions: [] }, // fails ActionCardActionSchema.min(1)
        },
      ],
      [{ type: 'text_delta', text: 'Let me try that differently.' }],
    );

    const frames = await sendMessage(sessionId, 'anything');
    const events = frames.map((f) => f.event);
    expect(events).not.toContain('error');
    expect(events).not.toContain('block_complete'); // the invalid card is never emitted
    expect(events[events.length - 1]).toBe('message_complete');
    expect(await getSessionStatus(sessionId)).toBe('idle');
  });
});
