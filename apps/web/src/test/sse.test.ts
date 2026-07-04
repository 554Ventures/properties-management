// Unit tests for the SSE stream reader (api/sse.ts) against canned fixture
// streams: frame parsing across chunk boundaries, multi-line data, and the
// failure modes (bad JSON, early close, non-2xx response).
import type { SseEvent } from '@hearth/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postSse } from '../api/sse';

function streamResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    ...init,
  });
}

/** Runs postSse against a fixture stream and resolves once it settles. */
function collectEvents(response: Response): Promise<SseEvent[]> {
  vi.stubGlobal('fetch', vi.fn(async () => response));
  return new Promise((resolve) => {
    const events: SseEvent[] = [];
    postSse('/chat/sessions/s1/messages', { text: 'hi' }, {
      onEvent: (event) => {
        events.push(event);
        // Terminal per §5 — the reader never dispatches past these.
        if (
          event.event === 'message_complete' ||
          event.event === 'awaiting_input' ||
          event.event === 'error'
        ) {
          // Give the reader a beat so any (buggy) trailing dispatch would land.
          setTimeout(() => resolve(events), 10);
        }
      },
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('postSse', () => {
  it('parses a full event sequence, including frames split across chunks and multi-line data', async () => {
    const events = await collectEvents(
      streamResponse([
        // frame split mid-field-name and mid-JSON across chunk boundaries
        'event: message_start\nda',
        'ta: {"messageId":"m1"}\n\nevent: block_start\ndata: {"index":0,"blockType":"text"}\n\n',
        'event: text_delta\ndata: {"index":0,',
        '"delta":"Hello"}\n\n',
        // multi-line data: two data: lines joined with \n (valid JSON)
        'event: block_complete\ndata: {"index":0,\ndata: "block":{"type":"text","text":"Hello"}}\n\n',
        'event: tool_activity\ndata: {"name":"get_rent_status","status":"running"}\n\n',
        ': keep-alive comment\n\n',
        'event: message_complete\ndata: {"messageId":"m1"}\n\n',
      ]),
    );

    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'block_start',
      'text_delta',
      'block_complete',
      'tool_activity',
      'message_complete',
    ]);
    expect(events[0]?.data).toEqual({ messageId: 'm1' });
    expect(events[2]?.data).toEqual({ index: 0, delta: 'Hello' });
    expect(events[3]?.data).toEqual({
      index: 0,
      block: { type: 'text', text: 'Hello' },
    });
  });

  it('handles CRLF framing', async () => {
    const events = await collectEvents(
      streamResponse([
        'event: message_start\r\ndata: {"messageId":"m1"}\r\n\r',
        '\nevent: message_complete\r\ndata: {"messageId":"m1"}\r\n\r\n',
      ]),
    );
    expect(events.map((e) => e.event)).toEqual(['message_start', 'message_complete']);
  });

  it('ends cleanly on awaiting_input without a synthetic error', async () => {
    const events = await collectEvents(
      streamResponse([
        'event: message_start\ndata: {"messageId":"m1"}\n\n',
        'event: awaiting_input\ndata: {"messageId":"m1","questionIndex":1}\n\n',
      ]),
    );
    expect(events.map((e) => e.event)).toEqual(['message_start', 'awaiting_input']);
  });

  it('surfaces a server close without a terminal event as an error', async () => {
    const events = await collectEvents(
      streamResponse(['event: message_start\ndata: {"messageId":"m1"}\n\n']),
    );
    expect(events.map((e) => e.event)).toEqual(['message_start', 'error']);
    expect(events[1]?.data).toMatchObject({ message: expect.stringContaining('unexpectedly') });
  });

  it('surfaces malformed JSON as an error and stops', async () => {
    const events = await collectEvents(
      streamResponse([
        'event: message_start\ndata: {"messageId":"m1"}\n\n',
        'event: text_delta\ndata: {oops\n\n',
        'event: message_complete\ndata: {"messageId":"m1"}\n\n',
      ]),
    );
    expect(events.map((e) => e.event)).toEqual(['message_start', 'error']);
  });

  it('surfaces a non-2xx response using the API error envelope', async () => {
    const events = await collectEvents(
      new Response(
        JSON.stringify({ error: { code: 'not_found', message: 'Session not found' } }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    expect(events).toEqual([{ event: 'error', data: { message: 'Session not found' } }]);
  });

  it('POSTs the body to the versioned path with an event-stream Accept header', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      streamResponse(['event: message_complete\ndata: {"messageId":"m1"}\n\n']),
    );
    vi.stubGlobal('fetch', fetchMock);
    await new Promise<void>((resolve) => {
      postSse('/chat/sessions/s1/messages', { text: 'hi' }, {
        onEvent: (event) => {
          if (event.event === 'message_complete') resolve();
        },
      });
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/chat/sessions/s1/messages');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ text: 'hi' }));
    expect(new Headers(init.headers).get('Accept')).toBe('text/event-stream');
    expect(new Headers(init.headers).get('Authorization')).toBeNull();
  });

  it('attaches Authorization when VITE_DEV_BEARER_TOKEN is set', async () => {
    vi.stubEnv('VITE_DEV_BEARER_TOKEN', 'dev-token');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      streamResponse(['event: message_complete\ndata: {"messageId":"m1"}\n\n']),
    );
    vi.stubGlobal('fetch', fetchMock);
    await new Promise<void>((resolve) => {
      postSse('/chat/sessions/s1/messages', { text: 'hi' }, {
        onEvent: (event) => {
          if (event.event === 'message_complete') resolve();
        },
      });
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer dev-token');
  });

  it('routes a non-2xx response to onHttpError and suppresses the error event when handled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'conflict', message: 'awaiting answer' } }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const events: SseEvent[] = [];
    const httpErrors: Array<[number, string, string]> = [];
    await new Promise<void>((resolve) => {
      postSse('/chat/sessions/s1/messages', { text: 'hi' }, {
        onEvent: (event) => events.push(event),
        onHttpError: (status, code, message) => {
          httpErrors.push([status, code, message]);
          // Give the reader a beat so a (buggy) synthetic error would land.
          setTimeout(resolve, 10);
          return true;
        },
      });
    });

    expect(httpErrors).toEqual([[409, 'conflict', 'awaiting answer']]);
    expect(events).toEqual([]);
  });
});
