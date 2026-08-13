// Mortgages — the liability side of a property (PLAN-REAL-EQUITY §2/§4). All
// reads derive currentBalanceCents from the statement checkpoint via
// lib/mortgage-balance.ts; Phase 1 has no principal-bearing rows yet, so an
// empty payments array is passed — Phase 2's Transaction.principalCents only
// has to start feeding it real rows, no contract or call-shape change.
import type { CreateMortgageInput, Mortgage, UpdateMortgageInput } from '@hearth/shared';
import type { Mortgage as DbMortgage } from '@prisma/client';
import { iso, isoOrNull } from '../lib/dates';
import { BadRequestError, NotFoundError } from '../lib/errors';
import { deriveMortgageBalanceCents } from '../lib/mortgage-balance';
import { prisma } from '../lib/prisma';
import { writeAudit, type AuditActor } from './audit.service';

function toApiMortgage(m: DbMortgage, asOf: Date): Mortgage {
  return {
    id: m.id,
    accountId: m.accountId,
    propertyId: m.propertyId,
    lender: m.lender,
    balanceCents: m.balanceCents,
    balanceAsOfDate: iso(m.balanceAsOfDate),
    currentBalanceCents: deriveMortgageBalanceCents(
      { balanceCents: m.balanceCents, balanceAsOfDate: m.balanceAsOfDate },
      [],
      asOf,
    ),
    originalPrincipalCents: m.originalPrincipalCents,
    startDate: isoOrNull(m.startDate),
    interestRateMilliPct: m.interestRateMilliPct,
    escrowNote: m.escrowNote,
    notes: m.notes,
    createdAt: iso(m.createdAt),
    updatedAt: iso(m.updatedAt),
    archivedAt: isoOrNull(m.archivedAt),
  };
}

async function getOwnedProperty(accountId: string, propertyId: string): Promise<void> {
  const property = await prisma.property.findFirst({ where: { id: propertyId, accountId } });
  if (!property) throw new NotFoundError('property', propertyId);
}

async function getOwned(accountId: string, id: string): Promise<DbMortgage> {
  const row = await prisma.mortgage.findFirst({ where: { id, accountId } });
  if (!row) throw new NotFoundError('mortgage', id);
  return row;
}

export async function listForProperty(
  accountId: string,
  propertyId: string,
  asOf: Date = new Date(),
  // Archived mortgages stay out of every money surface, but the property hub
  // needs them visible to offer "restore" — the same reason `units[]` carries
  // archived units. Callers that sum liabilities must filter on `archivedAt`.
  opts: { includeArchived?: boolean } = {},
): Promise<Mortgage[]> {
  await getOwnedProperty(accountId, propertyId);
  const rows = await prisma.mortgage.findMany({
    where: { accountId, propertyId, ...(opts.includeArchived ? {} : { archivedAt: null }) },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => toApiMortgage(r, asOf));
}

export async function listForAccount(accountId: string, asOf: Date = new Date()): Promise<Mortgage[]> {
  const rows = await prisma.mortgage.findMany({
    where: { accountId, archivedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => toApiMortgage(r, asOf));
}

export async function create(
  accountId: string,
  propertyId: string,
  input: CreateMortgageInput,
  actor: AuditActor = 'user',
): Promise<Mortgage> {
  await getOwnedProperty(accountId, propertyId);
  const row = await prisma.mortgage.create({
    data: {
      accountId,
      propertyId,
      lender: input.lender,
      balanceCents: input.balanceCents,
      balanceAsOfDate: new Date(input.balanceAsOfDate),
      originalPrincipalCents: input.originalPrincipalCents ?? null,
      startDate: input.startDate ? new Date(input.startDate) : null,
      interestRateMilliPct: input.interestRateMilliPct ?? null,
      escrowNote: input.escrowNote ?? null,
      notes: input.notes ?? null,
    },
  });
  await writeAudit(accountId, {
    actor,
    action: 'mortgage.created',
    entityType: 'mortgage',
    entityId: row.id,
    detail: { propertyId, lender: row.lender, balanceCents: row.balanceCents },
  });
  return toApiMortgage(row, new Date());
}

/**
 * PATCH — also the re-checkpoint path. `UpdateMortgageInputSchema` only
 * accepts balanceCents/balanceAsOfDate together (or neither), so their joint
 * presence is exactly "this write re-checkpoints the balance" and gets its
 * own audit action; any other field change is a plain `mortgage.updated`.
 */
export async function update(
  accountId: string,
  id: string,
  input: UpdateMortgageInput,
  actor: AuditActor = 'user',
): Promise<Mortgage> {
  await getOwned(accountId, id);
  // The pairing rule lives here, not only in the route schema: chat/MCP tools
  // validate with their own composed shapes, and a balance saved without the
  // date it was true on silently corrupts every derived balance after it.
  if ((input.balanceCents === undefined) !== (input.balanceAsOfDate === undefined)) {
    throw new BadRequestError(
      'balanceCents and balanceAsOfDate must be updated together — a balance is only meaningful as of a date.',
    );
  }
  const isCheckpoint = input.balanceCents !== undefined && input.balanceAsOfDate !== undefined;
  const row = await prisma.mortgage.update({
    where: { id },
    data: {
      ...(input.lender !== undefined ? { lender: input.lender } : {}),
      ...(input.balanceCents !== undefined ? { balanceCents: input.balanceCents } : {}),
      ...(input.balanceAsOfDate !== undefined
        ? { balanceAsOfDate: new Date(input.balanceAsOfDate) }
        : {}),
      ...(input.originalPrincipalCents !== undefined
        ? { originalPrincipalCents: input.originalPrincipalCents }
        : {}),
      ...(input.startDate !== undefined ? { startDate: new Date(input.startDate) } : {}),
      ...(input.interestRateMilliPct !== undefined
        ? { interestRateMilliPct: input.interestRateMilliPct }
        : {}),
      ...(input.escrowNote !== undefined ? { escrowNote: input.escrowNote } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
  });
  await writeAudit(accountId, {
    actor,
    action: isCheckpoint ? 'mortgage.checkpointed' : 'mortgage.updated',
    entityType: 'mortgage',
    entityId: id,
    detail: isCheckpoint
      ? { balanceCents: row.balanceCents, balanceAsOfDate: iso(row.balanceAsOfDate) }
      : { lender: row.lender },
  });
  return toApiMortgage(row, new Date());
}

/** Soft-archive — drops the mortgage out of the balance sheet. */
export async function remove(accountId: string, id: string, actor: AuditActor = 'user'): Promise<void> {
  await getOwned(accountId, id);
  await prisma.mortgage.update({ where: { id }, data: { archivedAt: new Date() } });
  await writeAudit(accountId, { actor, action: 'mortgage.archived', entityType: 'mortgage', entityId: id });
}

export async function restore(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<Mortgage> {
  await getOwned(accountId, id);
  const row = await prisma.mortgage.update({ where: { id }, data: { archivedAt: null } });
  await writeAudit(accountId, { actor, action: 'mortgage.restored', entityType: 'mortgage', entityId: id });
  return toApiMortgage(row, new Date());
}
