// Shared fixture builders for the property-hub tests (PropertyDetail.test.tsx
// and the a11y suite): one populated property that exercises every triage and
// table state, plus the method-aware fetch stub both files use. Lease dates
// are relative to "now" so the renewal-window math stays deterministic
// whenever the suite runs.
import type {
  CurrentUser,
  LeaseWithTenants,
  PnlSummary,
  Property,
  PropertyDetailResponse,
  PropertyDetailUnit,
  RenewalDraftResponse,
  TenantOnLease,
  UnitDetailResponse,
} from '@hearth/shared';
import { vi } from 'vitest';

const DAY = 86_400_000;

/** ISO datetime `days` from now (fractional keeps daysUntil's ceil exact). */
export function isoIn(days: number): string {
  return new Date(Date.now() + days * DAY).toISOString();
}

export const PERIOD = '2026-07';

export function makeTenant(
  id: string,
  fullName: string,
  overrides: Partial<TenantOnLease> = {},
): TenantOnLease {
  return {
    id,
    accountId: 'acc1',
    fullName,
    email: null,
    phone: null,
    notes: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    archivedAt: null,
    isPrimary: true,
    shareCents: null,
    ...overrides,
  };
}

export function makeLease(
  id: string,
  unitId: string,
  rentCents: number,
  tenants: TenantOnLease[],
  overrides: Partial<LeaseWithTenants> = {},
): LeaseWithTenants {
  return {
    id,
    unitId,
    rentCents,
    dueDay: 1,
    startDate: isoIn(-300),
    endDate: isoIn(300.5),
    status: 'active',
    esignEnvelopeId: null,
    esignStatus: null,
    createdAt: isoIn(-300),
    tenants,
    ...overrides,
  };
}

export function makeUnit(
  id: string,
  label: string,
  overrides: Partial<PropertyDetailUnit> = {},
): PropertyDetailUnit {
  return {
    id,
    propertyId: 'p1',
    label,
    bedrooms: null,
    bathrooms: null,
    marketRentCents: null,
    archivedAt: null,
    status: 'vacant',
    currentLease: null,
    rent: null,
    leaseCount: 0,
    pendingLease: null,
    ...overrides,
  };
}

