import type {
  CreateLeaseInput,
  EsignEnvelopeResponse,
  EsignStatus,
  Lease,
  LeaseListResponse,
  LeaseStatus,
  RenewalDraftResponse,
  UpdateLeaseInput,
} from '@hearth/shared';
import type { Lease as DbLease } from '@prisma/client';
import { addDays, iso, isoOrNull } from '../lib/dates';
import { NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { mockDocusign } from '../integrations/mock/mock-docusign';

export function toApiLease(l: DbLease): Lease {
  return {
    id: l.id,
    unitId: l.unitId,
    rentCents: l.rentCents,
    dueDay: l.dueDay,
    startDate: iso(l.startDate),
    endDate: iso(l.endDate),
    status: l.status as LeaseStatus,
    esignEnvelopeId: l.esignEnvelopeId,
    esignStatus: l.esignStatus as EsignStatus | null,
    createdAt: iso(l.createdAt),
  };
}

export async function list(
  accountId: string,
  filter?: { status?: LeaseStatus },
): Promise<LeaseListResponse> {
  const rows = await prisma.lease.findMany({
    where: {
      unit: { property: { accountId } },
      ...(filter?.status ? { status: filter.status } : {}),
    },
    orderBy: { endDate: 'asc' },
  });
  return rows.map(toApiLease);
}

async function getOwned(accountId: string, id: string): Promise<DbLease> {
  const row = await prisma.lease.findFirst({
    where: { id, unit: { property: { accountId } } },
  });
  if (!row) throw new NotFoundError('lease', id);
  return row;
}

export async function create(accountId: string, input: CreateLeaseInput): Promise<Lease> {
  const unit = await prisma.unit.findFirst({
    where: { id: input.unitId, property: { accountId } },
  });
  if (!unit) throw new NotFoundError('unit', input.unitId);
  const tenants = await prisma.tenant.findMany({
    where: { id: { in: input.tenantIds }, accountId },
  });
  if (tenants.length !== input.tenantIds.length) throw new NotFoundError('tenant');

  const row = await prisma.lease.create({
    data: {
      unitId: input.unitId,
      rentCents: input.rentCents,
      dueDay: input.dueDay,
      startDate: new Date(input.startDate),
      endDate: new Date(input.endDate),
      status: 'active',
      leaseTenants: {
        create: input.tenantIds.map((tenantId, i) => ({ tenantId, isPrimary: i === 0 })),
      },
    },
  });
  return toApiLease(row);
}

export async function update(accountId: string, id: string, input: UpdateLeaseInput): Promise<Lease> {
  await getOwned(accountId, id);
  const row = await prisma.lease.update({
    where: { id },
    data: {
      ...(input.rentCents !== undefined ? { rentCents: input.rentCents } : {}),
      ...(input.dueDay !== undefined ? { dueDay: input.dueDay } : {}),
      ...(input.startDate !== undefined ? { startDate: new Date(input.startDate) } : {}),
      ...(input.endDate !== undefined ? { endDate: new Date(input.endDate) } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
  });
  return toApiLease(row);
}

/** Market-rent heuristic: unit market rent when it beats current, else +3%. */
export async function draftRenewal(
  accountId: string,
  leaseId: string,
): Promise<RenewalDraftResponse> {
  const lease = await prisma.lease.findFirst({
    where: { id: leaseId, unit: { property: { accountId } } },
    include: { unit: true },
  });
  if (!lease) throw new NotFoundError('lease', leaseId);
  const marketRentCents = lease.unit.marketRentCents;
  const suggestedRentCents =
    marketRentCents && marketRentCents > lease.rentCents
      ? marketRentCents
      : Math.round((lease.rentCents * 1.03) / 100) * 100;
  const proposedStartDate = addDays(lease.endDate, 1);
  const proposedEnd = new Date(proposedStartDate);
  proposedEnd.setUTCFullYear(proposedEnd.getUTCFullYear() + 1);
  return {
    leaseId,
    currentRentCents: lease.rentCents,
    suggestedRentCents,
    marketRentCents,
    proposedStartDate: iso(proposedStartDate),
    proposedEndDate: iso(addDays(proposedEnd, -1)),
    dueDay: lease.dueDay,
  };
}

export async function sendForEsign(
  accountId: string,
  leaseId: string,
): Promise<EsignEnvelopeResponse> {
  const lease = await prisma.lease.findFirst({
    where: { id: leaseId, unit: { property: { accountId } } },
    include: { leaseTenants: { include: { tenant: true }, orderBy: { isPrimary: 'desc' } } },
  });
  if (!lease) throw new NotFoundError('lease', leaseId);
  const signerName = lease.leaseTenants[0]?.tenant.fullName ?? 'tenant';
  const envelope = await mockDocusign.sendEnvelope(leaseId, signerName);
  const now = new Date();
  await prisma.lease.update({
    where: { id: leaseId },
    data: { esignEnvelopeId: envelope.envelopeId, esignStatus: envelope.status },
  });
  return {
    leaseId,
    envelopeId: envelope.envelopeId,
    status: envelope.status,
    sentAt: iso(now),
  };
}
