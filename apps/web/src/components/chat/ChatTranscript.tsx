// Transcript: user bubbles right (brand-tinted), assistant content left
// inside AiSurface (every AI-authored surface flows through it, PRD §6).
// Auto-scrolls to the newest content unless the user scrolled up ("Jump to
// latest"). Screen-reader announcements happen through a single polite live
// region fed only on block_complete / message_complete — never per token.
import { Fragment, useEffect, useRef, useState, type UIEvent } from 'react';
import type { ChatMessage, ContentBlock } from '@hearth/shared';
import { formatDateTime } from '../../lib/format';
import { useChat } from '../../state/chat';
import { AiSurface } from '../ai/AiSurface';
import { ActionCardBlock } from './blocks/ActionCardBlock';
import { AskUserQuestionBlock } from './blocks/AskUserQuestionBlock';
import { ChartBlock } from './blocks/ChartBlock';
import { DataTableBlock } from './blocks/DataTableBlock';
import { TextBlock } from './blocks/TextBlock';

const SEPARATOR_GAP_MS = 10 * 60_000;
const STICK_THRESHOLD_PX = 48;

function BlockView({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case 'text':
      return <TextBlock block={block} />;
    case 'chart':
      return <ChartBlock block={block} />;
    case 'data_table':
      return <DataTableBlock block={block} />;
    case 'action_card':
      return <ActionCardBlock block={block} />;
    case 'ask_user_question':
      return <WiredQuestion block={block} />;
  }
}

function WiredQuestion({ block }: { block: Extract<ContentBlock, { type: 'ask_user_question' }> }) {
  const { answers, answer, status } = useChat();
  return (
    <AskUserQuestionBlock
      block={block}
      answered={answers[block.questionId]}
      active={status === 'awaiting_input'}
      onSubmit={answer}
    />
  );
}

function UserBubble({ message }: { message: ChatMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-brand-soft px-3.5 py-2.5 text-sm leading-relaxed text-ink">
        {message.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n')}
      </div>
    </div>
  );
}

function AssistantMessage({ message, thinking }: { message: ChatMessage; thinking: boolean }) {
  const blocks = message.blocks.filter(
    (block) => !(block.type === 'text' && block.text.trim() === ''),
  );
  return (
    <div className="flex justify-start">
      <AiSurface className="min-w-0 flex-1">
        <div className="flex flex-col gap-3">
          {blocks.map((block, index) => (
            <BlockView key={index} block={block} />
          ))}
          {blocks.length === 0 && thinking && (
            <p className="animate-pulse text-sm text-ink-muted">Thinking…</p>
          )}
        </div>
      </AiSurface>
    </div>
  );
}

function needsSeparator(previous: ChatMessage | undefined, message: ChatMessage): boolean {
  if (!previous) return true;
  return (
    new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() >
    SEPARATOR_GAP_MS
  );
}

export function ChatTranscript() {
  const { messages, status, announcement } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);

  // Follow new content only while the user is at (or near) the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [messages, status, stick]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setStick(true);
  };

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex h-full flex-col gap-4 overflow-y-auto px-4 py-4"
      >
        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <span aria-hidden="true" className="text-2xl text-ink-ai">
              ✦
            </span>
            <p className="text-sm font-semibold text-ink">
              Ask Hearth anything about your rentals
            </p>
            <p className="text-sm text-ink-muted">
              Cash flow, late rent, tax prep — or add & edit properties, tenants, and transactions. Every answer comes straight from your ledger.
            </p>
          </div>
        ) : (
          messages.map((message, index) => (
            <Fragment key={message.id}>
              {needsSeparator(messages[index - 1], message) && (
                <p className="text-center text-xs text-ink-faint">
                  {formatDateTime(message.createdAt)}
                </p>
              )}
              {message.role === 'user' ? (
                <UserBubble message={message} />
              ) : (
                <AssistantMessage message={message} thinking={status === 'streaming'} />
              )}
            </Fragment>
          ))
        )}
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {!stick && messages.length > 0 && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-surface-raised px-3 py-1.5 text-xs font-medium text-ink shadow-overlay transition-colors duration-fast hover:bg-surface-sunken"
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}
