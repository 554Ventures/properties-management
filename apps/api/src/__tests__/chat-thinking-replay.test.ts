// End-to-end guard for the thinking-block replay: when the model thinks and
// then calls a tool, the NEXT model call in the same turn must resend that
// thinking block verbatim inside the assistant message. Dropping it is a
// history edit, which current models answer with a 400.
//
// This is the regression that a unit test on the provider adapter cannot
// catch: the adapter can emit thinking events correctly while the loop still
// throws them away when it rebuilds `assistantContent`.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { ChatSessionSchema } from '@hearth/shared';

type FakeScript = Array<Record<string, unknown>>;
const scriptQueue: FakeScript[] = [];
/** Every `params` the loop handed to ai.stream(), in call order. */
const seenParams: Array<{ messages: Array<Record<string, unknown>> }> = [];

vi.mock('../ai/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/client')>();
  return {
    ...actual,
    createAiClient: () => ({
      async *stream(params: { messages: Array<Record<string, unknown>> }) {
        seenParams.push(params);
        const script = scriptQueue.shift();
        if (!script) throw new Error('FakeAiClient: no script queued');
        for (const ev of script) yield ev;
      },
    }),
  };
});

import { buildApp } from '../app';

let app: FastifyInstance;

beforeAll(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

const THINKING_BLOCK = {
  type: 'thinking',
  thinking: 'The user wants rent status; call the tool.',
  signature: 'sig-xyz-789',
};

describe('thinking blocks are replayed into the next model call', () => {
  it('resends the thinking block verbatim, before the tool_use, in the assistant turn', async () => {
    scriptQueue.length = 0;
    seenParams.length = 0;

    // Iteration 1: think, then call a real tool.
    scriptQueue.push([
      { type: 'thinking', block: THINKING_BLOCK },
      { type: 'tool_use', id: 'tu1', name: 'get_rent_status', input: {} },
      { type: 'usage', model: 'fake', inputTokens: 10, outputTokens: 5 },
      { type: 'stop', reason: 'tool_use' },
    ]);
    // Iteration 2: answer in text, ending the turn.
    scriptQueue.push([
      { type: 'text_delta', text: 'Rent is on track.' },
      { type: 'usage', model: 'fake', inputTokens: 20, outputTokens: 6 },
      { type: 'stop', reason: 'end_turn' },
    ]);

    const session = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/sessions',
      payload: {},
    });
    const sessionId = ChatSessionSchema.parse(session.json()).id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chat/sessions/${sessionId}/messages`,
      payload: { text: 'How is rent collection going?' },
    });
    expect(res.statusCode).toBe(200);

    // Two model calls: the tool call and the follow-up.
    expect(seenParams).toHaveLength(2);

    const assistantTurn = seenParams[1]!.messages.find((m) => m.role === 'assistant');
    expect(assistantTurn, 'second call must carry the assistant turn').toBeTruthy();

    const content = assistantTurn!.content as Array<Record<string, unknown>>;
    // Verbatim — a modified signature is rejected by the API.
    expect(content).toContainEqual(THINKING_BLOCK);
    // ...and in original order, ahead of the tool_use it preceded.
    const thinkingAt = content.findIndex((b) => b.type === 'thinking');
    const toolUseAt = content.findIndex((b) => b.type === 'tool_use');
    expect(thinkingAt).toBeGreaterThanOrEqual(0);
    expect(toolUseAt).toBeGreaterThan(thinkingAt);
  });

  it('does not leak thinking content into the SSE stream the user sees', async () => {
    scriptQueue.length = 0;
    seenParams.length = 0;
    scriptQueue.push([
      { type: 'thinking', block: THINKING_BLOCK },
      { type: 'text_delta', text: 'All good.' },
      { type: 'usage', model: 'fake', inputTokens: 10, outputTokens: 5 },
      { type: 'stop', reason: 'end_turn' },
    ]);

    const session = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/sessions',
      payload: {},
    });
    const sessionId = ChatSessionSchema.parse(session.json()).id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chat/sessions/${sessionId}/messages`,
      payload: { text: 'hi' },
    });

    expect(res.body).not.toContain('sig-xyz-789');
    expect(res.body).not.toContain('The user wants rent status');
    expect(res.body).toContain('All good.');
  });
});
