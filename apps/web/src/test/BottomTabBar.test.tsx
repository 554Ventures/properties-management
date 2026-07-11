// Mobile bottom tab bar: the 5 primary tabs are always visible, and the "More"
// sheet reveals every overflow destination so nothing in the desktop sidebar is
// unreachable on mobile.
import { fireEvent, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { BottomTabBar } from '../components/shell/BottomTabBar';

function renderBar(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <BottomTabBar />
    </MemoryRouter>,
  );
}

describe('BottomTabBar', () => {
  it('shows the five primary tabs and hides overflow destinations until "More" is opened', () => {
    renderBar();

    // Primary destination tabs + the quick-add link are always visible.
    for (const label of ['Home', 'Money', 'Add', 'Rent']) {
      expect(screen.getByRole('link', { name: label })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'More' })).toBeTruthy();

    // Overflow destinations are not in the DOM before opening the sheet.
    expect(screen.queryByRole('link', { name: 'Properties' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Documents' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a labelled dialog exposing all overflow destinations + Settings', async () => {
    renderBar();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    const dialog = await screen.findByRole('dialog', { name: 'More menu' });
    for (const label of [
      'Properties',
      'Tenants & Leases',
      'Maintenance',
      'Documents',
      'Reports & Tax',
      'Settings',
    ]) {
      expect(within(dialog).getByRole('link', { name: new RegExp(label) })).toBeTruthy();
    }

    // No axe violations in the open sheet.
    const results = await axe.run(dialog, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it('marks the "More" tab expanded while the sheet is open and collapses on close', async () => {
    renderBar();
    const moreButton = screen.getByRole('button', { name: 'More' });
    expect(moreButton).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(moreButton);
    await screen.findByRole('dialog');
    expect(moreButton).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'false');
  });
});
