// Thinking blocks must survive the AiClient seam and be replayed verbatim in
// the assistant turn. Current models bind a thinking block to the conversation
// that produced it — the SDK's own types say "Thinking blocks must be passed
// back unmodified and in their original order; a modified block results in a
// 400 invalid_request_error". The agent loop rebuilds each assistant turn from
// provider events, so a block the seam cannot represent is a silent history
// edit that fails the NEXT tool iteration, not the current one.
//
// Two layers are covered: the provider adapter (SDK stream -> ProviderEvent)
// and the loop (ProviderEvent -> replayed assistant content).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const messagesStream = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { stream: messagesStream };
  },
}));

import { AnthropicAiClient } from '../ai/anthropic';
import type { ProviderEvent } from '../ai/client';

/** Minimal async-iterable stand-in for the SDK's stream. */
function sdkStream(events: Array<Record<string, unknown>>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev;
    },
  };
}

function messageStart() {
  return { type: 'message_start', message: { usage: { input_tokens: 10 } } };
}
function messageDelta(stopReason: string) {
  return {
    type: 'message_delta',
    delta: { stop_reason: stopReason },
    usage: { output_tokens: 5 },
  };
}

async function collect(events: Array<Record<string, unknown>>): Promise<ProviderEvent[]> {
  messagesStream.mockReturnValue(sdkStream(events));
  const out: ProviderEvent[] = [];
  for await (const ev of new AnthropicAiClient().stream({
    system: 'sys',
    messages: [],
    tools: [],
  })) {
    out.push(ev);
  }
  return out;
}

beforeEach(() => {
  messagesStream.mockReset();
});

afterEach(() => {
  delete process.env.ANTHROPIC_MODEL;
});

describe('AnthropicAiClient thinking blocks', () => {
  it('assembles a thinking block from its deltas and carries the signature verbatim', async () => {
    const events = await collect([
      messageStart(),
      { type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Let me ' } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'check rent.' } },
      { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'sig-abc123' } },
      { type: 'content_block_stop' },
      messageDelta('end_turn'),
    ]);

    expect(events).toContainEqual({
      type: 'thinking',
      block: { type: 'thinking', thinking: 'Let me check rent.', signature: 'sig-abc123' },
    });
  });

  it('passes a redacted_thinking block straight through', async () => {
    const events = await collect([
      messageStart(),
      {
        type: 'content_block_start',
        content_block: { type: 'redacted_thinking', data: 'enc-payload' },
      },
      { type: 'content_block_stop' },
      messageDelta('end_turn'),
    ]);

    expect(events).toContainEqual({
      type: 'thinking',
      block: { type: 'redacted_thinking', data: 'enc-payload' },
    });
  });

  it('keeps thinking, text and tool_use in their original order', async () => {
    const events = await collect([
      messageStart(),
      { type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
      { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 's1' } },
      { type: 'content_block_stop' },
      { type: 'content_block_start', content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Checking.' } },
      { type: 'content_block_stop' },
      {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'tu1', name: 'get_rent_status' },
      },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop' },
      messageDelta('tool_use'),
    ]);

    expect(events.map((e) => e.type)).toEqual([
      'thinking',
      'text_delta',
      'tool_use',
      'usage',
      'stop',
    ]);
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'tool_use' });
  });

  it('still emits a thinking block when display omits the text (the default)', async () => {
    // With display "omitted" the thinking text is empty but the signature is
    // not — and the signature is the part the API validates on replay.
    const events = await collect([
      messageStart(),
      { type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'sig-only' } },
      { type: 'content_block_stop' },
      messageDelta('end_turn'),
    ]);

    expect(events).toContainEqual({
      type: 'thinking',
      block: { type: 'thinking', thinking: '', signature: 'sig-only' },
    });
  });
});
