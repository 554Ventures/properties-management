// Keyboard operability for the ask_user_question block (PRD §9.4 / §8):
// radiogroup roving tabindex + arrow-key navigation, Space/Enter select,
// multiSelect checkbox toggling, submit gating, and the frozen answered state.
import type {
  AskUserQuestionAnswer,
  AskUserQuestionBlock as AskUserQuestionBlockData,
} from '@hearth/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AskUserQuestionBlock } from '../components/chat/blocks/AskUserQuestionBlock';

const singleSelect: AskUserQuestionBlockData = {
  type: 'ask_user_question',
  questionId: 'q1',
  header: 'Tax prep',
  question: 'Which tax year?',
  multiSelect: false,
  options: [
    { id: 'y2026', label: '2026 (year to date)', description: 'Everything confirmed so far.' },
    { id: 'y2025', label: '2025', description: 'The full 2025 tax year.' },
    { id: 'other', label: 'Other', description: 'Tell me which year you need.' },
  ],
  allowFreeText: true,
};

const multiSelect: AskUserQuestionBlockData = {
  ...singleSelect,
  questionId: 'q2',
  question: 'Which properties should the report cover?',
  multiSelect: true,
};

describe('AskUserQuestionBlock', () => {
  it('supports radiogroup arrow-key navigation and Space/Enter selection', () => {
    const onSubmit = vi.fn();
    render(<AskUserQuestionBlock block={singleSelect} active onSubmit={onSubmit} />);

    const group = screen.getByRole('radiogroup', { name: 'Which tax year?' });
    const radios = screen.getAllByRole('radio');
    // Roving tabindex: exactly one tab stop in the group.
    expect(radios[0]).toHaveAttribute('tabindex', '0');
    expect(radios[1]).toHaveAttribute('tabindex', '-1');
    expect(radios[2]).toHaveAttribute('tabindex', '-1');

    radios[0]?.focus();
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(radios[1]).toHaveFocus();
    expect(radios[1]).toHaveAttribute('tabindex', '0');
    expect(radios[0]).toHaveAttribute('tabindex', '-1');
    expect(radios[1]).toHaveAttribute('aria-checked', 'false');

    fireEvent.keyDown(group, { key: ' ' });
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');

    // Enter also selects; single-select swaps the choice.
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    fireEvent.keyDown(group, { key: 'Enter' });
    expect(radios[2]).toHaveAttribute('aria-checked', 'true');
    expect(radios[1]).toHaveAttribute('aria-checked', 'false');

    // Wraps from the last option back to the first.
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(radios[0]).toHaveFocus();
    fireEvent.keyDown(group, { key: 'ArrowUp' });
    expect(radios[2]).toHaveFocus();

    // Submit is enabled once there is a selection, and is keyboard-reachable.
    const submit = screen.getByRole('button', { name: 'Submit' });
    expect(submit).toBeEnabled();
    submit.focus();
    expect(submit).toHaveFocus();
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({ questionId: 'q1', selectedOptionIds: ['other'] });
  });

  it('keeps Submit disabled until a selection or free text is given', () => {
    const onSubmit = vi.fn();
    render(<AskUserQuestionBlock block={singleSelect} active onSubmit={onSubmit} />);

    const submit = screen.getByRole('button', { name: 'Submit' });
    expect(submit).toBeDisabled();

    // "Other" free text alone is a valid answer (PRD §9.4 fallback).
    fireEvent.change(screen.getByLabelText('Other — add detail (optional)'), {
      target: { value: '2023 — amended return' },
    });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({
      questionId: 'q1',
      selectedOptionIds: [],
      freeText: '2023 — amended return',
    });
  });

  it('renders multiSelect as a checkbox group with Space toggling', () => {
    const onSubmit = vi.fn();
    render(<AskUserQuestionBlock block={multiSelect} active onSubmit={onSubmit} />);

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(3);
    // Checkbox pattern: every option is its own tab stop.
    for (const checkbox of checkboxes) expect(checkbox).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(checkboxes[0]!, { key: ' ' });
    fireEvent.keyDown(checkboxes[1]!, { key: ' ' });
    expect(checkboxes[0]).toHaveAttribute('aria-checked', 'true');
    expect(checkboxes[1]).toHaveAttribute('aria-checked', 'true');

    // Space toggles off again.
    fireEvent.keyDown(checkboxes[1]!, { key: ' ' });
    expect(checkboxes[1]).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onSubmit).toHaveBeenCalledWith({ questionId: 'q2', selectedOptionIds: ['y2026'] });
  });

  it('freezes after answering: options disabled, chosen option stays marked', () => {
    const answered: AskUserQuestionAnswer = { questionId: 'q1', selectedOptionIds: ['y2025'] };
    render(
      <AskUserQuestionBlock
        block={singleSelect}
        answered={answered}
        active={false}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
    expect(screen.getByText('Answered')).toBeInTheDocument();

    const radios = screen.getAllByRole('radio');
    for (const radio of radios) {
      expect(radio).toHaveAttribute('aria-disabled', 'true');
      expect(radio).toHaveAttribute('tabindex', '-1');
    }
    expect(screen.getByRole('radio', { name: /^2025/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Other — add detail (optional)')).toBeDisabled();
  });
});
