// Documents: uploaded files attached to exactly one entity (property/unit/
// tenant/lease/transaction). Bytes live behind the storage adapter (mock
// filesystem or Supabase Storage); this table is the metadata. Display context
// is derived at query time — a lease document also shows under the lease's
// property and tenants — never stored twice.
import { randomUUID } from 'node:crypto';
import type {
  Document,
  DocumentEntityType,
  DocumentListQuery,
  DocumentListResponse,
  DocumentListRow,
  DocumentType,
  UpdateDocumentInput,
} from '@hearth/shared';
import type { Document as DbDocument, Prisma } from '@prisma/client';
import { createStorageAdapter } from '../integrations/factory';
import { iso } from '../lib/dates';
import { NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { writeAudit, type AuditActor } from './audit.service';

export function toApiDocument(d: DbDocument): Document {
  return {
    id: d.id,
    accountId: d.accountId,
    entityType: d.entityType as DocumentEntityType,
    entityId: d.entityId,
    type: d.type as DocumentType,
    name: d.name,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    createdAt: iso(d.createdAt),
  };
}

/**
 * Filename → safe storage-key segment / download filename: strips path
 * separators, control characters and double quotes, caps at 128 chars, falls
 * back to 'document' when nothing survives.
 */
export function sanitizeFilename(raw: string): string {
  const cleaned = raw
    .replace(/[/\\"]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 128);
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'document' : cleaned;
}

function storageKeyFor(accountId: string, documentId: string, name: string): string {
  return `${accountId}/${documentId}/${sanitizeFilename(name)}`;
}

function downloadPath(documentId: string): string {
  return `/api/v1/documents/${documentId}/download`;
}

/** The target entity must exist and belong to the account, else 404. */
export async function assertEntityOwned(
  accountId: string,
  entityType: DocumentEntityType,
  entityId: string,
): Promise<void> {
  const found = await (() => {
    switch (entityType) {
      case 'property':
        return prisma.property.findFirst({ where: { id: entityId, accountId } });
      case 'unit':
        return prisma.unit.findFirst({ where: { id: entityId, property: { accountId } } });
      case 'tenant':
        return prisma.tenant.findFirst({ where: { id: entityId, accountId } });
      case 'lease':
        return prisma.lease.findFirst({
          where: { id: entityId, unit: { property: { accountId } } },
        });
      case 'transaction':
        return prisma.transaction.findFirst({ where: { id: entityId, accountId } });
    }
  })();
  if (!found) throw new NotFoundError(entityType, entityId);
}

/** entityType of an owned document, or null when it isn't ours / doesn't exist. */
export async function entityTypeOf(
  accountId: string,
  id: string,
): Promise<DocumentEntityType | null> {
  const row = await prisma.document.findFirst({
    where: { id, accountId },
    select: { entityType: true },
  });
  return row ? (row.entityType as DocumentEntityType) : null;
}

export async function create(
  accountId: string,
  input: {
    entityType: DocumentEntityType;
    entityId: string;
    type: DocumentType;
    name: string;
    buffer: Buffer;
    mimeType: string;
  },
  actor: AuditActor = 'user',
): Promise<Document> {
  await assertEntityOwned(accountId, input.entityType, input.entityId);

  // Pre-generate the id so the row is created with its final storage key in
  // one step — no window where a half-keyed row could persist.
  const id = randomUUID();
  const storageKey = storageKeyFor(accountId, id, input.name);
  const row = await prisma.document.create({
    data: {
      id,
      accountId,
      entityType: input.entityType,
      entityId: input.entityId,
      type: input.type,
      name: input.name,
      storageKey,
      mimeType: input.mimeType,
      sizeBytes: input.buffer.length,
      uploadedByActor: actor,
    },
  });

  try {
    await createStorageAdapter().put(storageKey, input.buffer, input.mimeType);
  } catch (err) {
    // No orphan metadata: a row without bytes behind it would 404 forever.
    await prisma.document.delete({ where: { id: row.id } });
    throw err;
  }

  // A receipt on a transaction becomes its receipt link — but never clobbers
  // an existing one.
  if (input.entityType === 'transaction' && input.type === 'receipt') {
    await prisma.transaction.updateMany({
      where: { id: input.entityId, accountId, receiptUrl: null },
      data: { receiptUrl: downloadPath(row.id) },
    });
  }

  await writeAudit(accountId, {
    actor,
    action: 'document.uploaded',
    entityType: 'document',
    entityId: row.id,
    detail: {
      name: input.name,
      attachedTo: `${input.entityType}:${input.entityId}`,
      sizeBytes: input.buffer.length,
    },
  });
  return toApiDocument(row);
}

const MAX_LIMIT = 500;

export async function list(
  accountId: string,
  query: DocumentListQuery,
): Promise<DocumentListResponse> {
  const base: Prisma.DocumentWhereInput = {
    accountId,
    ...(query.type ? { type: query.type } : {}),
    ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
    ...(query.entityType ? { entityType: query.entityType } : {}),
    ...(query.entityId ? { entityId: query.entityId } : {}),
  };

  // propertyId/tenantId include derived context (docs attached to the
  // property's units/leases/transactions; docs on the tenant's leases). When
  // both are given the groups are ANDed — documents visible from both.
  const contextGroups: Prisma.DocumentWhereInput[] = [];
  if (query.propertyId) {
    const property = await prisma.property.findFirst({
      where: { id: query.propertyId, accountId },
    });
    if (!property) throw new NotFoundError('property', query.propertyId);
    const units = await prisma.unit.findMany({
      where: { propertyId: property.id },
      select: { id: true },
    });
    const unitIds = units.map((u) => u.id);
    const leases = await prisma.lease.findMany({
      where: { unitId: { in: unitIds } },
      select: { id: true },
    });
    const txns = await prisma.transaction.findMany({
      where: { accountId, propertyId: property.id },
      select: { id: true },
    });
    contextGroups.push({
      OR: [
        { entityType: 'property', entityId: property.id },
        { entityType: 'unit', entityId: { in: unitIds } },
        { entityType: 'lease', entityId: { in: leases.map((l) => l.id) } },
        { entityType: 'transaction', entityId: { in: txns.map((t) => t.id) } },
      ],
    });
  }
  if (query.tenantId) {
    const tenant = await prisma.tenant.findFirst({ where: { id: query.tenantId, accountId } });
    if (!tenant) throw new NotFoundError('tenant', query.tenantId);
    const leaseTenants = await prisma.leaseTenant.findMany({
      where: { tenantId: tenant.id },
      select: { leaseId: true },
    });
    contextGroups.push({
      OR: [
        { entityType: 'tenant', entityId: tenant.id },
        { entityType: 'lease', entityId: { in: leaseTenants.map((lt) => lt.leaseId) } },
      ],
    });
  }

  const where: Prisma.DocumentWhereInput = contextGroups.length
    ? { AND: [base, ...contextGroups] }
    : base;
  // total is the full match count — the page may be truncated by limit.
  const [rows, total] = await Promise.all([
    prisma.document.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(query.limit ?? MAX_LIMIT, MAX_LIMIT),
    }),
    prisma.document.count({ where }),
  ]);

  const labels = await resolveEntityLabels(rows);
  const documents: DocumentListRow[] = rows.map((d) => {
    const label = labels.get(`${d.entityType}:${d.entityId}`) ?? {
      // Attached entity hard-deleted since upload (no FK — polymorphic).
      entityLabel: `${d.entityType} (removed)`,
      propertyId: null,
      tenantId: null,
    };
    return { ...toApiDocument(d), ...label };
  });
  return { documents, total };
}

interface EntityLabel {
  entityLabel: string;
  propertyId: string | null;
  tenantId: string | null;
}

/** Batched label lookup — one query per referenced entity type (≤5 total). */
async function resolveEntityLabels(
  rows: Array<{ entityType: string; entityId: string }>,
): Promise<Map<string, EntityLabel>> {
  const idsByType = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!idsByType.has(r.entityType)) idsByType.set(r.entityType, new Set());
    idsByType.get(r.entityType)!.add(r.entityId);
  }
  const ids = (type: string) => [...(idsByType.get(type) ?? [])];
  const labels = new Map<string, EntityLabel>();
  const propertyLabel = (p: { nickname: string | null; addressLine1: string }) =>
    p.nickname ?? p.addressLine1;

  if (idsByType.has('property')) {
    const properties = await prisma.property.findMany({ where: { id: { in: ids('property') } } });
    for (const p of properties) {
      labels.set(`property:${p.id}`, {
        entityLabel: propertyLabel(p),
        propertyId: p.id,
        tenantId: null,
      });
    }
  }
  if (idsByType.has('unit')) {
    const units = await prisma.unit.findMany({
      where: { id: { in: ids('unit') } },
      include: { property: true },
    });
    for (const u of units) {
      labels.set(`unit:${u.id}`, {
        entityLabel: `${propertyLabel(u.property)} — ${u.label}`,
        propertyId: u.propertyId,
        tenantId: null,
      });
    }
  }
  if (idsByType.has('tenant')) {
    const tenants = await prisma.tenant.findMany({ where: { id: { in: ids('tenant') } } });
    for (const t of tenants) {
      labels.set(`tenant:${t.id}`, {
        entityLabel: t.fullName,
        propertyId: null,
        tenantId: t.id,
      });
    }
  }
  if (idsByType.has('lease')) {
    const leases = await prisma.lease.findMany({
      where: { id: { in: ids('lease') } },
      include: { unit: { include: { property: true } }, leaseTenants: true },
    });
    for (const l of leases) {
      const primary = l.leaseTenants.find((lt) => lt.isPrimary) ?? l.leaseTenants[0];
      labels.set(`lease:${l.id}`, {
        entityLabel: `Lease — ${l.unit.label} @ ${propertyLabel(l.unit.property)}`,
        propertyId: l.unit.propertyId,
        tenantId: primary?.tenantId ?? null,
      });
    }
  }
  if (idsByType.has('transaction')) {
    const txns = await prisma.transaction.findMany({ where: { id: { in: ids('transaction') } } });
    for (const t of txns) {
      labels.set(`transaction:${t.id}`, {
        entityLabel: `${t.description} (${iso(t.date).slice(0, 10)})`,
        propertyId: t.propertyId,
        tenantId: null,
      });
    }
  }
  return labels;
}

