// The Money page's "Recurring" section (PLAN-REAL-EQUITY §6 Phase 2 item 8):
// standing instructions, never ledger rows — cadence and next-due always
// render in plain words / the server's own `nextOccurrence`, paused templates
// stay behind a "Show paused" affordance, and every write control is gated on
// the `money` permission (a prop here, mirroring FinancingCard's `canProperties`).
import { formatUsd } from '@hearth/shared';
import type { Property, RecurringTemplate } from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecurringSection } from '../components/money/RecurringSection';
import { ToastProvider, ToastViewport } from '../components/ui/Toast';
import { formatCalendarDate } from '../lib/format';
import { hubDetailResponse, makeMortgage, makeProperty } from './propertyHubFixtures';

const property: Property = makeProperty();

function makeTemplate(overrides: Partial<RecurringTemplate> = {}): RecurringTemplate {
  return {
    id: 'rt1',
    accountId: 'acc1',
    description: 'Mortgage payment',
    vendor: 'First National Bank',
    propertyId: 'p1',
    unitId: null,
    categoryId: null,
    type: 'expense',
    amountCents: 240000,
    cadence: 'monthly',
    anchorDate: '2026-08-01',
    mortgageId: null,
    principalCents: null,
    lastDraftedOccurrence: null,
    nextOccurrence: '2026-09-01',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

interface RouteFixture {
  method: string;
  path: string;
  status?: number;
  body?: unknown;
}

function makeFetch(routes: RouteFixture[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    const method = (init?.method ?? 'GET').toUpperCase();
    const match = routes.find((r) => r.path === url && r.method === method);
    if (!match) {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: url } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(match.body === undefined ? null : JSON.stringify(match.body), {
      status: match.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

// RowActions reads `(min-width: 768px)` — force the desktop inline-button
// layout so Edit/Pause are queryable without going through the mobile sheet.
function stubDesktopViewport() {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
    return {
      matches: query === '(min-width: 768px)',
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    } as MediaQueryList;
  });
}

function renderSection(props: { properties: Property[]; canMoney: boolean }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <RecurringSection {...props} />
        </MemoryRouter>
        <ToastViewport />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RecurringSection list', () => {
  it('renders cadence and next-due in plain words, from the server nextOccurrence', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([{ method: 'GET', path: '/api/v1/recurring-templates', body: [makeTemplate()] }]),
    );
    renderSection({ properties: [property], canMoney: true });

    expect(await screen.findByText('Mortgage payment')).toBeInTheDocument();
    expect(screen.getByText('First National Bank')).toBeInTheDocument();
    expect(screen.getByText('Monthly, on the 1st')).toBeInTheDocument();
    expect(screen.getByText(formatCalendarDate('2026-09-01'))).toBeInTheDocument();
    expect(screen.getByText('12 Maple St')).toBeInTheDocument();
    expect(screen.getByText(formatUsd(240000))).toBeInTheDocument();
  });

  it('renders quarterly and annual cadences in plain words too', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        {
          method: 'GET',
          path: '/api/v1/recurring-templates',
          body: [
            makeTemplate({
              id: 'rt-q',
              description: 'HOA dues',
              cadence: 'quarterly',
              anchorDate: '2026-01-15',
            }),
            makeTemplate({
              id: 'rt-a',
              description: 'Landlord insurance',
              cadence: 'annual',
              anchorDate: '2026-03-22',
            }),
          ],
        },
      ]),
    );
    renderSection({ properties: [property], canMoney: true });

    await screen.findByText('HOA dues');
    expect(screen.getByText('Quarterly, on the 15th')).toBeInTheDocument();
    expect(screen.getByText('Annually, on Mar 22')).toBeInTheDocument();
  });

  it('shows an explanatory empty state when there are no templates yet', async () => {
    vi.stubGlobal('fetch', makeFetch([{ method: 'GET', path: '/api/v1/recurring-templates', body: [] }]));
    renderSection({ properties: [property], canMoney: true });

    expect(await screen.findByText('No recurring templates yet')).toBeInTheDocument();
    expect(screen.getByText(/standing instruction/)).toBeInTheDocument();
  });

  it('separates paused templates behind a "Show paused" affordance', async () => {
    const active = makeTemplate({ id: 'rt-active' });
    const paused = makeTemplate({
      id: 'rt-paused',
      description: 'Landlord insurance',
      archivedAt: '2026-02-01T00:00:00.000Z',
    });
    vi.stubGlobal(
      'fetch',
      makeFetch([{ method: 'GET', path: '/api/v1/recurring-templates', body: [active, paused] }]),
    );
    renderSection({ properties: [property], canMoney: true });

    await screen.findByText('Mortgage payment');
    expect(screen.queryByText('Landlord insurance')).not.toBeInTheDocument();
    // Text, not color alone.
    expect(screen.getByText(/doesn.t backfill/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show paused (1)' }));
    expect(await screen.findByText('Landlord insurance')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  it('has no axe violations on a populated section', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([{ method: 'GET', path: '/api/v1/recurring-templates', body: [makeTemplate()] }]),
    );
    const { container } = renderSection({ properties: [property], canMoney: true });
    await screen.findByText('Mortgage payment');
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });
});

describe('RecurringSection create / edit', () => {
  it('create submits the right payload', async () => {
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/recurring-templates', body: [] },
      { method: 'GET', path: '/api/v1/properties', body: [property] },
      { method: 'GET', path: '/api/v1/categories', body: [] },
      { method: 'POST', path: '/api/v1/recurring-templates', body: makeTemplate() },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderSection({ properties: [property], canMoney: true });

    await screen.findByText('No recurring templates yet');
    fireEvent.click(screen.getAllByRole('button', { name: 'Add template' })[0]!);

    const dialog = await screen.findByRole('dialog', { name: 'Add recurring template' });
    fireEvent.change(within(dialog).getByLabelText(/^Description/), {
      target: { value: 'Landlord insurance' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Amount \(USD\)/), {
      target: { value: '450.00' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Cadence/), { target: { value: 'annual' } });
    fireEvent.change(within(dialog).getByLabelText(/^First due date/), {
      target: { value: '2026-09-15' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add template' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/v1/recurring-templates' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String((call![1] as RequestInit).body));
      // anchorDate carries the date-input value verbatim — no Date round-trip
      // that could shift it a day depending on the account's timezone.
      expect(body).toEqual({
        description: 'Landlord insurance',
        type: 'expense',
        amountCents: 45000,
        cadence: 'annual',
        anchorDate: '2026-09-15',
      });
    });
    expect(await screen.findByText('Recurring template added.')).toBeInTheDocument();
  });

  it('edit submits the right payload, pre-filled from the template', async () => {
    stubDesktopViewport();
    const template = makeTemplate();
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/recurring-templates', body: [template] },
      { method: 'GET', path: '/api/v1/properties', body: [property] },
      { method: 'GET', path: '/api/v1/categories', body: [] },
      { method: 'GET', path: '/api/v1/properties/p1', body: hubDetailResponse() },
      { method: 'PATCH', path: '/api/v1/recurring-templates/rt1', body: template },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderSection({ properties: [property], canMoney: true });

    await screen.findByText('Mortgage payment');
    fireEvent.click(screen.getByRole('button', { name: /^Edit/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit recurring template' });
    expect(within(dialog).getByLabelText(/^Description/)).toHaveValue('Mortgage payment');
    expect(within(dialog).getByLabelText(/^Amount \(USD\)/)).toHaveValue(2400);
    // anchorDate is prefilled straight from the template's plain calendar date
    // — no Date round-trip that could reformat it a day off.
    expect(within(dialog).getByLabelText(/^First due date/)).toHaveValue('2026-08-01');
    fireEvent.change(within(dialog).getByLabelText(/^Amount \(USD\)/), {
      target: { value: '2500.00' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/v1/recurring-templates/rt1' &&
          (init as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String((call![1] as RequestInit).body));
      // Touching only the amount sends neither the unrelated optional keys
      // nor their `null`-to-clear form — they were never touched, so they're
      // left out of the patch entirely rather than resent or nulled.
      expect(body).toEqual({
        description: 'Mortgage payment',
        type: 'expense',
        amountCents: 250000,
        cadence: 'monthly',
        anchorDate: '2026-08-01',
      });
    });
  });

  it('clearing vendor, property (and its unit), and category each sends explicit null', async () => {
    stubDesktopViewport();
    const template = makeTemplate({
      unitId: 'u1',
      categoryId: 'cat1',
    });
    const category = {
      id: 'cat1',
      accountId: 'acc1',
      name: 'Mortgage',
      type: 'expense' as const,
      irsScheduleELine: null,
      isSystem: false,
    };
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/recurring-templates', body: [template] },
      { method: 'GET', path: '/api/v1/properties', body: [property] },
      { method: 'GET', path: '/api/v1/categories', body: [category] },
      { method: 'GET', path: '/api/v1/properties/p1', body: hubDetailResponse() },
      { method: 'PATCH', path: '/api/v1/recurring-templates/rt1', body: template },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderSection({ properties: [property], canMoney: true });

    await screen.findByText('Mortgage payment');
    fireEvent.click(screen.getByRole('button', { name: /^Edit/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit recurring template' });
    await within(dialog).findByText('Unit A');
    fireEvent.change(within(dialog).getByLabelText(/^Vendor/), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText(/^Property/), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText(/^Category/), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/v1/recurring-templates/rt1' &&
          (init as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String((call![1] as RequestInit).body));
      expect(body).toMatchObject({
        vendor: null,
        propertyId: null,
        unitId: null,
        categoryId: null,
      });
      // Never-touched fields (mortgage attachment stayed off throughout).
      expect(body).not.toHaveProperty('mortgageId');
      expect(body).not.toHaveProperty('principalCents');
    });
  });

  it('clearing an attached mortgage also nulls principalCents', async () => {
    stubDesktopViewport();
    const template = makeTemplate({ mortgageId: 'm1', principalCents: 180000 });
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/recurring-templates', body: [template] },
      { method: 'GET', path: '/api/v1/properties', body: [property] },
      { method: 'GET', path: '/api/v1/categories', body: [] },
      {
        method: 'GET',
        path: '/api/v1/properties/p1',
        body: { ...hubDetailResponse(), mortgages: [makeMortgage()] },
      },
      { method: 'PATCH', path: '/api/v1/recurring-templates/rt1', body: template },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderSection({ properties: [property], canMoney: true });

    await screen.findByText('Mortgage payment');
    fireEvent.click(screen.getByRole('button', { name: /^Edit/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit recurring template' });
    fireEvent.click(
      await within(dialog).findByRole('button', { name: 'Remove mortgage attachment' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/v1/recurring-templates/rt1' &&
          (init as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String((call![1] as RequestInit).body));
      expect(body).toMatchObject({ mortgageId: null, principalCents: null });
    });
  });

  it('switching an attached template from Expense to Income clears the mortgage attachment instead of leaving it dangling', async () => {
    stubDesktopViewport();
    const template = makeTemplate({ mortgageId: 'm1', principalCents: 180000 });
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/recurring-templates', body: [template] },
      { method: 'GET', path: '/api/v1/properties', body: [property] },
      { method: 'GET', path: '/api/v1/categories', body: [] },
      {
        method: 'GET',
        path: '/api/v1/properties/p1',
        body: { ...hubDetailResponse(), mortgages: [makeMortgage()] },
      },
      { method: 'PATCH', path: '/api/v1/recurring-templates/rt1', body: template },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderSection({ properties: [property], canMoney: true });

    await screen.findByText('Mortgage payment');
    fireEvent.click(screen.getByRole('button', { name: /^Edit/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit recurring template' });
    await within(dialog).findByRole('button', { name: 'Remove mortgage attachment' });
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'income' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/v1/recurring-templates/rt1' &&
          (init as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String((call![1] as RequestInit).body));
      expect(body).toMatchObject({ type: 'income', mortgageId: null, principalCents: null });
    });
    expect(await screen.findByText('Recurring template updated.')).toBeInTheDocument();
  });
});

describe('RecurringSection pause / resume', () => {
  it('pause calls DELETE and resume calls restore', async () => {
    stubDesktopViewport();
    const active = makeTemplate({ id: 'rt-active' });
    const paused = makeTemplate({
      id: 'rt-paused',
      description: 'Landlord insurance',
      archivedAt: '2026-02-01T00:00:00.000Z',
    });
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/recurring-templates', body: [active, paused] },
      { method: 'DELETE', path: '/api/v1/recurring-templates/rt-active', status: 204 },
      {
        method: 'POST',
        path: '/api/v1/recurring-templates/rt-paused/restore',
        body: { ...paused, archivedAt: null },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderSection({ properties: [property], canMoney: true });

    await screen.findByText('Mortgage payment');
    fireEvent.click(screen.getByRole('button', { name: /^Pause/ }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === '/api/v1/recurring-templates/rt-active' &&
            (init as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true);
    });
    expect(
      await screen.findByText('"Mortgage payment" paused — no more automatic drafts until you resume it.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show paused (1)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === '/api/v1/recurring-templates/rt-paused/restore' &&
            (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true);
    });
    expect(
      await screen.findByText('"Landlord insurance" resumed — only the next due occurrence will draft.'),
    ).toBeInTheDocument();
  });
});

describe('RecurringSection permission gating', () => {
  it('a member without money sees the templates but no write controls', async () => {
    stubDesktopViewport();
    const active = makeTemplate({ id: 'rt-active' });
    const paused = makeTemplate({
      id: 'rt-paused',
      description: 'Landlord insurance',
      archivedAt: '2026-02-01T00:00:00.000Z',
    });
    vi.stubGlobal(
      'fetch',
      makeFetch([{ method: 'GET', path: '/api/v1/recurring-templates', body: [active, paused] }]),
    );
    renderSection({ properties: [property], canMoney: false });

    await screen.findByText('Mortgage payment');
    expect(screen.queryByRole('button', { name: 'Add template' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pause/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show paused (1)' }));
    expect(await screen.findByText('Landlord insurance')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  });
});
