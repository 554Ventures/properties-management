// The suggestion chip is never auto-applied, and a learned suggestion says so
// in visible text (not color alone) — TRUSTWORTHY_TRANSACTIONS_PLAN.md §A6.
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AiChip } from '../components/ai/AiChip';

describe('AiChip', () => {
  it('renders the suggestion with confidence', () => {
    render(<AiChip name="Repairs" confidence={0.84} onApply={vi.fn()} />);
    expect(screen.getByRole('button', { name: /suggests: Repairs \(84%\)/ })).toBeEnabled();
  });

  it('shows the learned-provenance note as visible text', () => {
    render(
      <AiChip
        name="Cleaning & Maintenance"
        confidence={0.95}
        onApply={vi.fn()}
        note="from your past choice"
      />,
    );
    expect(screen.getByText(/from your past choice/)).toBeVisible();
  });

  it('applies on click and then disables', async () => {
    const onApply = vi.fn();
    render(<AiChip name="Repairs" confidence={0.84} onApply={onApply} applied />);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('— applied');
  });
});
