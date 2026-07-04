// Deterministic MockAiClient (ARCHITECTURE §6): matches the latest user
// message against ordered regex scripts and emits real tool_use events, so
// tools execute against the live service layer and every number comes from the
// seeded DB. Stateless — everything is derived from the messages[] transcript,
// which is what survives a pause (providerStateJson) and a server restart.
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { AiClient, AiStreamParams, ProviderEvent } from './client';
import { MOCK_SCRIPTS, type MockAnswer, type MockStepContext } from './mock-scripts';

const DELTA_DELAY_MS = 4;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The user's own words — a user message that is not a tool_result carrier. */
function realUserText(m: MessageParam): string | null {
  if (m.role !== 'user') return null;
  if (typeof m.content === 'string') return m.content;
  if (m.content.some((b) => b.type === 'tool_result')) return null;
  const texts = m.content.filter((b) => b.type === 'text').map((b) => b.text);
  return texts.length > 0 ? texts.join('\n') : null;
}

interface Transcript {
  userText: string;
  /** How many model turns have already happened since the user last spoke. */
  stepIndex: number;
  resultByName: Map<string, unknown>;
  answer: MockAnswer | null;
}

function analyze(messages: MessageParam[]): Transcript {
  let userText = '';
  let lastUserIdx = -1;
  messages.forEach((m, i) => {
    const text = realUserText(m);
    if (text !== null) {
      userText = text;
      lastUserIdx = i;
    }
  });

  let stepIndex = 0;
  const toolNameById = new Map<string, string>();
  const resultByName = new Map<string, unknown>();
  let answer: MockAnswer | null = null;

  messages.forEach((m, i) => {
    if (m.role === 'assistant') {
      if (i > lastUserIdx) stepIndex++;
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_use') toolNameById.set(b.id, b.name);
        }
      }
      return;
    }
    if (!Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue;
      const name = toolNameById.get(b.tool_use_id);
      if (!name) continue;
      const raw =
        typeof b.content === 'string'
          ? b.content
          : (b.content ?? [])
              .map((c) => (c.type === 'text' ? c.text : ''))
              .join('');
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // non-JSON results (e.g. "rendered") stay as strings
      }
      if (name === 'ask_user_question') answer = parsed as MockAnswer;
      else resultByName.set(name, parsed);
    }
  });

  return { userText, stepIndex, resultByName, answer };
}

export class MockAiClient implements AiClient {
  async *stream(params: AiStreamParams): AsyncIterable<ProviderEvent> {
    const { userText, stepIndex, resultByName, answer } = analyze(params.messages);
    // The last script matches everything, so `find` always succeeds.
    const script = MOCK_SCRIPTS.find((s) => s.pattern.test(userText))!;
    const step = script.steps[Math.min(stepIndex, script.steps.length - 1)]!;
    const ctx: MockStepContext = {
      userText,
      result: (name) => resultByName.get(name),
      answer,
    };
    let outputChars = 0;
    for (const ev of step(ctx)) {
      // Tiny delay per text delta so streaming UI is demoable.
      if (ev.type === 'text_delta') {
        await sleep(DELTA_DELAY_MS);
        outputChars += ev.text.length;
      }
      yield ev;
    }
    // Character-estimate usage (~4 chars/token) so the cost-logging pipeline
    // (deployment plan §4.5) is exercised end-to-end in mock mode too.
    yield {
      type: 'usage',
      model: 'mock',
      inputTokens: Math.ceil(JSON.stringify(params.messages).length / 4),
      outputTokens: Math.ceil(outputChars / 4),
    };
  }
}
