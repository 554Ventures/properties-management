import type {
  CreateTenantInput,
  Tenant,
  TenantDetailResponse,
  TenantListResponse,
  TenantOnLease,
  TenantStatus,
  UpdateTenantInput,
} from '@hearth/shared';
import type { Tenant as DbTenant } from '@prisma/client';
import { addDays, iso, isoOrNull } from '../lib/dates';
import { ConflictError, NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { writeAudit, type AuditActor } from './audit.service';
import * as documentService from './document.service';
import { toApiLease } from './lease.service';
import { deriveRentStatus } from './rent.service';

/** A tenant as they appear on a lease roster: LeaseTenant link fields ride along. */
export function toTenantOnLease(lt: {
  isPrimary: boolean;
  shareCents: number | null;
  tenant: DbTenant;
}): TenantOnLease {
  return { ...toApiTenant(lt.tenant), isPrimary: lt.isPrimary, shareCents: lt.shareCents };
}

export function toApiTenant(t: DbTenant): Tenant {
  return {
    id: t.id,
    accountId: t.accountId,
    fullName: t.fullName,
    email: t.email,
    phone: t.phone,
    notes: t.notes,
    createdAt: iso(t.createdAt),
    archivedAt: isoOrNull(t.archivedAt),
  };
}

const RENEW_SOON_DAYS = 60;

/**
 * Derivation rule (ARCHITECTURE §4, binding): late if any unpaid rent past
 * due (including partially paid — daysLate presence covers both); else
 * renew_soon if lease.endDate ≤ today + 60d; else current.
 */
function deriveTenantStatus(
  leases: Array<{
    endDate: Date;
    rentPayments: Array<{ status: string; dueDate: Date; amountCents: number; paidCents: number }>;
  }>,
  graceDays: number,
  today: Date,
): TenantStatus {
  const anyLate = leases.some((l) =>
    l.rentPayments.some((p) => deriveRentStatus(p, graceDays, today).daysLate !== undefined),
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
    where: { accountId, archivedAt: null },
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
        paidCents: p.paidCents,
        status: derived.status,
        ...(derived.daysLate !== undefined ? { daysLate: derived.daysLate } : {}),
        method: p.method as 'online' | 'manual' | 'bank' | null,
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

export async function create(
  accountId: string,
  input: CreateTenantInput,
  actor: AuditActor = 'user',
): Promise<Tenant> {
  const row = await prisma.tenant.create({
    data: {
      accountId,
      fullName: input.fullName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      notes: input.notes ?? null,
    },
  });
  await writeAudit(accountId, {
    actor,
    action: 'create',
    entityType: 'tenant',
    entityId: row.id,
    detail: { fullName: row.fullName },
  });
  return toApiTenant(row);
}

export async function update(
  accountId: string,
  id: string,
  input: UpdateTenantInput,
  actor: AuditActor = 'user',
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
  await writeAudit(accountId, {
    actor,
    action: 'update',
    entityType: 'tenant',
    entityId: id,
    detail: { fullName: row.fullName },
  });
  return toApiTenant(row);
}

/** Soft-archive; blocked while the tenant is on an active lease. */
export async function remove(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<void> {
  const existing = await prisma.tenant.findFirst({ where: { id, accountId } });
  if (!existing) throw new NotFoundError('tenant', id);
  const activeLease = await prisma.lease.findFirst({
    where: { status: 'active', leaseTenants: { some: { tenantId: id } } },
  });
  if (activeLease) {
    throw new ConflictError('Terminate the active lease before archiving this tenant.');
  }
  await prisma.tenant.update({ where: { id }, data: { archivedAt: new Date() } });
  await writeAudit(accountId, { actor, action: 'archive', entityType: 'tenant', entityId: id });
}

export async function restore(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<Tenant> {
  const existing = await prisma.tenant.findFirst({ where: { id, accountId } });
  if (!existing) throw new NotFoundError('tenant', id);
  const row = await prisma.tenant.update({ where: { id }, data: { archivedAt: null } });
  await writeAudit(accountId, { actor, action: 'restore', entityType: 'tenant', entityId: id });
  return toApiTenant(row);
}

/**
 * Data erasure (docs/SECURITY_PRIVACY_AUDIT.md §B2): irreversibly anonymizes
 * a tenant's PII in place — the row, id, and every Lease/LeaseTenant/
 * RentPayment/Transaction it's linked to stay intact, since those are
 * financial/accounting records (tax/tenant-ledger reports) with a legal
 * retention basis independent of the erasure request. Only removes what's
 * actually personal data: contact fields, this tenant's uploaded documents
 * (real PII-bearing files, e.g. a lease or ID scan), and any Insight rows
 * that reference them (cheap to regenerate; often embed the tenant's name in
 * free text).
 */
export async function erasePii(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<Tenant> {
  const existing = await prisma.tenant.findFirst({ where: { id, accountId } });
  if (!existing) throw new NotFoundError('tenant', id);

  const documents = await prisma.document.findMany({
    where: { accountId, entityType: 'tenant', entityId: id },
    select: { id: true },
  });
  for (const doc of documents) {
    await documentService.remove(accountId, doc.id, actor);
  }
  await prisma.insight.deleteMany({ where: { accountId, tenantId: id } });

  const row = await prisma.tenant.update({
    where: { id },
    data: { fullName: 'Former Tenant (PII erased)', email: null, phone: null, notes: null },
  });
  await writeAudit(accountId, {
    actor,
    action: 'tenant.pii_erased',
    entityType: 'tenant',
    entityId: id,
    // Counts only — the whole point is no PII survives in the audit trail either.
    detail: { documentsRemoved: documents.length },
  });
  return toApiTenant(row);
}
