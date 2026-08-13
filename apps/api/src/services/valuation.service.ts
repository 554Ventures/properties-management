// Property valuations — the asset side of real equity (PLAN-REAL-EQUITY §2/§4).
// Append-only history; every value is owner-entered, never a market estimate.
// "The figure in use" is always derived (latest row with asOfDate <= the date
// being reported), never stored.
import type { CreatePropertyValuationInput, PropertyValuation, ValuationSource } from '@hearth/shared';
import type { PropertyValuation as DbPropertyValuation } from '@prisma/client';
import { iso } from '../lib/dates';
import { NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { writeAudit, type AuditActor } from './audit.service';

function toApiValuation(v: DbPropertyValuation): PropertyValuation {
  return {
    id: v.id,
    accountId: v.accountId,
    propertyId: v.propertyId,
    valueCents: v.valueCents,
    asOfDate: iso(v.asOfDate),
    source: v.source as ValuationSource,
    notes: v.notes,
    createdAt: iso(v.createdAt),
  };
}

async function getOwnedProperty(accountId: string, propertyId: string): Promise<void> {
  const property = await prisma.property.findFirst({ where: { id: propertyId, accountId } });
  if (!property) throw new NotFoundError('property', propertyId);
}

async function getOwned(accountId: string, id: string): Promise<DbPropertyValuation> {
  const row = await prisma.propertyValuation.findFirst({ where: { id, accountId } });
  if (!row) throw new NotFoundError('valuation', id);
  return row;
}

/** Full history for a property, newest first. */
export async function listForProperty(
  accountId: string,
  propertyId: string,
): Promise<PropertyValuation[]> {
  await getOwnedProperty(accountId, propertyId);
  const rows = await prisma.propertyValuation.findMany({
    where: { accountId, propertyId },
    // createdAt breaks asOfDate ties deterministically: re-recording a value
    // for the same date is how a typo gets corrected, and without a tiebreaker
    // the single-property and whole-account queries can pick different rows —
    // the property hub and the filed balance sheet would then disagree.
    orderBy: [{ asOfDate: 'desc' }, { createdAt: 'desc' }],
  });
  return rows.map(toApiValuation);
}

/** Highest asOfDate that is <= asOf (default now); null if every row is in the future. */
export async function latestForProperty(
  accountId: string,
  propertyId: string,
  asOf: Date = new Date(),
): Promise<PropertyValuation | null> {
  const row = await prisma.propertyValuation.findFirst({
    where: { accountId, propertyId, asOfDate: { lte: asOf } },
    // createdAt breaks asOfDate ties deterministically: re-recording a value
    // for the same date is how a typo gets corrected, and without a tiebreaker
    // the single-property and whole-account queries can pick different rows —
    // the property hub and the filed balance sheet would then disagree.
    orderBy: [{ asOfDate: 'desc' }, { createdAt: 'desc' }],
  });
  return row ? toApiValuation(row) : null;
}

/** latestForProperty for every property in the account, in one query. */
export async function latestByProperty(
  accountId: string,
  asOf: Date = new Date(),
): Promise<Map<string, PropertyValuation>> {
  const rows = await prisma.propertyValuation.findMany({
    where: { accountId, asOfDate: { lte: asOf } },
    // createdAt breaks asOfDate ties deterministically: re-recording a value
    // for the same date is how a typo gets corrected, and without a tiebreaker
    // the single-property and whole-account queries can pick different rows —
    // the property hub and the filed balance sheet would then disagree.
    orderBy: [{ asOfDate: 'desc' }, { createdAt: 'desc' }],
  });
  const map = new Map<string, PropertyValuation>();
  for (const row of rows) {
    if (!map.has(row.propertyId)) map.set(row.propertyId, toApiValuation(row));
  }
  return map;
}

export async function create(
  accountId: string,
  propertyId: string,
  input: CreatePropertyValuationInput,
  actor: AuditActor = 'user',
): Promise<PropertyValuation> {
  await getOwnedProperty(accountId, propertyId);
  const row = await prisma.propertyValuation.create({
    data: {
      accountId,
      propertyId,
      valueCents: input.valueCents,
      asOfDate: new Date(input.asOfDate),
      source: input.source,
      notes: input.notes ?? null,
    },
  });
  await writeAudit(accountId, {
    actor,
    action: 'valuation.recorded',
    entityType: 'valuation',
    entityId: row.id,
    detail: { propertyId, valueCents: row.valueCents, asOfDate: iso(row.asOfDate), source: row.source },
  });
  return toApiValuation(row);
}

/** Hard delete — correcting your own entered estimate, not a soft-archive. */
export async function remove(accountId: string, id: string, actor: AuditActor = 'user'): Promise<void> {
  const row = await getOwned(accountId, id);
  await prisma.propertyValuation.delete({ where: { id } });
  await writeAudit(accountId, {
    actor,
    action: 'valuation.deleted',
    entityType: 'valuation',
    entityId: id,
    detail: { propertyId: row.propertyId, valueCents: row.valueCents },
  });
}
