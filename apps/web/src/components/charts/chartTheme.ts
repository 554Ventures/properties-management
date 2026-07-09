import type { CSSProperties } from 'react';

// The single place the chart colorRole → color mapping is resolved. Colors
// come from the --chart-* tokens; hex fallbacks (same values as tokens.css
// light mode) cover non-browser environments (tests).
export type ChartRole =
  | 'positive'
  | 'warning'
  | 'neutral'
  | 'ai'
  | 'cat-1'
  | 'cat-2'
  | 'cat-3'
  | 'cat-4'
  | 'cat-5'
  | 'cat-6'
  | 'cat-7'
  | 'cat-8';

const FALLBACKS: Record<ChartRole, string> = {
  positive: '#15803d',
  warning: '#c05a10',
  neutral: '#64748b',
  ai: '#7c3aed',
  'cat-1': '#2a78d6',
  'cat-2': '#1baf7a',
  'cat-3': '#eda100',
  'cat-4': '#008300',
  'cat-5': '#4a3aa7',
  'cat-6': '#e34948',
  'cat-7': '#e87ba4',
  'cat-8': '#eb6834',
};

// Categorical hues are assigned in this fixed order (CVD-safe as a set); a 9th
// series should fold into "Other" rather than cycle back to slot 1.
const CATEGORICAL_ROLES: ChartRole[] = [
  'cat-1',
  'cat-2',
  'cat-3',
  'cat-4',
  'cat-5',
  'cat-6',
  'cat-7',
  'cat-8',
];

/** The categorical role for the nth series (0-based), clamped to the last slot. */
export function categoricalRole(index: number): ChartRole {
  return CATEGORICAL_ROLES[Math.min(index, CATEGORICAL_ROLES.length - 1)] ?? 'neutral';
}

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
