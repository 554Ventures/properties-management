// Guards the modal-vs-non-modal options on useFocusTrap, plus the trap stack:
// with stacked dialogs only the topmost trap may handle Escape — every trap
// listens on `document` in the capture phase, where stopPropagation() can't
// stop sibling listeners, so without the stack one Escape closed them all.
// The chat drawer relies on lockScroll:false when docked (xl) so the page
// behind it stays scrollable.
import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFocusTrap } from '../components/ui/useFocusTrap';

function Trapped({ lockScroll, trapTab }: { lockScroll?: boolean; trapTab?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(true, ref, () => {}, { lockScroll, trapTab });
  return (
    <div ref={ref}>
      <button type="button">focusable</button>
    </div>
  );
}

// An always-active outer trap with a toggleable inner trap on top — the shape
// of DocumentUploadModal/ConfirmDialog opening above TransactionEditModal.
function Nested({
  inner,
  onOuterClose,
  onInnerClose,
}: {
  inner: boolean;
  onOuterClose: () => void;
  onInnerClose: () => void;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(true, outerRef, onOuterClose);
  useFocusTrap(inner, innerRef, onInnerClose);
  return (
    <div ref={outerRef}>
      <button type="button">outer</button>
      {inner && (
        <div ref={innerRef}>
          <button type="button">inner</button>
          <button type="button">inner-2</button>
        </div>
      )}
      <button type="button">outer-2</button>
    </div>
  );
}

afterEach(() => {
  document.body.style.overflow = '';
});

describe('useFocusTrap modal options', () => {
  it('locks body scroll by default (modal)', () => {
    render(<Trapped />);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('leaves body scroll unlocked when lockScroll is false (docked drawer)', () => {
    render(<Trapped lockScroll={false} trapTab={false} />);
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('restores the previous overflow when a modal trap unmounts', () => {
    const { unmount } = render(<Trapped lockScroll />);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).not.toBe('hidden');
  });
});

describe('useFocusTrap stacked traps', () => {
  it('Escape closes only the topmost trap; the outer trap takes over once it pops', () => {
    const onOuterClose = vi.fn();
    const onInnerClose = vi.fn();
    const { rerender } = render(
      <Nested inner onOuterClose={onOuterClose} onInnerClose={onInnerClose} />,
    );

    fireEvent.keyDown(screen.getByText('inner'), { key: 'Escape' });
    expect(onInnerClose).toHaveBeenCalledTimes(1);
    expect(onOuterClose).not.toHaveBeenCalled();

    // Inner dialog closed — its trap pops off the stack, so Escape now
    // reaches the outer trap.
    rerender(<Nested inner={false} onOuterClose={onOuterClose} onInnerClose={onInnerClose} />);
    fireEvent.keyDown(screen.getByText('outer'), { key: 'Escape' });
    expect(onInnerClose).toHaveBeenCalledTimes(1);
    expect(onOuterClose).toHaveBeenCalledTimes(1);
  });

  it('a lower trap never contains Tab — only the topmost wraps focus', () => {
    // jsdom has no layout, so offsetParent is always null — that would
    // collapse every trap's focusable list to just the active element and
    // mask the wrap decision under test.
    const offsetParent = vi
      .spyOn(HTMLElement.prototype, 'offsetParent', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.parentElement;
      });
    try {
      render(<Nested inner onOuterClose={() => {}} onInnerClose={() => {}} />);

      // Focus on the outer trap's last focusable: alone, the outer trap would
      // wrap Tab back to its first. With the inner trap topmost (and focus not
      // at the inner boundary), nothing may move.
      screen.getByText('outer-2').focus();
      fireEvent.keyDown(screen.getByText('outer-2'), { key: 'Tab' });
      expect(document.activeElement).toBe(screen.getByText('outer-2'));

      // The topmost trap still contains Tab: last focusable wraps to first.
      screen.getByText('inner-2').focus();
      fireEvent.keyDown(screen.getByText('inner-2'), { key: 'Tab' });
      expect(document.activeElement).toBe(screen.getByText('inner'));
    } finally {
      offsetParent.mockRestore();
    }
  });
});
