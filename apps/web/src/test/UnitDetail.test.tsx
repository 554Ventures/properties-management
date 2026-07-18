// The unit hub (/units/:id): header facts, unit-scoped "Needs attention"
// triage, current-lease management (create/renew/edit/co-tenants/terminate),
// financials, lease/payment history, documents, and permission gating.
// Fixtures shared with the property-hub suite in propertyHubFixtures.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RenewalDraftResponse, UnitDetailResponse } from '@hearth/shared';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, ToastViewport } from '../components/ui/Toast';
import { UnitDetail } from '../pages/UnitDetail';
import {
  archivedUnitDetailResponse,
  isoIn,
  makeFetch,
  moneyOnlyMember,
  ownerUser,
  PERIOD,
  unitADetailResponse,
  vacantUnitDetailResponse,
  type RouteFixture,
} from './propertyHubFixtures';

// Renewal-draft proposal for Unit A's active lease (l1) — same
// RenewalDraftResponse shape PropertyDetail.test.tsx uses for l2.
const parkRenewalDraft: RenewalDraftResponse = {
  leaseId: 'l1',
  currentRentCents: 140000,
  suggestedRentCents: 147000,
  marketRentCents: 135000,
  proposedStartDate: isoIn(301),
  proposedEndDate: isoIn(666),
  dueDay: 1,
};

/** The standard route set for the unit hub at /units/u1, owner view. */
function unitRoutes(overrides: RouteFixture[] = []): RouteFixture[] {
  const base: RouteFixture[] = [
    { method: 'GET', path: '/api/v1/units/u1', body: unitADetailResponse() },
    { method: 'GET', path: '/api/v1/settings/me', body: ownerUser },
    { method: 'GET', path: '/api/v1/documents', body: { documents: [], total: 0 } },
    { method: 'POST', path: '/api/v1/leases/l1/renewal-draft', body: parkRenewalDraft },
  ];
  for (const override of overrides) {
    const idx = base.findIndex((r) => r.method === override.method && r.path === override.path);
    if (idx >= 0) base[idx] = { ...base[idx]!, ...override };
    else base.push(override);
  }
  return base;
}

/** Attaches a populated rent-payment history row (mirrors Unit A's
 * this-month snapshot) so the payment-history section renders a real table
 * instead of the empty-state paragraph. */
function withRentPayments(detail: UnitDetailResponse): UnitDetailResponse {
  return {
    ...detail,
    rentPayments: [
      {
        id: 'rp1',
        period: PERIOD,
        dueDate: isoIn(-3),
        amountCents: 140000,
        paidCents: 70000,
        lateFeeCents: 0,
        status: 'late',
        daysLate: 3,
        method: null,
        paidAt: null,
        lastDepositAt: isoIn(-1),
      },
    ],
  };
}

function renderUnit(routes: RouteFixture[], path = '/units/u1') {
  const fetchMock = makeFetch(routes);
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/units/:id" element={<UnitDetail />} />
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

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- Header ------------------------------------------------------------------

describe('header', () => {
  it('shows the unit title, fact-line description, and a breadcrumb link to the property', async () => {
    renderUnit(unitRoutes());

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Unit A — 12 Maple St' }),
    ).toBeInTheDocument();
    expect(screen.getByText('2 bd · 1 ba · market rent $1,350/mo')).toBeInTheDocument();

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('link', { name: '12 Maple St' })).toHaveAttribute(
      'href',
      '/properties/p1',
    );
  });
});

// --- Triage --------------------------------------------------------------------

describe('needs attention triage', () => {
  it('surfaces the late-rent row with a rent-tracker link', async () => {
    renderUnit(unitRoutes());
    const card = await findTriageCard();

    const rows = within(card).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent(
      'D. Park · Unit A — 3 days late · $700.00 of $1,400.00 received',
    );
    const trackerLink = within(rows[0]!).getByRole('link', { name: 'Open rent tracker →' });
    expect(trackerLink).toHaveAttribute('href', `/rent?period=${PERIOD}`);
  });
});

// --- This-month rent badge -----------------------------------------------------

