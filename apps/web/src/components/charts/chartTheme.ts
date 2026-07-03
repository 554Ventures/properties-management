import type { CSSProperties } from 'react';

// The single place the chart colorRole → color mapping is resolved. Colors
// come from the --chart-* tokens; hex fallbacks (same values as tokens.css
// light mode) cover non-browser environments (tests).
export type ChartRole = 'positive' | 'warning' | 'neutral' | 'ai';

const FALLBACKS: Record<ChartRole, string> = {
  positive: '#15803d',
  warning: '#c05a10',
  neutral: '#64748b',
  ai: '#7c3aed',
};

function readToken(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function chartColor(role: ChartRole): string {
  return readToken(`--chart-${role}`, FALLBACKS[role]);
}

export function chartGridColor(): string {
  return readToken('--chart-grid', '#e6dfd4');
}

export function chartTextColor(): string {
  return readToken('--color-text-muted', '#6b6157');
}

/** Shared Recharts tooltip style built from surface tokens. */
export const tooltipStyle: CSSProperties = {
  backgroundColor: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--color-text)',
  fontSize: '0.75rem',
  boxShadow: '0 8px 20px -8px rgb(28 25 23 / 0.3)',
};
