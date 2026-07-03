import type { CreateUnitInput, Unit, UpdateUnitInput } from '@hearth/shared';
import type { Unit as DbUnit } from '@prisma/client';
import { NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';

export function toApiUnit(u: DbUnit): Unit {
  return {
    id: u.id,
    propertyId: u.propertyId,
    label: u.label,
    bedrooms: u.bedrooms,
    bathrooms: u.bathrooms,
    marketRentCents: u.marketRentCents,
  };
}

export async function create(
  accountId: string,
  propertyId: string,
  input: CreateUnitInput,
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
  return toApiUnit(row);
}

async function getOwned(accountId: string, id: string): Promise<DbUnit> {
  const row = await prisma.unit.findFirst({ where: { id, property: { accountId } } });
  if (!row) throw new NotFoundError('unit', id);
  return row;
}

export async function update(accountId: string, id: string, input: UpdateUnitInput): Promise<Unit> {
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
  return toApiUnit(row);
}

export async function remove(accountId: string, id: string): Promise<void> {
  await getOwned(accountId, id);
  await prisma.unit.delete({ where: { id } });
}