export function makeProperty(overrides: Partial<Property> = {}): Property {
  return {
    id: 'p1',
    accountId: 'acc1',
    nickname: null,
    addressLine1: '12 Maple St',
    city: 'Springfield',
    state: 'IL',
    zip: '62704',
    acquisitionDate: null,
    acquisitionCostCents: null,
    notes: null,
    createdAt: '2020-01-01T00:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

export const pnl: PnlSummary = {
  mtd: { incomeCents: 500000, expenseCents: 120000, netCents: 380000 },
  ytd: { incomeCents: 3400000, expenseCents: 910000, netCents: 2490000 },
};

// --- The populated hub ------------------------------------------------------
// Unit A: late rent (3 days, $700 of $1,400), 1 prior lease, e-sign signed,
//         primary tenant with full contact info + a co-tenant.
// Unit B: paid, lease ends in 58 days (renewal window), tenant with no
//         contact info and no rent share.
// Unit C: vacant.
// Unit D: archived (hidden behind the toggle).
// Unit E: partial rent ($600 of $1,200).
// Unit F: paid, lease ends in 30 days but a pending_signature renewal exists.

export const park = makeTenant('t-park', 'D. Park', {
  email: 'park@example.com',
  phone: '555-0101',
  shareCents: 70000,
});
export const parkCo = makeTenant('t-park-co', 'C. Park', { isPrimary: false });
export const novak = makeTenant('t-novak', 'S. Novak');
export const chen = makeTenant('t-chen', 'R. Chen');
export const quinn = makeTenant('t-quinn', 'P. Quinn');

export const parkLease = makeLease('l1', 'u1', 140000, [park, parkCo], {
  esignStatus: 'signed',
});
export const novakLease = makeLease('l2', 'u2', 120000, [novak], { endDate: isoIn(57.5) });
export const chenLease = makeLease('l5', 'u5', 120000, [chen]);
export const quinnLease = makeLease('l6', 'u6', 110000, [quinn], { endDate: isoIn(29.5) });
export const quinnPendingLease = makeLease('l6p', 'u6', 115000, [quinn], {
  startDate: isoIn(30),
  endDate: isoIn(395),
  status: 'pending_signature',
});

export function hubDetailResponse(): PropertyDetailResponse {
  return {
    property: makeProperty(),
    units: [
      makeUnit('u1', 'Unit A', {
        bedrooms: 2,
        bathrooms: 1,
        marketRentCents: 135000,
        status: 'occupied',
        currentLease: parkLease,
        rent: {
          period: PERIOD,
          status: 'late',
          daysLate: 3,
          paidCents: 70000,
          amountCents: 140000,
          dueDate: isoIn(-3),
        },
        leaseCount: 2,
      }),
      makeUnit('u2', 'Unit B', {
        marketRentCents: 120000,
        status: 'occupied',
        currentLease: novakLease,
        rent: {
          period: PERIOD,
          status: 'paid',
          daysLate: null,
          paidCents: 120000,
          amountCents: 120000,
          dueDate: isoIn(-12),
        },
        leaseCount: 1,
      }),
      makeUnit('u3', 'Unit C', { bedrooms: 1, bathrooms: 1, marketRentCents: 95000 }),
      makeUnit('u4', 'Unit D', { archivedAt: '2025-06-01T00:00:00.000Z', leaseCount: 1 }),
      makeUnit('u5', 'Unit E', {
        status: 'occupied',
        currentLease: chenLease,
        rent: {
          period: PERIOD,
          status: 'partial',
          daysLate: null,
          paidCents: 60000,
          amountCents: 120000,
          dueDate: isoIn(-12),
        },
        leaseCount: 1,
      }),
      makeUnit('u6', 'Unit F', {
        status: 'occupied',
        currentLease: quinnLease,
        rent: {
          period: PERIOD,
          status: 'paid',
          daysLate: null,
          paidCents: 110000,
          amountCents: 110000,
          dueDate: isoIn(-12),
        },
        leaseCount: 2,
        pendingLease: quinnPendingLease,
      }),
    ],
    pnl,
    insights: [],
  };
}

/** Unit A's detail payload for the lazily-fetched lease-history modal. */
export function unitADetailResponse(): UnitDetailResponse {
  const priorLease = makeLease('l0', 'u1', 128000, [makeTenant('t-former', 'F. Ormer')], {
    startDate: isoIn(-665),
    endDate: isoIn(-300),
    status: 'ended',
  });
  return {
    unit: {
      id: 'u1',
      propertyId: 'p1',
      label: 'Unit A',
      bedrooms: 2,
      bathrooms: 1,
      marketRentCents: 135000,
      archivedAt: null,
    },
    propertyId: 'p1',
    propertyLabel: '12 Maple St',
    status: 'occupied',
    currentLease: parkLease,
    leases: [parkLease, priorLease],
    rentPayments: [],
    pnl,
  };
}

export const novakRenewalDraft: RenewalDraftResponse = {
  leaseId: 'l2',
  currentRentCents: 120000,
  suggestedRentCents: 126000,
  marketRentCents: 120000,
  proposedStartDate: isoIn(58),
  proposedEndDate: isoIn(423),
  dueDay: 1,
};

export const ownerUser: CurrentUser = { userId: null, role: 'owner', permissions: [] };
export const moneyOnlyMember: CurrentUser = {
  userId: 'u-member',
  role: 'member',
  permissions: ['money'],
};

// --- Fetch stub --------------------------------------------------------------

export interface RouteFixture {
  method: string;
  path: string;
  body: unknown;
  status?: number;
}

/** Method-aware fetch mock (same pattern as leaseInteractions.test.tsx). */
export function makeFetch(routes: RouteFixture[]) {
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

/** The standard route set for a populated property hub, owner view. */
export function hubRoutes(overrides: Partial<RouteFixture>[] = []): RouteFixture[] {
  const base: RouteFixture[] = [
    { method: 'GET', path: '/api/v1/properties/p1', body: hubDetailResponse() },
    { method: 'GET', path: '/api/v1/settings/me', body: ownerUser },
    { method: 'GET', path: '/api/v1/documents', body: { documents: [], total: 0 } },
    { method: 'GET', path: '/api/v1/units/u1', body: unitADetailResponse() },
    { method: 'POST', path: '/api/v1/leases/l2/renewal-draft', body: novakRenewalDraft },
  ];
  for (const override of overrides) {
    const idx = base.findIndex((r) => r.method === override.method && r.path === override.path);
    if (idx >= 0) base[idx] = { ...base[idx]!, ...override };
    else base.push(override as RouteFixture);
  }
  return base;
}
