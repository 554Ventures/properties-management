// AiClient interface + factory (ARCHITECTURE §6). ProviderEvent mirrors the
// Anthropic SDK shapes so the real and mock clients are interchangeable and
// the agent loop never knows which one it is driving.
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { AnthropicAiClient } from './anthropic';
import { MockAiClient } from './mock';

export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'stop'; reason: 'end_turn' | 'tool_use' | 'max_tokens' };

export interface AiStreamParams {
  system: string;
  messages: MessageParam[];
  tools: Tool[];
}

export interface AiClient {
  stream(params: AiStreamParams): AsyncIterable<ProviderEvent>;
}

/** Real Anthropic client when ANTHROPIC_API_KEY is set, else the mock. */
export function createAiClient(): AiClient {
  return process.env.ANTHROPIC_API_KEY ? new AnthropicAiClient() : new MockAiClient();
}
