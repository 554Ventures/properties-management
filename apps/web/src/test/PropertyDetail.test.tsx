// The property hub (/properties/:id): "Needs attention" triage, the enriched
// units & leases table, tenant quick sheets, the lazy lease-history modal,
// financials footer, and permission gating. Fixtures in propertyHubFixtures.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeedsAttention } from '../components/property/NeedsAttention';
import { ToastProvider, ToastViewport } from '../components/ui/Toast';
import { PropertyDetail } from '../pages/PropertyDetail';
import {
  chenLease,
  hubDetailResponse,
  hubRoutes,
  isoIn,
  makeFetch,
  makeInsight,
  makeLease,
  makeProperty,
  makeTenant,
  makeUnit,
  moneyOnlyMember,
  PERIOD,
  pnl,
  type RouteFixture,
} from './propertyHubFixtures';

function renderHub(routes: RouteFixture[]) {
  const fetchMock = makeFetch(routes);
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/properties/p1']}>
          <Routes>
            <Route path="/properties/:id" element={<PropertyDetail />} />
          </Routes>
        </MemoryRouter>
        <ToastViewport />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return fetchMock;
}

async function findTriageCard(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: 'Needs attention' });
  return heading.parentElement as HTMLElement;
}

function findUnitsTable(): HTMLElement {
  return screen.getByRole('table', { name: /units, tenants, rent, and lease status/ });
}

