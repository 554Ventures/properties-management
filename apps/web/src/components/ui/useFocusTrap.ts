import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface FocusTrapOptions {
  /** Lock body scroll while active (modal). Default true. */
  lockScroll?: boolean;
  /** Contain Tab within the container (modal). Default true. */
  trapTab?: boolean;
}

/**
 * Focus management for Modal/Drawer: moves focus into the container on open,
 * closes on Escape, and restores focus to the opener on close. By default it
 * also traps Tab and locks body scroll (a modal); a non-modal surface (e.g. the
 * chat drawer when docked beside the page at xl) can opt out of both so the
 * rest of the page stays scrollable and keyboard-reachable.
 */
export function useFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement>,
  onClose: () => void,
  options: FocusTrapOptions = {},
): void {
  const { lockScroll = true, trapTab = true } = options;
  const restoreRef = useRef<HTMLElement | null>(null);

  // Read the modal options via a ref so toggling them (e.g. on viewport resize)
  // doesn't re-run the effect and yank focus back into the container.
  const optionsRef = useRef({ lockScroll, trapTab });
  optionsRef.current = { lockScroll, trapTab };

  // Track the latest onClose without re-running the trap effect: callers'
  // onClose often closes over navigation state (setSearchParams) and changes
  // identity on every URL change — re-running mid-open would yank focus back
  // to the container's first focusable after e.g. an action-card navigate.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    restoreRef.current = document.activeElement as HTMLElement | null;
    const first = container.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? container).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !optionsRef.current.trapTab) return;
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (!firstEl || !lastEl) return;
      const current = document.activeElement;
      if (event.shiftKey && (current === firstEl || current === container)) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && current === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    const didLockScroll = optionsRef.current.lockScroll;
    if (didLockScroll) document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (didLockScroll) document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus();
    };
  }, [active, containerRef]);
}
