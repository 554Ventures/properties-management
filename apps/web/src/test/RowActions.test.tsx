// RowActions collapseAfter: at md+ the first N actions stay inline and the
// rest move behind a "⋯" focus-trapped popover; below md the BottomSheet keeps
// listing every action, so collapseAfter changes nothing there.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RowActions, type RowAction } from '../components/ui/RowActions';

// The component reads `(min-width: 768px)` via useMediaQuery.
function stubViewport(desktop: boolean) {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
    return {
      matches: query === '(min-width: 768px)' ? desktop : false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    } as MediaQueryList;
  });
}

function makeActions(labels: string[]): { actions: RowAction[]; clicks: Record<string, number> } {
  const clicks: Record<string, number> = {};
  const actions = labels.map((label) => ({
    label,
    onClick: () => {
      clicks[label] = (clicks[label] ?? 0) + 1;
    },
  }));
  return { actions, clicks };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RowActions (desktop)', () => {
  it('renders every action inline by default — no overflow trigger', () => {
    stubViewport(true);
    const { actions } = makeActions(['Edit', 'Duplicate', 'Archive', 'Delete']);
    render(<RowActions context="12 Maple St" actions={actions} />);

    for (const label of ['Edit', 'Duplicate', 'Archive', 'Delete']) {
      expect(screen.getByRole('button', { name: `${label} — 12 Maple St` })).toBeInTheDocument();
    }
    expect(
      screen.queryByRole('button', { name: 'More actions for 12 Maple St' }),
    ).not.toBeInTheDocument();
  });

  it('keeps all actions inline when collapseAfter covers them', () => {
    stubViewport(true);
    const { actions } = makeActions(['Edit', 'Archive']);
    render(<RowActions context="Unit A" actions={actions} collapseAfter={2} />);

    expect(screen.getByRole('button', { name: 'Edit — Unit A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive — Unit A' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'More actions for Unit A' }),
    ).not.toBeInTheDocument();
  });

  it('collapses actions beyond collapseAfter into a popover and runs them from there', async () => {
    stubViewport(true);
    const { actions, clicks } = makeActions(['Edit', 'Duplicate', 'Archive', 'Delete']);
    render(<RowActions context="Unit A" actions={actions} collapseAfter={2} />);

    expect(screen.getByRole('button', { name: 'Edit — Unit A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Duplicate — Unit A' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive — Unit A' })).not.toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Unit A' }));

    const dialog = await screen.findByRole('dialog', { name: 'More actions for Unit A' });
    expect(dialog).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    expect(clicks.Archive).toBe(1);
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'More actions for Unit A' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('closes the popover on Escape and returns focus to the trigger', async () => {
    stubViewport(true);
    const { actions } = makeActions(['Edit', 'Archive', 'Delete']);
    render(<RowActions context="Unit A" actions={actions} collapseAfter={1} />);

    const trigger = screen.getByRole('button', { name: 'More actions for Unit A' });
    // A real click focuses the trigger; fireEvent doesn't, so do it explicitly —
    // the trap restores focus to whatever held it when the popover opened.
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole('dialog', { name: 'More actions for Unit A' });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'More actions for Unit A' }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe('RowActions (mobile)', () => {
  it('lists every action in the bottom sheet regardless of collapseAfter', async () => {
    stubViewport(false);
    const { actions, clicks } = makeActions(['Edit', 'Duplicate', 'Archive', 'Delete']);
    render(<RowActions context="Unit A" actions={actions} collapseAfter={2} />);

    // One "⋯" trigger, no inline action buttons.
    expect(screen.queryByRole('button', { name: 'Edit — Unit A' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Unit A' }));

    const sheet = await screen.findByRole('dialog', { name: 'Actions for Unit A' });
    expect(sheet).toBeInTheDocument();
    for (const label of ['Edit', 'Duplicate', 'Archive', 'Delete']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(clicks.Delete).toBe(1);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Actions for Unit A' })).not.toBeInTheDocument(),
    );
  });
});
