import type { ReactNode } from 'react';

/**
 * Persistent polite live region — mount it before async content (e.g. insight
 * cards) arrives so screen readers announce the new content (PRD §7.1).
 */
export function LiveRegion({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div aria-live="polite" className={className}>
      {children}
    </div>
  );
}
