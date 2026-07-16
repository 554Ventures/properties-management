// Tool-use agent loop with ask_user_question pause/resume (ARCHITECTURE §6).
// Drives an AiClient stream, forwards text as SSE deltas, executes service
// tools via the registry, validates render tools against the shared block
// schemas and persists the assistant turn as a ChatMessage.
import { randomUUID } from 'node:crypto';
import { type AskUserQuestionAnswer, type ContentBlock, type SseEventName } from '@hearth/shared';
import { ZodError } from 'zod';
import type {
  MessageParam,
  TextBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { ChatMessage as DbChatMessage, ChatSession as DbChatSession } from '@prisma/client';
import { currentPeriodInTz, startOfDayInTz } from '../lib/dates';
import { BadRequestError, ConflictError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { createAiClient } from './client';
import { buildSystemPrompt } from './prompts';
import {
  ASK_USER_QUESTION_TOOL,
  AskUserQuestionInputSchema,
  anthropicToolDefs,
  findRenderTool,
  findServiceTool,
} from './tools';

export type Emit = (event: SseEventName, data: unknown) => void;

/** Structured log sink (pino-compatible), used for per-call token usage
 *  (deployment plan §4.5). Routes pass the request logger. */
export type UsageLog = (data: Record<string, unknown>, message: string) => void;

const MAX_ITERATIONS = 8;

interface SessionContext {
  screen: string;
  entityId?: string;
}

/** Server-internal shape of ChatSession.providerStateJson. */
interface ProviderState {
  context?: SessionContext;
  paused?: {
    messages: MessageParam[];
    pendingToolUseId: string;
    questionId: string;
    blockIndex: number;
    assistantMessageId: string;
    /** tool_results already produced for sibling tool_use blocks in the paused batch. */
    completedToolResults: ToolResultBlockParam[];
  };
}

export function parseProviderState(json: string | null): ProviderState {
  if (!json) return {};
  try {
    return JSON.parse(json) as ProviderState;
  } catch {
    return {};
  }
}

/** Rebuild provider history from persisted messages (text blocks only), merging
 *  consecutive same-role turns so the transcript alternates. */
function buildHistory(rows: DbChatMessage[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const row of rows) {
    const blocks = JSON.parse(row.blocksJson) as ContentBlock[];
    const text = blocks
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n\n');
    if (!text) continue;
    const role = row.role as 'user' | 'assistant';
    const last = out[out.length - 1];
    if (last && last.role === role && typeof last.content === 'string') {
      last.content = `${last.content}\n\n${text}`;
    } else if (out.length > 0 || role === 'user') {
      out.push({ role, content: text });
    }
  }
  return out;
}

interface LoopParams {
  accountId: string;
  sessionId: string;
  assistantMessageId: string;
  context: SessionContext | undefined;
  messages: MessageParam[];
  blocks: ContentBlock[];
  emit: Emit;
  log?: UsageLog;
  // Write tools the acting member lacks permission to run (docs/WHATS_NEXT.md §4);
  // empty for owners/demo mode. Denied calls return a tool error instead of
  // executing, so the assistant can't bypass a REST guard.
  deniedTools?: ReadonlySet<string>;
}

async function finalize(params: LoopParams): Promise<void> {
  await prisma.chatMessage.update({
    where: { id: params.assistantMessageId },
    data: { blocksJson: JSON.stringify(params.blocks) },
  });
  await prisma.chatSession.update({
    where: { id: params.sessionId },
    data: {
      status: 'idle',
      providerStateJson: params.context ? JSON.stringify({ context: params.context }) : null,
    },
  });
}

async function runLoop(params: LoopParams): Promise<void> {
  const { accountId, sessionId, assistantMessageId, context, blocks, emit } = params;
  let messages = params.messages;

  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const [propertyCount, unitCount] = await Promise.all([
    prisma.property.count({ where: { accountId } }),
    prisma.unit.count({ where: { property: { accountId } } }),
  ]);
  const system = buildSystemPrompt({
    accountName: account.name,
    propertyCount,
    unitCount,
    // "Today"/"current period" for the assistant match the landlord's local
    // calendar (WS4) so its answers line up with the tz-bucketed tool data.
    todayIso: startOfDayInTz(new Date(), account.timezone).toISOString().slice(0, 10),
    period: currentPeriodInTz(account.timezone),
    ...(context ? { screen: context } : {}),
  });
  const tools = anthropicToolDefs();
  const ai = createAiClient();

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const assistantContent: Array<TextBlockParam | ToolUseBlockParam> = [];
    const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
    let text = '';
    let textIndex = -1;

    const flushText = (): void => {
      if (!text) return;
      blocks.push({ type: 'text', text });
      assistantContent.push({ type: 'text', text });
      text = '';
      textIndex = -1;
    };

    try {
      for await (const ev of ai.stream({ system, messages, tools })) {
        if (ev.type === 'text_delta') {
          if (text === '') {
            textIndex = blocks.length;
            emit('block_start', { index: textIndex, blockType: 'text' });
          }
          text += ev.text;
          emit('text_delta', { index: textIndex, delta: ev.text });
        } else if (ev.type === 'tool_use') {
          flushText();
          assistantContent.push({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
          toolUses.push(ev);
        } else if (ev.type === 'usage') {
          // One line per model call — the runaway-loop early-warning signal.
          params.log?.(
            {
              aiUsage: {
                accountId,
                sessionId,
                messageId: assistantMessageId,
                iteration,
                model: ev.model,
                inputTokens: ev.inputTokens,
                outputTokens: ev.outputTokens,
              },
            },
            'ai token usage',
          );
        }
        // 'stop' carries no extra work: no tool_use in the batch means we are done.
      }
    } finally {
      // Also runs on a mid-stream provider error, so text accumulated since the
      // last flush lands in `blocks` and survives the guarded finalize().
      flushText();
    }

    if (toolUses.length === 0) break;

    messages = [...messages, { role: 'assistant', content: assistantContent }];
    const toolResults: ToolResultBlockParam[] = [];

    for (const tu of toolUses) {
      if (tu.name === ASK_USER_QUESTION_TOOL) {
        const input = AskUserQuestionInputSchema.parse(tu.input);
        const block: ContentBlock = {
          ...input,
          type: 'ask_user_question',
          questionId: randomUUID(),
          allowFreeText: true,
        };
        const index = blocks.length;
        blocks.push(block);
        emit('block_complete', { index, block });

        const state: ProviderState = {
          ...(context ? { context } : {}),
          paused: {
            messages,
            pendingToolUseId: tu.id,
            questionId: block.questionId,
            blockIndex: index,
            assistantMessageId,
            completedToolResults: toolResults,
          },
        };
        await prisma.chatMessage.update({
          where: { id: assistantMessageId },
          data: { blocksJson: JSON.stringify(blocks) },
        });
        await prisma.chatSession.update({
          where: { id: sessionId },
          data: { status: 'awaiting_user', providerStateJson: JSON.stringify(state) },
        });
        emit('awaiting_input', { messageId: assistantMessageId, questionIndex: index });
        return; // end the stream without a tool_result for the question
      }

      const render = findRenderTool(tu.name);
      if (render) {
        try {
          const input = render.inputSchema.parse(tu.input) as Omit<ContentBlock, 'type'>;
          const block = { ...input, type: render.blockType } as ContentBlock;
          const index = blocks.length;
          blocks.push(block);
          emit('block_complete', { index, block });
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'rendered' });
        } catch (err) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: err instanceof ZodError ? JSON.stringify(err.issues) : 'invalid tool input',
            is_error: true,
          });
        }
        continue;
      }

      const tool = findServiceTool(tu.name);
      if (!tool) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `Unknown tool: ${tu.name}`,
          is_error: true,
        });
        continue;
      }
      // Authorization: a member without the matching grant can't run this
      // write tool via chat (mirrors the REST route guard).
      if (tool.write && params.deniedTools?.has(tool.name)) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `You don't have permission to run ${tu.name} on this account. Ask the account owner to grant it.`,
          is_error: true,
        });
        emit('tool_activity', { name: tu.name, status: 'done' });
        continue;
      }
      emit('tool_activity', { name: tu.name, status: 'running' });
      try {
        const input = tool.inputSchema.parse(tu.input ?? {});
        // The model invoked this write itself → audit actor 'system'. When the
        // user clicks an action_card instead, that goes through REST as 'user'.
        const result = await tool.execute(accountId, input, 'system');
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result ?? null),
        });
      } catch (err) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: err instanceof Error ? err.message : 'tool execution failed',
          is_error: true,
        });
      }
      emit('tool_activity', { name: tu.name, status: 'done' });
    }

    messages = [...messages, { role: 'user', content: toolResults }];
  }

  await finalize({ ...params, messages });
  emit('message_complete', { messageId: assistantMessageId });
}

