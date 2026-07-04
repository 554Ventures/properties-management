import { useEffect } from 'react';

/** Sets document.title to "Page · 554 Properties". */
export function usePageTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · 554 Properties` : '554 Properties';
  }, [title]);
}
