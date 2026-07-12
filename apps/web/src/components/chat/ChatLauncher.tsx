// Fixed launcher for the assistant drawer — bottom-right, above the mobile
// BottomTabBar. Hidden (but kept mounted) while the drawer is open so Esc can
// return focus to it (§8: "Esc closes and returns focus to the launcher").
import { useEffect, useRef } from 'react';
import { cx } from '../../lib/cx';
import { useChat } from '../../state/chat';
import { IconSparkle } from '../ui/icons';

export function ChatLauncher() {
  const { open, openDrawer } = useChat();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (wasOpen.current && !open) buttonRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={openDrawer}
      aria-label="Open Roost"
      className={cx(
        // bottom offset grows with the home-indicator inset (iOS shell) so the
        // launcher stays clear of the taller BottomTabBar; env() is 0 on web.
        'fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-40 grid h-12 w-12 place-items-center rounded-full border border-border-ai bg-surface text-ink-ai shadow-overlay transition-colors duration-fast hover:bg-surface-sunken md:bottom-6 md:right-6',
        open && 'hidden',
      )}
    >
      <IconSparkle size={20} />
    </button>
  );
}
