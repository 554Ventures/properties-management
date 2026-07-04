// Message composer: autosizing textarea (1–4 rows), Enter sends /
// Shift+Enter inserts a newline. Disabled while a turn is streaming or paused
// on a question (§5 awaiting_input — only the option chips are interactive).
// Suggested prompts (matching the backend's mock scripts) seed an empty
// transcript so the offline demo has one-tap entry points.
import { useId, useState, type KeyboardEvent } from 'react';
import { useChat } from '../../state/chat';
import { Button } from '../ui/Button';
import { IconArrowUpRight } from '../ui/icons';

const SUGGESTED_PROMPTS = [
  'How is my cash flow?',
  'Help me get ready for taxes',
  "Who's late on rent?",
];

export function ChatComposer() {
  const { send, status, messages } = useChat();
  const [text, setText] = useState('');
  const hintId = useId();

  const awaiting = status === 'awaiting_input';
  const disabled = status === 'streaming' || awaiting;
  const rows = Math.min(4, Math.max(1, text.split('\n').length));

  const submit = () => {
    if (disabled || text.trim() === '') return;
    send(text);
    setText('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-border px-4 py-3">
      {messages.length === 0 && status === 'idle' && (
        <div className="mb-3 flex flex-wrap gap-2">
          {SUGGESTED_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => send(prompt)}
              className="rounded-full border border-border-ai bg-surface-ai px-3 py-1.5 text-xs font-medium text-ink-ai transition-colors duration-fast hover:bg-surface"
            >
              {prompt}
            </button>
          ))}
        </div>
      )}
      {awaiting && (
        <p id={hintId} className="mb-2 text-xs text-ink-muted">
          Answer the question above to continue.
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex items-end gap-2"
      >
        <label htmlFor="chat-composer" className="sr-only">
          Message the Hearth assistant
        </label>
        <textarea
          id="chat-composer"
          rows={rows}
          value={text}
          disabled={disabled}
          aria-describedby={awaiting ? hintId : undefined}
          placeholder="Ask about your properties…"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          className="flex-1 resize-none rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint transition-colors duration-fast hover:border-ink-muted disabled:opacity-50"
        />
        <Button
          type="submit"
          aria-label="Send message"
          disabled={disabled || text.trim() === ''}
        >
          <IconArrowUpRight />
        </Button>
      </form>
    </div>
  );
}
