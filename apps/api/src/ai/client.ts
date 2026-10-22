// AiClient interface + factory (ARCHITECTURE §6). ProviderEvent mirrors the
// Anthropic SDK shapes so the real and mock clients are interchangeable and
// the agent loop never knows which one it is driving.
import type {
  MessageParam,
  RedactedThinkingBlockParam,
  ThinkingBlockParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { AnthropicAiClient } from './anthropic';
import { MockAiClient } from './mock';

export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  // A completed thinking block, carried verbatim so the agent loop can replay
  // it in the assistant turn. Current models bind thinking blocks to the
  // conversation: a modified or dropped block is a 400 on the next tool
  // iteration. Never rendered to the user — `display` defaults to omitted, so
  // the text is usually empty and only the signature matters.
  | { type: 'thinking'; block: ThinkingBlockParam | RedactedThinkingBlockParam }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  // One per model call, before 'stop' — the agent loop logs it per account/
  // session for cost visibility (deployment plan §4.5). Mock mode reports
  // model 'mock' with character-estimate token counts.
  | { type: 'usage'; model: string; inputTokens: number; outputTokens: number }
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
