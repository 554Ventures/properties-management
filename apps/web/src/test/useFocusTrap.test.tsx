// Guards the modal-vs-non-modal options on useFocusTrap. The chat drawer relies
// on lockScroll:false when docked (xl) so the page behind it stays scrollable.
import { render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
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
