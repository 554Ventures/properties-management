// Shared chrome for the public legal pages (/privacy, /terms). Deliberately
// standalone — not AppShell's nav — since these routes render outside
// <AuthGate> (router.tsx) and must work identically whether or not the
// visitor is signed in: the Google OAuth consent screen, app-store listings,
// and email footers all link here directly, with no assumption about
// session state.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function LegalPageLayout({
  title,
  lastUpdated,
  children,
}: {
  title: string;
  lastUpdated: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-app">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4">
          <img src="/logo.svg" alt="" aria-hidden="true" className="h-8 w-8 rounded-md" />
          <span className="text-[15px] font-semibold tracking-tight text-ink">554 Properties</span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10">
        <Link to="/" className="text-sm font-medium text-brand hover:underline">
          &larr; Back to 554 Properties
        </Link>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Last updated: {lastUpdated} · Draft, pending legal review
        </p>
        <div className="mt-8">{children}</div>
      </main>
    </div>
  );
}
