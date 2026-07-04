// ask_user_question block (PRD §9.4, ARCHITECTURE §8): inline tappable option
// cards — single-select as a role="radiogroup" with roving tabindex + arrow
// keys, multiSelect as a checkbox group — plus the "Other" free-text input
// (allowFreeText). After answering, the question stays in the transcript with
// the chosen option(s) marked and everything disabled.
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import type {
  AskUserQuestionAnswer,
  AskUserQuestionBlock as AskUserQuestionBlockData,
  AskUserQuestionOption,
} from '@hearth/shared';
import { cx } from '../../../lib/cx';
import { Button } from '../../ui/Button';
import { IconCheck } from '../../ui/icons';

export interface AskUserQuestionBlockProps {
  block: AskUserQuestionBlockData;
  /** The submitted answer, once there is one — freezes the block. */
  answered?: AskUserQuestionAnswer;
  /** True while the turn is paused waiting on this question. */
  active: boolean;
  onSubmit: (answer: AskUserQuestionAnswer) => void;
}

interface OptionCardProps {
  option: AskUserQuestionOption;
  role: 'radio' | 'checkbox';
  checked: boolean;
  disabled: boolean;
  tabIndex: number;
  onSelect: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  optionRef: (el: HTMLDivElement | null) => void;
}

function OptionCard({
  option,
  role,
  checked,
  disabled,
  tabIndex,
  onSelect,
  onKeyDown,
  optionRef,
}: OptionCardProps) {
  return (
    <div
      ref={optionRef}
      role={role}
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      tabIndex={tabIndex}
      onClick={disabled ? undefined : onSelect}
      onKeyDown={disabled ? undefined : onKeyDown}
      className={cx(
        'rounded-md border px-3 py-2 transition-colors duration-fast',
        checked ? 'border-border-ai bg-surface-ai' : 'border-border bg-surface',
        disabled
          ? cx('cursor-default', !checked && 'opacity-60')
          : 'cursor-pointer hover:border-border-strong',
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
        {checked && (
          <span className="text-ink-ai">
            <IconCheck size={14} />
          </span>
        )}
        {option.label}
      </span>
      <span className="mt-0.5 block text-xs text-ink-muted">{option.description}</span>
    </div>
  );
}

export function AskUserQuestionBlock({
  block,
  answered,
  active,
  onSubmit,
}: AskUserQuestionBlockProps) {
  const questionId = useId();
  const freeTextId = useId();
  const [selected, setSelected] = useState<string[]>([]);
  const [freeText, setFreeText] = useState('');
  const [focusIndex, setFocusIndex] = useState(0);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);

  const done = Boolean(answered);
  const disabled = done || !active;
  const checkedIds = answered ? answered.selectedOptionIds : selected;
  const canSubmit = selected.length > 0 || freeText.trim() !== '';

  const select = (optionId: string) => {
    if (block.multiSelect) {
      setSelected((prev) =>
        prev.includes(optionId) ? prev.filter((id) => id !== optionId) : [...prev, optionId],
      );
    } else {
      setSelected([optionId]);
    }
  };

  const focusOption = (index: number) => {
    setFocusIndex(index);
    optionRefs.current[index]?.focus();
  };

  /** Radiogroup keyboard support: arrows move focus, Space/Enter select. */
  const onRadioKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = block.options.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      focusOption((focusIndex + 1) % count);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      focusOption((focusIndex - 1 + count) % count);
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      const option = block.options[focusIndex];
      if (option) select(option.id);
    }
  };

  const onCheckboxKeyDown = (option: AskUserQuestionOption) => (event: KeyboardEvent) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      select(option.id);
    }
  };

  const submit = () => {
    if (!canSubmit || disabled) return;
    const answer: AskUserQuestionAnswer = { questionId: block.questionId, selectedOptionIds: selected };
    const trimmed = freeText.trim();
    if (trimmed !== '') answer.freeText = trimmed;
    onSubmit(answer);
  };

  return (
    <div className="rounded-md border border-border bg-surface p-3.5">
      {block.header && (
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-ai">{block.header}</p>
      )}
      <p id={questionId} className="mt-1 text-sm font-semibold text-ink">
        {block.question}
      </p>
      <div
        role={block.multiSelect ? 'group' : 'radiogroup'}
        aria-labelledby={questionId}
        onKeyDown={block.multiSelect || disabled ? undefined : onRadioKeyDown}
        className="mt-3 flex flex-col gap-2"
      >
        {block.options.map((option, index) => {
          const checked = checkedIds.includes(option.id);
          return (
            <OptionCard
              key={option.id}
              option={option}
              role={block.multiSelect ? 'checkbox' : 'radio'}
              checked={checked}
              disabled={disabled}
              tabIndex={
                disabled ? -1 : block.multiSelect ? 0 : index === focusIndex ? 0 : -1
              }
              onSelect={() => {
                if (!block.multiSelect) setFocusIndex(index);
                select(option.id);
              }}
              onKeyDown={block.multiSelect ? onCheckboxKeyDown(option) : undefined}
              optionRef={(el) => {
                optionRefs.current[index] = el;
              }}
            />
          );
        })}
      </div>
      <div className="mt-3 flex flex-col gap-1.5">
        <label htmlFor={freeTextId} className="text-xs font-medium text-ink-muted">
          Other — add detail (optional)
        </label>
        <input
          id={freeTextId}
          type="text"
          disabled={disabled}
          value={done ? (answered?.freeText ?? '') : freeText}
          onChange={(event) => setFreeText(event.target.value)}
          className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint disabled:opacity-60"
        />
      </div>
      {done ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-ink-muted">
          <span className="text-positive">
            <IconCheck size={14} />
          </span>
          Answered
        </p>
      ) : (
        <Button size="sm" className="mt-3" disabled={!canSubmit || disabled} onClick={submit}>
          Submit
        </Button>
      )}
    </div>
  );
}