/** Shared error path: persist whatever completed, set idle, surface the error. */
async function guarded(params: LoopParams): Promise<void> {
  try {
    await runLoop(params);
  } catch (err) {
    await finalize(params).catch(() => undefined);
    params.emit('error', {
      message: err instanceof Error ? err.message : 'Something went wrong',
    });
  }
}

// ── entry points ──────────────────────────────────────────────────────────────

export async function runUserTurn(opts: {
  accountId: string;
  session: DbChatSession;
  text: string;
  emit: Emit;
  log?: UsageLog;
  deniedTools?: ReadonlySet<string>;
}): Promise<void> {
  const { accountId, session, text, emit } = opts;
  const state = parseProviderState(session.providerStateJson);

  await prisma.chatMessage.create({
    data: {
      sessionId: session.id,
      role: 'user',
      blocksJson: JSON.stringify([{ type: 'text', text }]),
    },
  });
  const history = await prisma.chatMessage.findMany({
    where: { sessionId: session.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const assistantMessage = await prisma.chatMessage.create({
    data: { sessionId: session.id, role: 'assistant', blocksJson: '[]' },
  });
  await prisma.chatSession.update({
    where: { id: session.id },
    data: { status: 'running', ...(session.title ? {} : { title: text.slice(0, 80) }) },
  });

  emit('message_start', { messageId: assistantMessage.id });
  await guarded({
    accountId,
    sessionId: session.id,
    assistantMessageId: assistantMessage.id,
    context: state.context,
    messages: buildHistory(history),
    blocks: [],
    emit,
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.deniedTools ? { deniedTools: opts.deniedTools } : {}),
  });
}

export interface PreparedResume {
  context: SessionContext | undefined;
  messages: MessageParam[];
  blocks: ContentBlock[];
  assistantMessageId: string;
}

/** Validate the answer against the paused state (throws 4xx before the SSE
 *  stream starts) and build the resume transcript with the tool_result. */
export async function prepareResume(
  session: DbChatSession,
  answer: AskUserQuestionAnswer,
): Promise<PreparedResume> {
  const state = parseProviderState(session.providerStateJson);
  const paused = state.paused;
  if (!paused) throw new ConflictError('session has no pending question');
  if (answer.questionId !== paused.questionId) {
    throw new BadRequestError('answer does not reference the pending question');
  }

  const assistantMessage = await prisma.chatMessage.findUniqueOrThrow({
    where: { id: paused.assistantMessageId },
  });
  const blocks = JSON.parse(assistantMessage.blocksJson) as ContentBlock[];
  const question = blocks[paused.blockIndex];
  if (!question || question.type !== 'ask_user_question') {
    throw new ConflictError('pending question block not found');
  }
  if (!question.multiSelect && answer.selectedOptionIds.length > 1) {
    throw new BadRequestError('this question accepts a single selection');
  }
  if (answer.selectedOptionIds.length === 0 && !answer.freeText) {
    throw new BadRequestError('select an option or provide freeText');
  }
  const labelById = new Map(question.options.map((o) => [o.id, o.label]));
  const selected = answer.selectedOptionIds.map((id) => {
    const label = labelById.get(id);
    if (!label) throw new BadRequestError(`unknown option id: ${id}`);
    return label;
  });

  // The answer lands as a tool_result — a hard constraint the model cannot
  // ignore — alongside any sibling tool_results completed before the pause.
  const messages: MessageParam[] = [
    ...paused.messages,
    {
      role: 'user',
      content: [
        ...paused.completedToolResults,
        {
          type: 'tool_result',
          tool_use_id: paused.pendingToolUseId,
          content: JSON.stringify({ selected, freeText: answer.freeText ?? null }),
        },
      ],
    },
  ];
  return {
    context: state.context,
    messages,
    blocks,
    assistantMessageId: paused.assistantMessageId,
  };
}

/** Continue the SAME assistant turn on a fresh SSE stream. */
export async function resumeTurn(opts: {
  accountId: string;
  session: DbChatSession;
  prepared: PreparedResume;
  emit: Emit;
  log?: UsageLog;
  deniedTools?: ReadonlySet<string>;
}): Promise<void> {
  const { accountId, session, prepared, emit } = opts;
  const state = parseProviderState(session.providerStateJson);
  await prisma.chatSession.update({
    where: { id: session.id },
    data: {
      status: 'running',
      providerStateJson: state.context ? JSON.stringify({ context: state.context }) : null,
    },
  });
  emit('message_start', { messageId: prepared.assistantMessageId });
  await guarded({
    accountId,
    sessionId: session.id,
    assistantMessageId: prepared.assistantMessageId,
    context: prepared.context,
    messages: prepared.messages,
    blocks: prepared.blocks,
    emit,
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.deniedTools ? { deniedTools: opts.deniedTools } : {}),
  });
}
