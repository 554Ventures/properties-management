// SSE reader for the two chat POST endpoints (ARCHITECTURE §3/§5). EventSource
// cannot POST, so this POSTs with fetch and parses the text/event-stream body
// off the ReadableStream: `event: <name>\ndata: <json>` frames separated by a
// blank line. Handles multi-line data, CRLF framing, and frames split across
// chunk boundaries. Transport failures — network errors, malformed JSON, or
// the server closing without a terminal event — are surfaced to the caller as
// a synthetic `error` event, so consumers handle exactly one event union.
import { SseEventNameSchema, type SseEvent, type SseEventName } from '@hearth/shared';

const BASE_URL = '/api/v1';

export interface SseHandlers {
  /** Every parsed wire event, including server-sent `error` events. */
  onEvent: (event: SseEvent) => void;
}

/** Events after which the server may legitimately close the stream (§5). */
const TERMINAL_EVENTS: ReadonlySet<SseEventName> = new Set([
  'message_complete',
  'awaiting_input',
  'error',
]);

/**
 * POSTs `body` to `path` (under /api/v1) and dispatches the SSE events from
 * the response stream to `handlers.onEvent`. Returns the AbortController so
 * the caller can cancel the stream; an aborted stream dispatches nothing.
 */
export function postSse(path: string, body: unknown, handlers: SseHandlers): AbortController {
  const controller = new AbortController();
  void readStream(path, body, handlers, controller);
  return controller;
}

async function readStream(
  path: string,
  body: unknown,
  handlers: SseHandlers,
  controller: AbortController,
): Promise<void> {
  let sawTerminal = false;

  const emit = (event: SseEvent) => {
    if (TERMINAL_EVENTS.has(event.event)) sawTerminal = true;
    handlers.onEvent(event);
  };

  const fail = (message: string) => {
    if (sawTerminal) return;
    emit({ event: 'error', data: { message } });
  };

  /** Parses one `event:`/`data:` frame; false stops the stream (bad JSON). */
  const processFrame = (frame: string): boolean => {
    let eventName = '';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue; // comment / keep-alive
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') eventName = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (!eventName && dataLines.length === 0) return true; // blank/comment frame
    const name = SseEventNameSchema.safeParse(eventName);
    if (!name.success) return true; // unknown event — ignored for forward compat
    let data: unknown;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      fail('The assistant sent a malformed event. Try again.');
      return false;
    }
    emit({ event: name.data, data } as SseEvent);
    return true;
  };

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Non-stream failure — the API's `{ error: { message } }` envelope.
      let message = `The assistant request failed (${res.status}).`;
      try {
        const parsed = (await res.json()) as { error?: { message?: string } };
        message = parsed.error?.message ?? message;
      } catch {
        // Non-JSON error body — keep the generic message.
      }
      fail(message);
      return;
    }

    if (!res.body) {
      fail('The assistant response had no body.');
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Normalize CRLF on the (small) unprocessed remainder so a CR/LF pair
      // split across two chunks still frames correctly.
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        if (!processFrame(frame)) {
          controller.abort();
          return;
        }
        separator = buffer.indexOf('\n\n');
      }
    }

    // Lenient flush: a final frame without a trailing blank line still counts.
    buffer = (buffer + decoder.decode()).replace(/\r\n/g, '\n');
    if (buffer.trim() && !processFrame(buffer)) return;

    if (!sawTerminal) fail('The assistant connection ended unexpectedly. Try again.');
  } catch {
    if (controller.signal.aborted) return; // caller cancelled — stay silent
    fail('Could not reach the Hearth assistant. Check your connection and try again.');
  }
}
