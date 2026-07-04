// Real AiClient over @anthropic-ai/sdk streaming (ARCHITECTURE §6).
import Anthropic from '@anthropic-ai/sdk';
import type { AiClient, AiStreamParams, ProviderEvent } from './client';

const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 4096;

export class AnthropicAiClient implements AiClient {
  private readonly client = new Anthropic(); // reads ANTHROPIC_API_KEY

  async *stream(params: AiStreamParams): AsyncIterable<ProviderEvent> {
    const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
    const stream = this.client.messages.stream({
      model,
      max_tokens: MAX_TOKENS,
      system: params.system,
      messages: params.messages,
      tools: params.tools,
    });

    let pendingTool: { id: string; name: string; json: string } | null = null;
    let stopReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const ev of stream) {
      switch (ev.type) {
        case 'message_start':
          inputTokens = ev.message.usage.input_tokens;
          break;
        case 'content_block_start':
          if (ev.content_block.type === 'tool_use') {
            pendingTool = { id: ev.content_block.id, name: ev.content_block.name, json: '' };
          }
          break;
        case 'content_block_delta':
          if (ev.delta.type === 'text_delta') {
            yield { type: 'text_delta', text: ev.delta.text };
          } else if (ev.delta.type === 'input_json_delta' && pendingTool) {
            pendingTool.json += ev.delta.partial_json;
          }
          break;
        case 'content_block_stop':
          if (pendingTool) {
            yield {
              type: 'tool_use',
              id: pendingTool.id,
              name: pendingTool.name,
              input: pendingTool.json ? JSON.parse(pendingTool.json) : {},
            };
            pendingTool = null;
          }
          break;
        case 'message_delta':
          stopReason = ev.delta.stop_reason ?? stopReason;
          outputTokens = ev.usage.output_tokens; // cumulative per the SDK
          break;
      }
    }

    yield { type: 'usage', model, inputTokens, outputTokens };
    yield {
      type: 'stop',
      reason:
        stopReason === 'tool_use' ? 'tool_use' : stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn',
    };
  }
}