export async function getForDownload(
  accountId: string,
  id: string,
): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const row = await prisma.document.findFirst({ where: { id, accountId } });
  if (!row) throw new NotFoundError('document', id);
  const buffer = await createStorageAdapter().get(row.storageKey);
  if (!buffer) throw new NotFoundError('document', id);
  return { name: row.name, mimeType: row.mimeType, buffer };
}

export async function update(
  accountId: string,
  id: string,
  input: UpdateDocumentInput,
  actor: AuditActor = 'user',
): Promise<Document> {
  const existing = await prisma.document.findFirst({ where: { id, accountId } });
  if (!existing) throw new NotFoundError('document', id);
  const row = await prisma.document.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
    },
  });
  await writeAudit(accountId, {
    actor,
    action: 'document.updated',
    entityType: 'document',
    entityId: id,
    detail: { name: row.name, type: row.type },
  });
  return toApiDocument(row);
}

export async function remove(
  accountId: string,
  id: string,
  actor: AuditActor = 'user',
): Promise<void> {
  const existing = await prisma.document.findFirst({ where: { id, accountId } });
  if (!existing) throw new NotFoundError('document', id);
  await prisma.document.delete({ where: { id } });
  try {
    await createStorageAdapter().delete(existing.storageKey);
  } catch (err) {
    // Best-effort: an orphaned blob must never block the metadata delete.
    console.error(`[documents] storage delete failed for ${existing.storageKey}`, err);
  }
  // A transaction pointing at this document as its receipt loses the link.
  await prisma.transaction.updateMany({
    where: { accountId, receiptUrl: downloadPath(id) },
    data: { receiptUrl: null },
  });
  await writeAudit(accountId, {
    actor,
    action: 'document.deleted',
    entityType: 'document',
    entityId: id,
    detail: { name: existing.name },
  });
}
