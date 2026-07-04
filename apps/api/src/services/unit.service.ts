import type { CreateUnitInput, Unit, UpdateUnitInput } from '@hearth/shared';
import type { Unit as DbUnit } from '@prisma/client';
import { isoOrNull } from '../lib/dates';
import { ConflictError, NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { writeAudit, type AuditActor } from './audit.service';

export function toApiUnit(u: DbUnit): Unit {
  return {
    id: u.id,
    propertyId: u.propertyId,
    label: u.label,
    bedrooms: u.bedrooms,
    bathrooms: u.bathrooms,
    marketRentCents: u.marketRentCents,
    archivedAt: isoOrNull(u.archivedAt),
  };
}

export async function create(
  accountId: string,
  propertyId: string,
  input: CreateUnitInput,
  actor: AuditActor = 'user',
): Promise<Unit> {
  const property = await prisma.property.findFirst({ where: { id: propertyId, accountId } });
  if (!property) throw new NotFoundError('property', propertyId);
  const row = await prisma.unit.create({
    data: {
      propertyId,
      label: input.label,
      bedrooms: input.bedrooms ?? null,
      bathrooms: input.bathrooms ?? null,
      marketRentCents: input.marketRentCents ?? null,
    },
  });
  await writeAudit(accountId, {
    actor,
    action: 'create',
    entityType: 'unit',
    entityId: row.id,
    detail: { propertyId, label: row.label },
  });
  return toApiUnit(row);
}

async function getOwned(accountId: string, id: string): Promise<DbUnit> {
  const row = await prisma.unit.findFirst({ where: { id, property: { accountId } } });
  if (!row) throw new NotFoundError('unit', id);
  return row;
}

export async function update(
  accountId: string,
  id: string,
  input: UpdateUnitInput,
  actor: AuditActor = 'user',
): Promise<Unit> {
  await getOwned(accountId, id);
  const row = await prisma.unit.update({
    where: { id },
    data: {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.bedrooms !== undefined ? { bedrooms: input.bedrooms } : {}),
      ...(input.bathrooms !== undefined ? { bathrooms: input.bathrooms } : {}),
      ...(input.marketRentCents !== undefined ? { marketRentCents: input.marketRentCents } : {}),
    },
  });
  await writeAudit(accountId, {
    actor,
    action: 'update',
    entityType: 'unit',
    entityId: id,
    detail: { label: row.label },
  });
  return toApiUnit(row);
}

/** Soft-archive; blocked while the unit still has an active lease. */
export async function remove(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<void> {
  await getOwned(accountId, id);
  const activeLease = await prisma.lease.findFirst({ where: { status: 'active', unitId: id } });
  if (activeLease) {
    throw new ConflictError('Terminate the active lease before archiving this unit.');
  }
  await prisma.unit.update({ where: { id }, data: { archivedAt: new Date() } });
  await writeAudit(accountId, { actor, action: 'archive', entityType: 'unit', entityId: id });
}

export async function restore(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<Unit> {
  await getOwned(accountId, id);
  const row = await prisma.unit.update({ where: { id }, data: { archivedAt: null } });
  await writeAudit(accountId, { actor, action: 'restore', entityType: 'unit', entityId: id });
  return toApiUnit(row);
}
