import { useEffect, useState } from 'react';

/**
 * Reactive `window.matchMedia` for a single query. Returns false during SSR and
 * when matchMedia is unavailable (jsdom without the test polyfill), and updates
 * on viewport changes. Used e.g. to switch the chat drawer between its docked
 * (xl) and overlay (below xl) modes.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
