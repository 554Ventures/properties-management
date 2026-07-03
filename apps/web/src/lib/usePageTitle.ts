import { useEffect } from 'react';

/** Sets document.title to "Page · Hearth". */
export function usePageTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · Hearth` : 'Hearth';
  }, [title]);
}
