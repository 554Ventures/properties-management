// The property hub (/properties/:id): "Needs attention" triage, the enriched
// units & leases table, tenant quick sheets, the lazy lease-history modal,
// financials footer, and permission gating. Fixtures in propertyHubFixtures.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PropertyTasks } from '../components/property/PropertyTasks';
import { ToastProvider, ToastViewport } from '../components/ui/Toast';
import { PropertyDetail } from '../pages/PropertyDetail';
import {
  chenLease,
  hubDetailResponse,
  hubRoutes,
  isoIn,
  makeFetch,
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
      <PropertyTasks
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
      <PropertyTasks
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