describe('current lease card', () => {
  it("links this month's rent badge to the rent tracker for the same period", async () => {
    renderUnit(unitRoutes());
    const section = await screen.findByRole('region', { name: 'Current lease' });

    const badgeLink = within(section).getByRole('link', {
      name: /3 days late — open rent tracker/,
    });
    expect(badgeLink).toHaveAttribute('href', `/rent?period=${PERIOD}`);
  });

  it('Draft renewal drafts the proposal from the lease card and opens the renewal modal', async () => {
    const fetchMock = renderUnit(unitRoutes());
    const section = await screen.findByRole('region', { name: 'Current lease' });
    fireEvent.click(within(section).getByRole('button', { name: 'Draft renewal' }));

    const dialog = await screen.findByRole('dialog', { name: 'Renewal proposal' });
    expect(within(dialog).getByText('Suggested rent')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('$1,470.00/mo');
    expect(
      fetchMock.mock.calls.some(
        ([u, i]) =>
          String(u).includes('/api/v1/leases/l1/renewal-draft') &&
          (i as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(true);
  });
});

// --- Vacant unit: triage + re-lease prefill -----------------------------------

describe('vacant unit', () => {
  function vacantRoutes(overrides: RouteFixture[] = []): RouteFixture[] {
    const base: RouteFixture[] = [
      { method: 'GET', path: '/api/v1/units/u3', body: vacantUnitDetailResponse() },
      { method: 'GET', path: '/api/v1/settings/me', body: ownerUser },
      { method: 'GET', path: '/api/v1/documents', body: { documents: [], total: 0 } },
      {
        method: 'GET',
        path: '/api/v1/tenants',
        body: [
          {
            id: 't-gray',
            fullName: 'G. Ray',
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
    ];
    for (const override of overrides) {
      const idx = base.findIndex((r) => r.method === override.method && r.path === override.path);
      if (idx >= 0) base[idx] = { ...base[idx]!, ...override };
      else base.push(override);
    }
    return base;
  }

  it('triages the vacancy and prefills Create lease from the ended lease', async () => {
    renderUnit(vacantRoutes(), '/units/u3');
    const card = await findTriageCard();

    const rows = within(card).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Unit C is vacant');
    expect(within(rows[0]!).getByText('Vacant')).toBeInTheDocument();

    fireEvent.click(within(card).getByRole('button', { name: 'Create lease' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create lease — Unit C' });

    await waitFor(() => expect(within(dialog).getByLabelText(/Monthly rent/)).toHaveValue(950));
    expect(within(dialog).getByLabelText(/Rent due day/)).toHaveValue(5);
    await waitFor(() =>
      expect(
        within(dialog).getByText(/Prefilled from the previous lease \(G\. Ray\)/),
      ).toBeInTheDocument(),
    );
    expect(within(dialog).getByText('G. Ray')).toBeInTheDocument();
  });
});

// --- Permission gating -----------------------------------------------------------

describe('permission gating', () => {
  it('hides every write affordance from a member without tenants/properties, while payment history and financials stay visible', async () => {
    renderUnit(
      unitRoutes([
        { method: 'GET', path: '/api/v1/settings/me', body: moneyOnlyMember },
        { method: 'GET', path: '/api/v1/units/u1', body: withRentPayments(unitADetailResponse()) },
      ]),
    );
    await screen.findByRole('heading', { name: 'Current lease' });

    // The member view settles once /settings/me lands.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Edit unit' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Archive unit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Draft renewal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit terms' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Co-tenants' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Terminate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create lease' })).not.toBeInTheDocument();

    // Reads stay visible: payment history table and the financials section.
    expect(
      screen.getByRole('table', { name: /rent payment history/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: /profit and loss, month to date and year to date/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View property transactions →' })).toBeInTheDocument();
  });
});

// --- Archived unit ---------------------------------------------------------------

describe('archived unit', () => {
  function archivedRoutes(overrides: RouteFixture[] = []): RouteFixture[] {
    const base: RouteFixture[] = [
      { method: 'GET', path: '/api/v1/units/u4', body: archivedUnitDetailResponse() },
      { method: 'GET', path: '/api/v1/settings/me', body: ownerUser },
      { method: 'GET', path: '/api/v1/documents', body: { documents: [], total: 0 } },
    ];
    for (const override of overrides) {
      const idx = base.findIndex((r) => r.method === override.method && r.path === override.path);
      if (idx >= 0) base[idx] = { ...base[idx]!, ...override };
      else base.push(override);
    }
    return base;
  }

  it('shows the archived banner and Restore for an owner, and hides the triage card', async () => {
    renderUnit(archivedRoutes(), '/units/u4');

    expect(
      await screen.findByText('This unit is archived and hidden from your lists.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore unit' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Needs attention' })).not.toBeInTheDocument();
  });

  it('hides Restore for a limited member', async () => {
    renderUnit(
      archivedRoutes([{ method: 'GET', path: '/api/v1/settings/me', body: moneyOnlyMember }]),
      '/units/u4',
    );

    expect(
      await screen.findByText('This unit is archived and hidden from your lists.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Restore unit' })).not.toBeInTheDocument(),
    );
  });
});

// --- Financials ---------------------------------------------------------------

describe('financials', () => {
  it('links "View property transactions" to the property-filtered ledger', async () => {
    renderUnit(unitRoutes());
    const link = await screen.findByRole('link', { name: 'View property transactions →' });
    expect(link).toHaveAttribute('href', '/money?propertyId=p1');
  });
});
