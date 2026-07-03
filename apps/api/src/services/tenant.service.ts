import type {
  CreateTenantInput,
  Tenant,
  TenantDetailResponse,
  TenantListResponse,
  TenantStatus,
  UpdateTenantInput,
} from '@hearth/shared';
import type { Tenant as DbTenant } from '@prisma/client';
import { addDays, iso, isoOrNull } from '../lib/dates';
import { NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { toApiLease } from './lease.service';
import { deriveRentStatus } from './rent.service';

export function toApiTenant(t: DbTenant): Tenant {
  return {
    id: t.id,
    accountId: t.accountId,
    fullName: t.fullName,
    email: t.email,
    phone: t.phone,
    notes: t.notes,
    createdAt: iso(t.createdAt),
  };
}

const RENEW_SOON_DAYS = 60;

/**
 * Derivation rule (ARCHITECTURE §4, binding): late if any unpaid rent past
 * due; else renew_soon if lease.endDate ≤ today + 60d; else current.
 */
function deriveTenantStatus(
  leases: Array<{ endDate: Date; rentPayments: Array<{ status: string; dueDate: Date }> }>,
  graceDays: number,
  today: Date,
): TenantStatus {
  const anyLate = leases.some((l) =>
    l.rentPayments.some((p) => deriveRentStatus(p, graceDays, today).status === 'late'),
  );
  if (anyLate) return 'late';
  const renewCutoff = addDays(today, RENEW_SOON_DAYS);
  if (leases.some((l) => l.endDate <= renewCutoff)) return 'renew_soon';
  return 'current';
}

export async function list(accountId: string): Promise<TenantListResponse> {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const today = new Date();
  const tenants = await prisma.tenant.findMany({
    where: { accountId },
    include: {
      leaseTenants: {
        include: {
          lease: {
            include: {
              unit: { include: { property: true } },
              rentPayments: { where: { status: { notIn: ['paid'] } } },
            },
          },
        },
      },
    },
    orderBy: { fullName: 'asc' },
  });

  return tenants.map((t) => {
    const activeLeases = t.leaseTenants.map((lt) => lt.lease).filter((l) => l.status === 'active');
    const lease = activeLeases[0];
    const status = deriveTenantStatus(activeLeases, account.graceDays, today);
    return {
      id: t.id,
      fullName: t.fullName,
      email: t.email,
      phone: t.phone,
      unitId: lease?.unitId ?? null,
      unitLabel: lease?.unit.label ?? null,
      propertyId: lease?.unit.propertyId ?? null,
      propertyLabel: lease ? (lease.unit.property.nickname ?? lease.unit.property.addressLine1) : null,
      rentCents: lease?.rentCents ?? null,
      leaseEndDate: lease ? iso(lease.endDate) : null,
      status,
    };
  });
}

export async function getDetail(accountId: string, id: string): Promise<TenantDetailResponse> {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const tenant = await prisma.tenant.findFirst({
    where: { id, accountId },
    include: {
      leaseTenants: {
        include: {
          lease: {
            include: {
              unit: { include: { property: true } },
              rentPayments: { orderBy: { dueDate: 'desc' } },
            },
          },
        },
      },
    },
  });
  if (!tenant) throw new NotFoundError('tenant', id);

  const leases = tenant.leaseTenants.map((lt) => lt.lease);
  const paymentHistory = leases
    .flatMap((l) => l.rentPayments)
    .sort((a, b) => b.dueDate.getTime() - a.dueDate.getTime())
    .map((p) => {
      const derived = deriveRentStatus(p, account.graceDays);
      return {
        id: p.id,
        period: p.period,
        dueDate: iso(p.dueDate),
        amountCents: p.amountCents,
        status: derived.status,
        ...(derived.daysLate !== undefined ? { daysLate: derived.daysLate } : {}),
        method: p.method as 'online' | 'manual' | null,
        paidAt: isoOrNull(p.paidAt),
      };
    });

  return {
    tenant: toApiTenant(tenant),
    leases: leases.map((l) => ({
      ...toApiLease(l),
      unitLabel: l.unit.label,
      propertyId: l.unit.propertyId,
      propertyLabel: l.unit.property.nickname ?? l.unit.property.addressLine1,
    })),
    paymentHistory,
    documents: leases
      .filter((l) => l.esignEnvelopeId)
      .map((l) => ({
        id: l.esignEnvelopeId as string,
        name: `Signed lease — ${l.unit.property.nickname ?? l.unit.property.addressLine1} ${l.unit.label}`,
        url: `https://esign.mock.docusign.local/envelopes/${l.esignEnvelopeId}`,
        createdAt: iso(l.createdAt),
      })),
  };
}

export async function create(accountId: string, input: CreateTenantInput): Promise<Tenant> {
  const row = await prisma.tenant.create({
    data: {
      accountId,
      fullName: input.fullName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      notes: input.notes ?? null,
    },
  });
  return toApiTenant(row);
}

export async function update(
  accountId: string,
  id: string,
  input: UpdateTenantInput,
): Promise<Tenant> {
  const existing = await prisma.tenant.findFirst({ where: { id, accountId } });
  if (!existing) throw new NotFoundError('tenant', id);
  const row = await prisma.tenant.update({
    where: { id },
    data: {
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
  });
  return toApiTenant(row);
}

export async function remove(accountId: string, id: string): Promise<void> {
  const existing = await prisma.tenant.findFirst({ where: { id, accountId } });
  if (!existing) throw new NotFoundError('tenant', id);
  await prisma.tenant.delete({ where: { id } });
}