function renderProviders(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
        <ToastViewport />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- Needs attention ---------------------------------------------------------

describe('needs attention triage', () => {
  it('renders severity-ordered rows, each with exactly one affordance', async () => {
    renderHub(hubRoutes());
    const card = await findTriageCard();
    const rows = within(card).getAllByRole('listitem');
    expect(rows).toHaveLength(5);

    // Danger first: late rent with the specifics and a rent-tracker link.
    const late = rows[0]!;
    expect(late).toHaveTextContent('D. Park · Unit A — 3 days late · $700.00 of $1,400.00 received');
    const trackerLink = within(late).getByRole('link', { name: 'Open rent tracker →' });
    expect(trackerLink).toHaveAttribute('href', `/rent?period=${PERIOD}`);
    expect(within(late).queryByRole('button')).not.toBeInTheDocument();

    // Warnings in the middle (unit order): lease ending, vacancy, partial.
    expect(rows[1]).toHaveTextContent("S. Novak's lease on Unit B ends in 58 days");
    expect(within(rows[1]!).getByRole('button', { name: 'Draft renewal' })).toBeInTheDocument();
    expect(within(rows[1]!).queryByRole('link')).not.toBeInTheDocument();

    expect(rows[2]).toHaveTextContent('Unit C is vacant');
    expect(within(rows[2]!).getByRole('button', { name: 'Create lease' })).toBeInTheDocument();

    expect(rows[3]).toHaveTextContent('R. Chen · Unit E — $600.00 of $1,200.00 received');
    expect(within(rows[3]!).getByRole('link', { name: 'Open rent tracker →' })).toBeInTheDocument();

    // Neutral last: pending renewal — informational, no affordance.
    expect(rows[4]).toHaveTextContent("P. Quinn's renewal on Unit F is awaiting signature");
    expect(within(rows[4]!).queryByRole('button')).not.toBeInTheDocument();
    expect(within(rows[4]!).queryByRole('link')).not.toBeInTheDocument();
  });

  it('Draft renewal drafts the proposal and opens the renewal modal', async () => {
    const fetchMock = renderHub(hubRoutes());
    const card = await findTriageCard();
    fireEvent.click(within(card).getByRole('button', { name: 'Draft renewal' }));

    const dialog = await screen.findByRole('dialog', { name: 'Renewal proposal' });
    expect(within(dialog).getByText('Suggested rent')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('$1,260.00/mo');
    expect(
      fetchMock.mock.calls.some(
        ([u, i]) =>
          String(u).includes('/api/v1/leases/l2/renewal-draft') &&
          (i as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(true);
  });

  it('Create lease on a vacancy opens the lease form for that unit', async () => {
    renderHub(hubRoutes([{ method: 'GET', path: '/api/v1/tenants', body: [] }]));
    const card = await findTriageCard();
    fireEvent.click(within(card).getByRole('button', { name: 'Create lease' }));
    expect(await screen.findByRole('dialog', { name: 'Create lease — Unit C' })).toBeInTheDocument();
  });

  it('shows the quiet all-clear line when nothing needs attention', async () => {
    const detail = {
      property: makeProperty(),
      units: [
        makeUnit('u1', 'Unit A', {
          status: 'occupied' as const,
          currentLease: makeLease('l1', 'u1', 120000, [makeTenant('t1', 'A. Calm')]),
          rent: {
            period: PERIOD,
            status: 'paid' as const,
            daysLate: null,
            paidCents: 120000,
            amountCents: 120000,
            dueDate: isoIn(-12),
          },
          leaseCount: 1,
        }),
      ],
      pnl,
      insights: [],
    };
    renderHub(hubRoutes([{ method: 'GET', path: '/api/v1/properties/p1', body: detail }]));

    expect(
      await screen.findByText(
        /All clear at 12 Maple St — rent on track, no leases ending in the next 60 days\./,
      ),
    ).toBeInTheDocument();
    const card = await findTriageCard();
    expect(within(card).getByText('All clear')).toBeInTheDocument();
    expect(within(card).queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('is hidden entirely on an archived property', async () => {
    const detail = hubDetailResponse();
    detail.property = makeProperty({ archivedAt: '2026-01-01T00:00:00.000Z' });
    renderHub(hubRoutes([{ method: 'GET', path: '/api/v1/properties/p1', body: detail }]));

    expect(
      await screen.findByText('This property is archived and hidden from your lists.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Needs attention' })).not.toBeInTheDocument();
  });

  it('treats a leased unit with no charge this month (rent: null) as calm', () => {
    // A lease starting next month is active with rent: null — nothing is due,
    // so the triage card stays all-clear rather than flagging missing data.
    const units = [
      makeUnit('u1', 'Unit A', {
        status: 'occupied',
        currentLease: makeLease('l1', 'u1', 120000, [makeTenant('t1', 'A. Tenant')], {
          startDate: isoIn(18),
          endDate: isoIn(383),
        }),
        rent: null,
        leaseCount: 1,
      }),
    ];
    renderProviders(
      <NeedsAttention
        title="12 Maple St"
        units={units}
        canTenants
        draftBusy={false}
        onDraftRenewal={() => {}}
        onCreateLease={() => {}}
      />,
    );
    expect(screen.getByText(/All clear at 12 Maple St/)).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('still triages units with rent data when others have no charge', () => {
    const units = [
      makeUnit('u1', 'Unit A', {
        status: 'occupied',
        currentLease: makeLease('l1', 'u1', 120000, [makeTenant('t1', 'A. Tenant')]),
        rent: null,
        leaseCount: 1,
      }),
      makeUnit('u5', 'Unit E', {
        status: 'occupied',
        currentLease: chenLease,
        rent: {
          period: PERIOD,
          status: 'late',
          daysLate: 4,
          paidCents: 0,
          amountCents: 120000,
          dueDate: isoIn(-4),
        },
        leaseCount: 1,
      }),
    ];
    renderProviders(
      <NeedsAttention
        title="12 Maple St"
        units={units}
        canTenants
        draftBusy={false}
        onDraftRenewal={() => {}}
        onCreateLease={() => {}}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('listitem')).toHaveTextContent('R. Chen · Unit E — 4 days late');
  });
});

// --- Needs attention: merged AI insights ---------------------------------------

describe('needs attention — merged AI insights', () => {
  it('merges a matching late_rent insight into the rent row exactly once, with the AI pill, Send reminder, and Dismiss', async () => {
    const detail = hubDetailResponse();
    detail.insights = [makeInsight()];
    renderHub(hubRoutes([{ method: 'GET', path: '/api/v1/properties/p1', body: detail }]));

    const card = await findTriageCard();
    const rows = within(card).getAllByRole('listitem');
    // Still 5 rows — the insight enriches Unit A's rent row, it doesn't add a
    // 6th (no duplicate row for the same lease).
    expect(rows).toHaveLength(5);

    const late = rows[0]!;
    expect(late).toHaveTextContent(
      'D. Park · Unit A — 3 days late · $700.00 of $1,400.00 received',
    );
    // The AiSurface inline pill's accessible text: the ✦ glyph is
    // aria-hidden, "AI" is the badge's own text, "suggestion" is the pill's
    // label content.
    expect(within(late).getByText('AI')).toBeInTheDocument();
    expect(within(late).getByText('suggestion')).toBeInTheDocument();
    expect(within(late).getByRole('button', { name: 'Send reminder' })).toBeInTheDocument();
    expect(within(late).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    // The row's own derived affordance (tracker link) still shows alongside
    // the AI action cluster — merged rows relax the one-affordance rule.
    expect(within(late).getByRole('link', { name: 'Open rent tracker →' })).toBeInTheDocument();
    // But the insight's own legacy link ("Review", same /rent?period=... URL
    // as the tracker link) is suppressed on merged rows — it would just be a
    // second link to the same place.
    expect(within(late).queryByRole('link', { name: 'Review' })).not.toBeInTheDocument();
  });

  it('Send reminder POSTs /rent/reminders with the fixture body, then marks the insight actioned', async () => {
    const detail = hubDetailResponse();
    const insight = makeInsight();
    detail.insights = [insight];
    const fetchMock = renderHub(
      hubRoutes([
        { method: 'GET', path: '/api/v1/properties/p1', body: detail },
        { method: 'POST', path: '/api/v1/rent/reminders', body: {} },
        { method: 'POST', path: `/api/v1/insights/${insight.id}/actioned`, body: insight },
      ]),
    );

    const card = await findTriageCard();
    fireEvent.click(within(card).getByRole('button', { name: 'Send reminder' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([u, i]) =>
            String(u).includes(`/api/v1/insights/${insight.id}/actioned`) &&
            (i as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true);
    });

    const postCalls = fetchMock.mock.calls.filter(
      ([, i]) => (i as RequestInit | undefined)?.method === 'POST',
    );
    const postPaths = postCalls.map(([u]) => String(u).replace(/^https?:\/\/[^/]+/, ''));
    const reminderIndex = postPaths.indexOf('/api/v1/rent/reminders');
    const actionedIndex = postPaths.indexOf(`/api/v1/insights/${insight.id}/actioned`);
    expect(reminderIndex).toBeGreaterThanOrEqual(0);
    expect(actionedIndex).toBeGreaterThan(reminderIndex);

    const reminderCall = postCalls[reminderIndex]!;
    expect(JSON.parse(String((reminderCall[1] as RequestInit).body))).toEqual({
      rentPaymentIds: ['rp-u1'],
    });
  });

  it('Dismiss POSTs /insights/:id/dismiss', async () => {
    const detail = hubDetailResponse();
    const insight = makeInsight();
    detail.insights = [insight];
    const fetchMock = renderHub(
      hubRoutes([
        { method: 'GET', path: '/api/v1/properties/p1', body: detail },
        { method: 'POST', path: `/api/v1/insights/${insight.id}/dismiss`, body: insight },
      ]),
    );

    const card = await findTriageCard();
    fireEvent.click(within(card).getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([u, i]) =>
            String(u).includes(`/api/v1/insights/${insight.id}/dismiss`) &&
            (i as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true);
    });
    // Merged-row dismiss clears only the AI suggestion — the derived rent
    // status stays put, which is what this toast (over the generic one)
    // confirms. The static fixture doesn't change on the mocked refetch, so
    // this is the assertion the harness supports for "stays a plain derived
    // task" (see NeedsAttention.tsx's MERGED_DISMISS_MESSAGE).
    expect(
      await screen.findByText(
        "AI suggestion dismissed — the rent status stays until it's resolved.",
      ),
    ).toBeInTheDocument();
  });

  it('renders an expense_spike insight as an insight-only row — no duplicate standalone card', async () => {
    const detail = hubDetailResponse();
    const spike = makeInsight({
      id: 'i-spike',
      scope: 'property',
      type: 'expense_spike',
      severity: 'warning',
      title: 'Utilities spending spiked at 12 Maple St',
      body: 'Utilities came in at $640 this month vs a $380 three-month average.',
      actionLabel: 'View transactions',
      actionTarget: '/money?type=expense&propertyId=p1',
      action: {
        label: 'View transactions',
        action: { kind: 'navigate', to: '/money?type=expense&propertyId=p1' },
      },
      propertyId: 'p1',
      tenantId: null,
      leaseId: null,
      dedupeKey: `expense_spike:utilities:${PERIOD}`,
    });
    detail.insights = [spike];
    renderHub(hubRoutes([{ method: 'GET', path: '/api/v1/properties/p1', body: detail }]));

    const card = await findTriageCard();
    const rows = within(card).getAllByRole('listitem');
    // The 5 derived task rows, unchanged, plus exactly one insight-only row.
    expect(rows).toHaveLength(6);

    const spikeRow = rows.find((row) =>
      row.textContent?.includes('Utilities spending spiked'),
    ) as HTMLElement;
    expect(spikeRow).toBeDefined();
    expect(
      within(spikeRow).getByText('Utilities spending spiked at 12 Maple St'),
    ).toBeInTheDocument();
    expect(
      within(spikeRow).getByText(
        'Utilities came in at $640 this month vs a $380 three-month average.',
      ),
    ).toBeInTheDocument();
    expect(within(spikeRow).getByRole('link', { name: 'View transactions' })).toHaveAttribute(
      'href',
      '/money?type=expense&propertyId=p1',
    );
    // No second, standalone InsightCard rendering the same insight elsewhere.
    expect(screen.getAllByText('Utilities spending spiked at 12 Maple St')).toHaveLength(1);
  });

  it('archived property with an insight still renders an insight-only row', async () => {
    const detail = hubDetailResponse();
    detail.property = makeProperty({ archivedAt: '2026-01-01T00:00:00.000Z' });
    detail.insights = [
      makeInsight({
        id: 'i-spike-archived',
        scope: 'property',
        type: 'expense_spike',
        severity: 'warning',
        title: 'Utilities spending spiked at 12 Maple St',
        body: 'Utilities came in high this month.',
        actionLabel: null,
        actionTarget: null,
        action: null,
        propertyId: 'p1',
        tenantId: null,
        leaseId: null,
        dedupeKey: `expense_spike:utilities-archived:${PERIOD}`,
      }),
    ];
    renderHub(hubRoutes([{ method: 'GET', path: '/api/v1/properties/p1', body: detail }]));

    expect(
      await screen.findByText('This property is archived and hidden from your lists.'),
    ).toBeInTheDocument();
    const card = await findTriageCard();
    expect(
      within(card).getByText('Utilities spending spiked at 12 Maple St'),
    ).toBeInTheDocument();
    // Archived: no derived tasks, so the insight-only row is the only one.
    expect(within(card).getAllByRole('listitem')).toHaveLength(1);
  });

  it('archived property with no insights hides the section entirely', async () => {
    const detail = hubDetailResponse();
    detail.property = makeProperty({ archivedAt: '2026-01-01T00:00:00.000Z' });
    renderHub(hubRoutes([{ method: 'GET', path: '/api/v1/properties/p1', body: detail }]));

    expect(
      await screen.findByText('This property is archived and hidden from your lists.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Needs attention' })).not.toBeInTheDocument();
  });
});

// --- Key metrics (KPI row) ------------------------------------------------------

describe('key metrics', () => {
  it('computes occupancy, rent roll, and net MTD/YTD from the fixture data', async () => {
    renderHub(hubRoutes());
    await screen.findByRole('heading', { name: 'Units & leases' });

    // hubDetailResponse(): 6 units, 1 archived (Unit D excluded from active).
    // Active: A (occupied), B (occupied), C (vacant), E (occupied), F
    // (occupied) → 4 of 5 occupied → 80%.
    const occupancy = screen.getByRole('group', { name: 'Occupancy: 4 of 5 units occupied' });
    expect(within(occupancy).getByText('80%')).toBeInTheDocument();

    // Rent roll: sum of active units' current-lease rent — A $1,400 + B
    // $1,200 + E $1,200 + F $1,100 (C vacant, contributes $0) = $4,900.
    const rentRoll = screen.getByRole('group', { name: 'Rent roll, $4,900.00 per month' });
    expect(within(rentRoll).getByText('$4,900')).toBeInTheDocument();

    // pnl fixture: mtd.netCents 380000 → $3,800; ytd.netCents 2490000 →
    // $24,900.
    const netMtd = screen.getByRole('group', { name: 'Net income, month to date, $3,800.00' });
    expect(within(netMtd).getByText('$3,800')).toBeInTheDocument();

    const netYtd = screen.getByRole('group', { name: 'Net income, year to date, $24,900.00' });
    expect(within(netYtd).getByText('$24,900')).toBeInTheDocument();
  });
});

// --- Units & leases table ------------------------------------------------------

describe('units & leases table', () => {
  it('summarizes the units in plain text next to the heading', async () => {
    renderHub(hubRoutes());
    expect(await screen.findByText('5 units · 2 of 4 paid this month · 1 late')).toBeInTheDocument();
  });

  it('excludes leased units with no charge this month from the paid denominator', async () => {
    const detail = hubDetailResponse();
    // Unit E's lease doesn't touch this month — rent: null, nothing due.
    detail.units = detail.units.map((u) => (u.id === 'u5' ? { ...u, rent: null } : u));
    renderHub(hubRoutes([{ method: 'GET', path: '/api/v1/properties/p1', body: detail }]));
    expect(await screen.findByText('5 units · 2 of 3 paid this month · 1 late')).toBeInTheDocument();
  });

  it('renders unit facts, rent-vs-market delta, and this-month rent badges', async () => {
    renderHub(hubRoutes());
    await screen.findByRole('heading', { name: 'Units & leases' });
    const table = findUnitsTable();

    expect(within(table).getByText('2 bd · 1 ba · market $1,350')).toBeInTheDocument();
    expect(within(table).getByText('+$50 vs market')).toBeInTheDocument();

    // "This month" badges link to the rent tracker for the same period.
    const lateLink = within(table).getByRole('link', { name: /3 days late — open rent tracker/ });
    expect(lateLink).toHaveAttribute('href', `/rent?period=${PERIOD}`);
    expect(
      within(table).getByRole('link', { name: /\$600\.00 of \$1,200\.00 — open rent tracker/ }),
    ).toBeInTheDocument();
    expect(within(table).getAllByText('Paid')).toHaveLength(2);
    expect(within(table).getByText('Vacant')).toBeInTheDocument();
  });

  it('shows renewal, pending-signature, and e-sign badges on the lease column', async () => {
    renderHub(hubRoutes());
    await screen.findByRole('heading', { name: 'Units & leases' });
    const table = findUnitsTable();

    expect(within(table).getByText('Renews in 58 days')).toBeInTheDocument();
    expect(within(table).getByText('Renewal awaiting signature')).toBeInTheDocument();
    expect(within(table).getByText('E-sign: signed')).toBeInTheDocument();
    expect(within(table).getAllByText(/due day 1/)).not.toHaveLength(0);
  });

  it('opens the lease-history modal lazily from the "prior leases" line', async () => {
    const fetchMock = renderHub(hubRoutes());
    await screen.findByRole('heading', { name: 'Units & leases' });

    // Not fetched until the modal opens.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/v1/units/u1'))).toBe(false);

    // Unit F's second lease is its pending renewal, not history — no button.
    const unitFRow = screen.getByRole('link', { name: 'Unit F' }).closest('tr') as HTMLElement;
    expect(within(unitFRow).queryByRole('button', { name: /prior lease/ })).not.toBeInTheDocument();

    const unitARow = screen.getByRole('link', { name: 'Unit A' }).closest('tr') as HTMLElement;
    fireEvent.click(within(unitARow).getByRole('button', { name: '1 prior lease' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unit A — lease history' });
    expect(await within(dialog).findByText('F. Ormer')).toBeInTheDocument();
    expect(within(dialog).getByText('Ended')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Full unit record →' })).toHaveAttribute(
      'href',
      '/units/u1',
    );
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/v1/units/u1'))).toBe(true);
  });

  it('hides archived units behind the toggle by default', async () => {
    renderHub(hubRoutes());
    await screen.findByRole('heading', { name: 'Units & leases' });
    expect(screen.queryByText('Unit D')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'Show archived (1)' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);

    const table = findUnitsTable();
    expect(within(table).getByRole('link', { name: 'Unit D' })).toBeInTheDocument();
    expect(within(table).getByText('Archived')).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide archived' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hide archived' }));
    expect(screen.queryByText('Unit D')).not.toBeInTheDocument();
  });

  it('renders the empty state when the property has no units', async () => {
    const detail = { property: makeProperty(), units: [], pnl, insights: [] };
    renderHub(hubRoutes([{ method: 'GET', path: '/api/v1/properties/p1', body: detail }]));

    expect(await screen.findByText('No units yet')).toBeInTheDocument();
    expect(screen.getByText('Add the first unit to start a lease.')).toBeInTheDocument();
    // Header + empty state both offer "Add unit" for an owner.
    expect(screen.getAllByRole('button', { name: 'Add unit' })).toHaveLength(2);
    expect(screen.getByText('0 units')).toBeInTheDocument();
  });
});

// --- Financials ---------------------------------------------------------------

describe('financials', () => {
  it('footnotes the scope and links to the property-filtered ledger', async () => {
    renderHub(hubRoutes());
    expect(
      await screen.findByText('Excludes transactions not assigned to this property.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View transactions →' })).toHaveAttribute(
      'href',
      '/money?propertyId=p1',
    );
  });
});

// --- Tenant quick sheet ---------------------------------------------------------

describe('tenant quick sheet', () => {
  it('shows role, rent share, and contact actions; Escape restores focus', async () => {
    renderHub(hubRoutes());
    await screen.findByRole('heading', { name: 'Units & leases' });

    const trigger = screen.getByRole('button', { name: 'D. Park' });
    // jsdom doesn't focus on click — focus explicitly so the trap has a real
    // restore target, as a pointer/keyboard user would.
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'D. Park' });
    expect(within(dialog).getByText(/Primary tenant/)).toBeInTheDocument();
    expect(within(dialog).getByText(/\$700\.00\/mo share/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Call 555-0101' })).toHaveAttribute(
      'href',
      'tel:555-0101',
    );
    expect(within(dialog).getByRole('link', { name: 'Text 555-0101' })).toHaveAttribute(
      'href',
      'sms:555-0101',
    );
    expect(within(dialog).getByRole('link', { name: 'Email park@example.com' })).toHaveAttribute(
      'href',
      'mailto:park@example.com',
    );
    expect(within(dialog).getByRole('link', { name: 'Full profile →' })).toHaveAttribute(
      'href',
      '/tenants/t-park',
    );

    // Focus trap: focus moves into the dialog, Escape closes and restores it.
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'D. Park' })).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it('says "not on file" instead of rendering dead contact buttons', async () => {
    renderHub(hubRoutes());
    await screen.findByRole('heading', { name: 'Units & leases' });

    fireEvent.click(screen.getByRole('button', { name: 'S. Novak' }));
    const dialog = await screen.findByRole('dialog', { name: 'S. Novak' });

    expect(within(dialog).getByText(/Primary tenant/)).toBeInTheDocument();
    expect(within(dialog).getByText(/even split/)).toBeInTheDocument();
    expect(within(dialog).getByText('Phone not on file')).toBeInTheDocument();
    expect(within(dialog).getByText('Email not on file')).toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: /^Call/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: /^Text/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: /^Email/ })).not.toBeInTheDocument();
  });

  it('labels a co-tenant as such', async () => {
    renderHub(hubRoutes());
    await screen.findByRole('heading', { name: 'Units & leases' });

    fireEvent.click(screen.getByRole('button', { name: 'C. Park' }));
    const dialog = await screen.findByRole('dialog', { name: 'C. Park' });
    expect(within(dialog).getByText(/Co-tenant/)).toBeInTheDocument();
  });
});

// --- Permission gating -----------------------------------------------------------

describe('permission gating', () => {
  it('hides every write affordance from a member without tenants/properties', async () => {
    renderHub(
      hubRoutes([{ method: 'GET', path: '/api/v1/settings/me', body: moneyOnlyMember }]),
    );
    await screen.findByRole('heading', { name: 'Units & leases' });

    // The member view settles once /settings/me lands.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Add unit' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Edit property' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive property' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Draft renewal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create lease' })).not.toBeInTheDocument();

    // Reads stay visible: triage, rent-tracker links, tenant quick sheets.
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open rent tracker →' })).not.toHaveLength(0);
    expect(screen.getByRole('button', { name: 'D. Park' })).toBeInTheDocument();

    // Archived units remain visible read-only — no Restore.
    fireEvent.click(screen.getByRole('button', { name: 'Show archived (1)' }));
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
  });
});

// --- Lapsed lease (month-to-month) + re-lease prefill -------------------------

describe('lapsed lease and re-lease prefill', () => {
  it('a lease past its end date surfaces as month-to-month with a Draft renewal affordance', async () => {
    const lapsed = hubDetailResponse();
    const unitB = lapsed.units.find((u) => u.id === 'u2')!;
    unitB.currentLease = { ...unitB.currentLease!, endDate: isoIn(-10.5) };
    renderHub(hubRoutes([{ method: 'GET', path: '/api/v1/properties/p1', body: lapsed }]));

    const card = await findTriageCard();
    expect(card).toHaveTextContent(
      "S. Novak's lease on Unit B ended 10 days ago — now running month-to-month",
    );
    // Lapsed ranks with the danger rows, ahead of merely-expiring leases.
    const rows = within(card).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent(/3 days late|month-to-month/);
    expect(within(card).getByText('Month-to-month')).toBeInTheDocument();
    // The renew affordance stays available past the end date.
    expect(within(card).getByRole('button', { name: 'Draft renewal' })).toBeInTheDocument();

    // The units table mirrors it (badge shares the same window math as the
    // row's Renew… action; RowActions collapses to a sheet in jsdom).
    const table = findUnitsTable();
    expect(within(table).getByText('Month-to-month')).toBeInTheDocument();
  });

  it('Create lease on a previously-leased unit prefills terms and tenants from the last ended lease', async () => {
    const former = makeTenant('t-former', 'F. Ormer');
    const endedLease = makeLease('l-old', 'u3', 98000, [former], {
      startDate: isoIn(-700),
      endDate: isoIn(-30),
      status: 'ended',
      dueDay: 5,
    });
    const detail = hubDetailResponse();
    const unitC = detail.units.find((u) => u.id === 'u3')!;
    unitC.leaseCount = 1;

    renderHub(
      hubRoutes([
        { method: 'GET', path: '/api/v1/properties/p1', body: detail },
        {
          method: 'GET',
          path: '/api/v1/units/u3',
          body: {
            unit: {
              id: 'u3',
              propertyId: 'p1',
              label: 'Unit C',
              bedrooms: 1,
              bathrooms: 1,
              marketRentCents: 95000,
              archivedAt: null,
            },
            propertyId: 'p1',
            propertyLabel: '12 Maple St',
            status: 'vacant',
            currentLease: null,
            leases: [endedLease],
            rentPayments: [],
            pnl,
          },
        },
        {
          method: 'GET',
          path: '/api/v1/tenants',
          body: [
            {
              id: 't-former',
              fullName: 'F. Ormer',
              email: null,
              phone: null,
              unitId: null,
              unitLabel: null,
              propertyId: null,
              propertyLabel: null,
              rentCents: null,
              leaseEndDate: null,
              status: 'current',
            },
          ],
        },
      ]),
    );

    const card = await findTriageCard();
    fireEvent.click(within(card).getByRole('button', { name: 'Create lease' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create lease — Unit C' });

    // Terms + tenant arrive from the lazy unit fetch; dates stay blank.
    await waitFor(() =>
      expect(within(dialog).getByLabelText(/Monthly rent/)).toHaveValue(980),
    );
    expect(within(dialog).getByLabelText(/Rent due day/)).toHaveValue(5);
    await waitFor(() =>
      expect(
        within(dialog).getByText(/Prefilled from the previous lease \(F\. Ormer\)/),
      ).toBeInTheDocument(),
    );
    expect(within(dialog).getByText('F. Ormer')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Start date/)).toHaveValue('');
    expect(within(dialog).getByLabelText(/End date/)).toHaveValue('');

    // User edits win: typing a rent stops any later prefill overwrite.
    fireEvent.input(within(dialog).getByLabelText(/Monthly rent/), { target: { value: '1010' } });
    expect(within(dialog).getByLabelText(/Monthly rent/)).toHaveValue(1010);
  });

  it('Create lease with an attached agreement uploads it against the created lease', async () => {
    const former = makeTenant('t-former', 'F. Ormer');
    const endedLease = makeLease('l-old', 'u3', 98000, [former], {
      startDate: isoIn(-700),
      endDate: isoIn(-30),
      status: 'ended',
      dueDay: 5,
    });
    const detail = hubDetailResponse();
    const unitC = detail.units.find((u) => u.id === 'u3')!;
    unitC.leaseCount = 1;

    const fetchMock = renderHub(
      hubRoutes([
        { method: 'GET', path: '/api/v1/properties/p1', body: detail },
        {
          method: 'GET',
          path: '/api/v1/units/u3',
          body: {
            unit: {
              id: 'u3',
              propertyId: 'p1',
              label: 'Unit C',
              bedrooms: 1,
              bathrooms: 1,
              marketRentCents: 95000,
              archivedAt: null,
            },
            propertyId: 'p1',
            propertyLabel: '12 Maple St',
            status: 'vacant',
            currentLease: null,
            leases: [endedLease],
            rentPayments: [],
            pnl,
          },
        },
        {
          method: 'GET',
          path: '/api/v1/tenants',
          body: [
            {
              id: 't-former',
              fullName: 'F. Ormer',
              email: null,
              phone: null,
              unitId: null,
              unitLabel: null,
              propertyId: null,
              propertyLabel: null,
              rentCents: null,
              leaseEndDate: null,
              status: 'current',
            },
          ],
        },
        {
          method: 'POST',
          path: '/api/v1/leases',
          body: makeLease('l-new', 'u3', 101000, [former]),
        },
        { method: 'POST', path: '/api/v1/documents', body: { id: 'd1', name: 'lease.pdf' } },
      ]),
    );

    const card = await findTriageCard();
    fireEvent.click(within(card).getByRole('button', { name: 'Create lease' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create lease — Unit C' });
    // Wait for the prefill (rent, due day, tenant) so the form is submittable.
    await waitFor(() => expect(within(dialog).getByLabelText(/Monthly rent/)).toHaveValue(980));

    fireEvent.input(within(dialog).getByLabelText(/Start date/), {
      target: { value: '2026-08-01' },
    });
    fireEvent.input(within(dialog).getByLabelText(/End date/), {
      target: { value: '2027-07-31' },
    });
    const file = new File(['pdf-bytes'], 'lease.pdf', { type: 'application/pdf' });
    fireEvent.change(within(dialog).getByLabelText(/Signed agreement/), {
      target: { files: [file] },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create lease' }));

    await waitFor(() => {
      const docCall = fetchMock.mock.calls.find(
        ([u, i]) =>
          String(u) === '/api/v1/documents' && (i as RequestInit | undefined)?.method === 'POST',
      );
      expect(docCall).toBeDefined();
      const body = docCall?.[1]?.body as FormData;
      expect(body.get('entityType')).toBe('lease');
      expect(body.get('entityId')).toBe('l-new');
      expect(body.get('type')).toBe('lease');
      expect((body.get('file') as File).name).toBe('lease.pdf');
    });
    expect(await screen.findByText('Lease created and agreement attached.')).toBeInTheDocument();
  });
});
