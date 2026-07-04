import type { Config } from 'tailwindcss';

// Every color below points at a CSS custom property defined in
// src/styles/tokens.css — no ad hoc hex values in components (ARCHITECTURE §8).
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        app: 'var(--color-bg)',
        surface: {
          DEFAULT: 'var(--color-surface)',
          raised: 'var(--color-surface-raised)',
          sunken: 'var(--color-surface-sunken)',
          ai: 'var(--surface-ai)',
        },
        border: {
          DEFAULT: 'var(--color-border)',
          strong: 'var(--color-border-strong)',
          ai: 'var(--border-ai)',
        },
        ink: {
          DEFAULT: 'var(--color-text)',
          muted: 'var(--color-text-muted)',
          faint: 'var(--color-text-faint)',
          'on-brand': 'var(--color-text-on-brand)',
          ai: 'var(--text-ai-label)',
        },
        brand: {
          DEFAULT: 'var(--color-brand)',
          strong: 'var(--color-brand-strong)',
          soft: 'var(--color-brand-soft)',
        },
        positive: {
          DEFAULT: 'var(--color-positive)',
          soft: 'var(--color-positive-soft)',
        },
        warning: {
          DEFAULT: 'var(--color-warning)',
          soft: 'var(--color-warning-soft)',
        },
        danger: {
          DEFAULT: 'var(--color-danger)',
          soft: 'var(--color-danger-soft)',
        },
        neutral: {
          DEFAULT: 'var(--color-neutral)',
          soft: 'var(--color-neutral-soft)',
        },
        chart: {
          positive: 'var(--chart-positive)',
          warning: 'var(--chart-warning)',
          neutral: 'var(--chart-neutral)',
          ai: 'var(--chart-ai)',
          grid: 'var(--chart-grid)',
        },
        focus: 'var(--color-focus)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-md)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
      },
      transitionDuration: {
        fast: 'var(--motion-fast)',
        slow: 'var(--motion-slow)',
      },
      transitionTimingFunction: {
        ease: 'var(--motion-ease)',
      },
      boxShadow: {
        // Elevation comes from thin borders, not heavy shadows (Mercury look).
        // `card` is a barely-there hairline lift; `overlay` is reserved for
        // true floating layers (drawers, modals).
        card: '0 1px 1px rgb(27 23 20 / 0.03)',
        overlay: '0 16px 36px -16px rgb(27 23 20 / 0.18)',
      },
    },
  },
  plugins: [],
} satisfies Config;
