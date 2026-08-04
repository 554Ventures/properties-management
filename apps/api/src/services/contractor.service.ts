import type {
  Contractor,
  ContractorDetailResponse,
  ContractorJobRow,
  ContractorListRow,
  CreateContractorInput,
  LogContractorJobInput,
  LogContractorJobResponse,
  UpdateContractorInput,
} from '@hearth/shared';
import type { Contractor as DbContractor, Transaction as DbTransaction } from '@prisma/client';
import { addDays, iso, isoOrNull } from '../lib/dates';
import { NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { writeAudit, type AuditActor } from './audit.service';
import * as transactionService from './transaction.service';
import { vendorKey } from './vendor';

export function toApiContractor(c: DbContractor): Contractor {
  return {
    id: c.id,
    accountId: c.accountId,
    name: c.name,
    trade: c.trade,
    rating: c.rating,
    phone: c.phone,
    email: c.email,
    website: c.website,
    notes: c.notes,
    createdAt: iso(c.createdAt),
    archivedAt: isoOrNull(c.archivedAt),
  };
}

/**
 * Derivation rule (ARCHITECTURE §4, binding): jobsCount/avgCostCents/lastUsedAt
 * derive from confirmed, ordinary (classification-null) expense transactions
 * linked via Transaction.contractorId; no history → jobsCount 0 with
 * avgCostCents/lastUsedAt null. avgCostCents = round(total/count). The link
 * itself is stamped at write time by vendor-name match (services/vendor.ts
 * matchContractorId) and by adoptMatchingTransactions below — reads never
 * re-match strings, so a rename can't orphan history.
 */
export async function list(accountId: string): Promise<ContractorListRow[]> {
  const contractors = await prisma.contractor.findMany({
    where: { accountId, archivedAt: null },
    orderBy: { name: 'asc' },
  });

  const groups = await prisma.transaction.groupBy({
    by: ['contractorId'],
    where: { accountId, type: 'expense', status: 'confirmed', classification: null, contractorId: { not: null } },
    _count: true,
    _sum: { amountCents: true },
    _max: { date: true },
  });
  const statsByContractor = new Map(
    groups.map((g) => [
      g.contractorId as string,
      { count: g._count, totalCents: g._sum.amountCents ?? 0, lastDate: g._max.date as Date },
    ]),
  );

  return contractors.map((c) => {
    const stats = statsByContractor.get(c.id);
    return {
      id: c.id,
      name: c.name,
      trade: c.trade,
      rating: c.rating,
      phone: c.phone,
      email: c.email,
      website: c.website,
      notes: c.notes,
      jobsCount: stats?.count ?? 0,
      avgCostCents: stats ? Math.round(stats.totalCents / stats.count) : null,
      lastUsedAt: stats ? iso(stats.lastDate) : null,
    };
  });
}

async function getOwned(accountId: string, id: string): Promise<DbContractor> {
  const row = await prisma.contractor.findFirst({ where: { id, accountId } });
  if (!row) throw new NotFoundError('contractor', id);
  return row;
}

/**
 * Every active contractor with its linked jobs, newest first — the same
 * contractorId derivation as list()/detail() (ARCHITECTURE §4), factored out
 * so the insight rules can reason about individual jobs (latest vs. prior
 * average) without re-deriving the set. One transaction scan for the account.
 */
export async function activeContractorsWithJobs(
  accountId: string,
): Promise<Array<{ contractor: DbContractor; jobs: Array<{ date: Date; amountCents: number; description: string }> }>> {
  const contractors = await prisma.contractor.findMany({
    where: { accountId, archivedAt: null },
    orderBy: { name: 'asc' },
  });
  if (contractors.length === 0) return [];
  const candidates = await prisma.transaction.findMany({
    where: { accountId, type: 'expense', status: 'confirmed', classification: null, contractorId: { not: null } },
    select: { contractorId: true, date: true, amountCents: true, description: true },
    orderBy: { date: 'desc' },
  });
  const byContractor = new Map<string, Array<{ date: Date; amountCents: number; description: string }>>();
  for (const t of candidates) {
    const list = byContractor.get(t.contractorId as string) ?? [];
    list.push({ date: t.date, amountCents: t.amountCents, description: t.description });
    byContractor.set(t.contractorId as string, list);
  }
  return contractors.map((contractor) => ({
    contractor,
    jobs: byContractor.get(contractor.id) ?? [],
  }));
}

type JobCandidate = DbTransaction & {
  property: { nickname: string | null; addressLine1: string } | null;
};

/** Shared job-row mapping for detail()'s derived history and logJob()'s duplicate candidates. */
function toJobRow(t: JobCandidate): ContractorJobRow {
  return {
    id: t.id,
    date: iso(t.date),
    description: t.description,
    amountCents: t.amountCents,
    propertyLabel: t.property ? (t.property.nickname ?? t.property.addressLine1) : null,
  };
}

/**
 * Detail view: the contractor plus its derived job history — the same
 * contractorId derivation as list() (ARCHITECTURE §4), so stats always agree
 * with the list row. Archived contractors stay viewable here (this is where a
 * restore surface would live). Read-only, no audit.
 */
export async function detail(accountId: string, id: string): Promise<ContractorDetailResponse> {
  const contractor = await getOwned(accountId, id);

  const matched = await prisma.transaction.findMany({
    where: { accountId, contractorId: id, type: 'expense', status: 'confirmed', classification: null },
    include: { property: { select: { nickname: true, addressLine1: true } } },
    orderBy: { date: 'desc' },
  });

  const totalCents = matched.reduce((sum, t) => sum + t.amountCents, 0);
  return {
    contractor: toApiContractor(contractor),
    jobsCount: matched.length,
    avgCostCents: matched.length > 0 ? Math.round(totalCents / matched.length) : null,
    lastUsedAt: matched.length > 0 ? iso(matched[0]!.date) : null,
    jobs: matched.map(toJobRow),
  };
}

/**
 * Confirmed expense transactions already linked to this contractor that could
 * be the same job re-logged: dated within `windowDays` of `date`. Mirrors the
 * review queue's rent-match heuristic — computed at request time, never
 * stored (ARCHITECTURE §4).
 */
async function findDuplicateCandidates(
  accountId: string,
  contractorId: string,
  date: Date,
  windowDays = 3,
): Promise<ContractorJobRow[]> {
  const candidates = await prisma.transaction.findMany({
    where: {
      accountId,
      contractorId,
      type: 'expense',
      status: 'confirmed',
      date: { gte: addDays(date, -windowDays), lte: addDays(date, windowDays) },
    },
    include: { property: { select: { nickname: true, addressLine1: true } } },
    orderBy: { date: 'desc' },
  });
  return candidates.map(toJobRow);
}

/**
 * Manually log a job: creates a real confirmed expense transaction (vendor =
 * contractor name) via transaction.service's create() — job history stays
 * 100% derived from transactions (ARCHITECTURE §4), there is no separate job
 * ledger. Unless the caller already confirmed, a nearby same-vendor expense
 * surfaces as a possible duplicate instead of creating anything.
 */
export async function logJob(
  accountId: string,
  contractorId: string,
  input: LogContractorJobInput,
  actor: AuditActor = 'user',
): Promise<LogContractorJobResponse> {
  const contractor = await getOwned(accountId, contractorId);

  if (!input.confirmDuplicate) {
    const duplicates = await findDuplicateCandidates(accountId, contractor.id, new Date(input.date));
    if (duplicates.length > 0) {
      return { status: 'possible_duplicate', duplicates };
    }
  }

  // System categories are seeded with accountId: null — scope by name/type and
  // match either system or account-owned rows (same pattern as
  // transaction.service.ts's suggestCategory), not just this account.
  const repairsCategory = await prisma.category.findFirst({
    where: { name: 'Repairs', type: 'expense', OR: [{ isSystem: true }, { accountId }] },
  });
  const created = await transactionService.create(
    accountId,
    {
      date: input.date,
      amountCents: input.amountCents,
      type: 'expense',
      description: input.description,
      vendor: contractor.name,
      propertyId: input.propertyId,
      categoryId: repairsCategory?.id,
    },
    // Explicit link: the caller chose this contractor, so no vendor-name
    // round-trip (which would null out on an ambiguous directory name).
    { source: 'manual', status: 'confirmed', actor, contractorId: contractor.id },
  );

  const property = created.propertyId
    ? await prisma.property.findUnique({
        where: { id: created.propertyId },
        select: { nickname: true, addressLine1: true },
      })
    : null;

  return {
    status: 'created',
    job: {
      id: created.id,
      date: created.date,
      description: created.description,
      amountCents: created.amountCents,
      propertyLabel: property ? (property.nickname ?? property.addressLine1) : null,
    },
  };
}

/**
 * Adopt every not-yet-linked transaction whose vendor matches this
 * contractor's name (same vendorKey rule as write-time matching) — run when a
 * contractor is created, renamed, or restored, so directory changes pick up
 * history the same way it always has. Two guards: rows already linked (to
 * anyone) are never stolen, and if several ACTIVE contractors share the name
 * key nothing links (ambiguity suppresses, matching matchContractorId). Also
 * used by the seed after the demo ledger exists.
 */
export async function adoptMatchingTransactions(
  accountId: string,
  contractorId: string,
): Promise<void> {
  const contractor = await prisma.contractor.findUniqueOrThrow({ where: { id: contractorId } });
  const key = vendorKey(contractor.name);
  const active = await prisma.contractor.findMany({
    where: { accountId, archivedAt: null },
    select: { name: true },
  });
  if (active.filter((c) => vendorKey(c.name) === key).length !== 1) return;
  const unlinked = await prisma.transaction.findMany({
    where: { accountId, contractorId: null, vendor: { not: null } },
    select: { id: true, vendor: true },
  });
  const ids = unlinked.filter((t) => vendorKey(t.vendor as string) === key).map((t) => t.id);
  if (ids.length > 0) {
    await prisma.transaction.updateMany({
      where: { id: { in: ids } },
      data: { contractorId },
    });
  }
}

export async function create(
  accountId: string,
  input: CreateContractorInput,
  actor: AuditActor = 'user',
): Promise<Contractor> {
  const row = await prisma.contractor.create({
    data: {
      accountId,
      name: input.name,
      trade: input.trade,
      rating: input.rating ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      website: input.website ?? null,
      notes: input.notes ?? null,
    },
  });
  await adoptMatchingTransactions(accountId, row.id);
  await writeAudit(accountId, {
    actor,
    action: 'create',
    entityType: 'contractor',
    entityId: row.id,
    detail: { name: row.name, trade: row.trade },
  });
  return toApiContractor(row);
}

export async function update(
  accountId: string,
  id: string,
  input: UpdateContractorInput,
  actor: AuditActor = 'user',
): Promise<Contractor> {
  const prior = await getOwned(accountId, id);
  const row = await prisma.contractor.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.trade !== undefined ? { trade: input.trade } : {}),
      ...(input.rating !== undefined ? { rating: input.rating } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.website !== undefined ? { website: input.website } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
  });
  // A rename NEVER unlinks existing history (the jobs were done by this
  // contractor; the name is a label — that's the point of the FK). It only
  // adopts unlinked rows matching the NEW name, e.g. renaming the directory
  // entry to match how the bank feed spells the vendor.
  if (input.name !== undefined && vendorKey(input.name) !== vendorKey(prior.name)) {
    await adoptMatchingTransactions(accountId, id);
  }
  await writeAudit(accountId, {
    actor,
    action: 'update',
    entityType: 'contractor',
    entityId: id,
    detail: { name: row.name },
  });
  return toApiContractor(row);
}

/** Soft-archive. */
export async function remove(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<void> {
  await getOwned(accountId, id);
  await prisma.contractor.update({ where: { id }, data: { archivedAt: new Date() } });
  await writeAudit(accountId, { actor, action: 'archive', entityType: 'contractor', entityId: id });
}

export async function restore(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<Contractor> {
  await getOwned(accountId, id);
  const row = await prisma.contractor.update({ where: { id }, data: { archivedAt: null } });
  // Vendor rows written while this contractor was archived didn't match
  // anything at write time — pick them up now that it's back in the directory.
  await adoptMatchingTransactions(accountId, id);
  await writeAudit(accountId, { actor, action: 'restore', entityType: 'contractor', entityId: id });
  return toApiContractor(row);
}
