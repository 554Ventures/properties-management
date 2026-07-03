// StatusBadge must always convey status as text, not color alone (PRD §6).
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from '../components/ui/StatusBadge';

describe('StatusBadge', () => {
  it('renders the status as visible text', () => {
    render(<StatusBadge tone="danger">6 days late</StatusBadge>);
    expect(screen.getByText('6 days late')).toBeVisible();
  });

  it('pairs the text with a decorative icon (color is reinforcement only)', () => {
    const { container } = render(<StatusBadge tone="positive">Full</StatusBadge>);
    expect(screen.getByText('Full')).toBeInTheDocument();
    const icon = container.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });
});
