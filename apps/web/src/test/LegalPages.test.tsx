// /privacy and /terms (router.tsx): must render standalone (no auth, no
// AppShell) — these are the canonical URLs linked from Login's signup
// checkbox, Settings' Legal section, and (per the product ask) the Google
// OAuth consent screen / app-store listings / email footers.
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { PrivacyPolicy } from '../pages/PrivacyPolicy';
import { TermsOfService } from '../pages/TermsOfService';

describe('PrivacyPolicy page', () => {
  it('renders the policy content and a way back to the app', () => {
    render(
      <MemoryRouter>
        <PrivacyPolicy />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Privacy Policy', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to 554 properties/i })).toHaveAttribute(
      'href',
      '/',
    );
    // Substantive content, not a stub — spot-check a few section headings.
    expect(screen.getByRole('heading', { name: /the ai assistant and anthropic/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /who we share information with/i })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <MemoryRouter>
        <PrivacyPolicy />
      </MemoryRouter>,
    );
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });
});

describe('TermsOfService page', () => {
  it('renders the terms content and a way back to the app', () => {
    render(
      <MemoryRouter>
        <TermsOfService />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Terms of Service', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to 554 properties/i })).toHaveAttribute(
      'href',
      '/',
    );
    expect(screen.getByRole('heading', { name: /acceptable use/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /account closure and data deletion/i })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <MemoryRouter>
        <TermsOfService />
      </MemoryRouter>,
    );
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });
});
