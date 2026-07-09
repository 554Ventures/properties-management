// Document upload/list/download/delete (routes/documents.ts +
// services/document.service.ts) against the seeded test DB. Bytes go through
// the mock storage adapter into a per-run temp dir (STORAGE_DIR below — the
// adapter resolves it per call, so setting it after import hoisting is fine).
// Every row this file creates is deleted again so other suites' pinned
// numbers stay intact.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import FormData from 'form-data';
import { DocumentListResponseSchema, DocumentSchema, TransactionSchema } from '@hearth/shared';
import { SEED_DOCUMENTS } from '../../prisma/seed-constants';
import { buildApp } from '../app';
import { iso } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';

process.env.STORAGE_DIR = mkdtempSync(path.join(os.tmpdir(), 'hearth-docs-test-'));

const PDF_BYTES = Buffer.from('%PDF-1.4\nHearth documents test payload\n%%EOF', 'utf-8');

let app: FastifyInstance;
const createdDocIds: string[] = [];
const createdTxnIds: string[] = [];
const createdAccountIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  const accountId = await getDemoAccountId();
  await prisma.document.deleteMany({ where: { id: { in: createdDocIds } } });
  await prisma.transaction.deleteMany({ where: { id: { in: createdTxnIds } } });
  // Audit rows this file generated (no other suite pins document audits, but
  // leave the log as the seed made it).
  await prisma.auditLog.deleteMany({ where: { accountId, entityType: 'document' } });
  await prisma.auditLog.deleteMany({
    where: { accountId, entityType: 'transaction', entityId: { in: createdTxnIds } },
  });
  await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
  await app.close();
});

// Text fields must come BEFORE the file part: the route reads `file.fields`,
// which only contains parts parsed before the file (matches how the web
// client builds its FormData).
function uploadForm(
  fields: Record<string, string>,
  file: { filename?: string; contentType?: string; content?: Buffer } = {},
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('file', file.content ?? PDF_BYTES, {
    filename: file.filename ?? 'test-upload.pdf',
    contentType: file.contentType ?? 'application/pdf',
  });
  return form;
}

async function upload(
  fields: Record<string, string>,
  file: { filename?: string; contentType?: string; content?: Buffer } = {},
) {
  const form = uploadForm(fields, file);
  return app.inject({
    method: 'POST',
    url: '/api/v1/documents',
    payload: form.getBuffer(),
    headers: form.getHeaders(),
  });
}

async function createTestTransaction(description: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/transactions',
    payload: { date: iso(new Date()), amountCents: 4200, type: 'expense', description },
  });
  expect(res.statusCode).toBe(201);
  const txn = TransactionSchema.parse(res.json());
  createdTxnIds.push(txn.id);
  return txn;
}

async function seededEntities() {
  const accountId = await getDemoAccountId();
  const property = await prisma.property.findFirstOrThrow({
    where: { accountId, archivedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  const unit = await prisma.unit.findFirstOrThrow({ where: { propertyId: property.id } });
  const okaforLease = await prisma.lease.findFirstOrThrow({
    where: { esignEnvelopeId: 'env_mock_seed_okafor' },
    include: { unit: true, leaseTenants: true },
  });
  const okaforTenantId = okaforLease.leaseTenants[0]!.tenantId;
  return { accountId, property, unit, okaforLease, okaforTenantId };
}

describe('POST /documents', () => {
  it('uploads a PDF against every entity type', async () => {
    const { property, unit, okaforLease, okaforTenantId } = await seededEntities();
    const txn = await createTestTransaction('ZZDOC upload target');
    const targets = [
      { entityType: 'property', entityId: property.id },
      { entityType: 'unit', entityId: unit.id },
      { entityType: 'tenant', entityId: okaforTenantId },
      { entityType: 'lease', entityId: okaforLease.id },
      { entityType: 'transaction', entityId: txn.id },
    ];
    for (const target of targets) {
      const res = await upload({ ...target, type: 'other', name: `ZZDOC ${target.entityType}.pdf` });
      expect(res.statusCode).toBe(201);
      const doc = DocumentSchema.parse(res.json());
      createdDocIds.push(doc.id);
      expect(doc.entityType).toBe(target.entityType);
      expect(doc.entityId).toBe(target.entityId);
      expect(doc.sizeBytes).toBe(PDF_BYTES.length);
      expect(doc.mimeType).toBe('application/pdf');
    }
  });

  it('defaults name to the uploaded filename and writes a user audit row', async () => {
    const { accountId, property } = await seededEntities();
    const res = await upload(
      { entityType: 'property', entityId: property.id, type: 'other' },
      { filename: 'zzdoc-audit-check.pdf' },
    );
    expect(res.statusCode).toBe(201);
    const doc = DocumentSchema.parse(res.json());
    createdDocIds.push(doc.id);
    expect(doc.name).toBe('zzdoc-audit-check.pdf');

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'document.uploaded', entityId: doc.id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actor).toBe('user');
    expect(JSON.parse(audit!.detailJson!)).toEqual({
      name: 'zzdoc-audit-check.pdf',
      attachedTo: `property:${property.id}`,
      sizeBytes: PDF_BYTES.length,
    });
  });

  it('rejects a disallowed mimetype with a 400', async () => {
    const { property } = await seededEntities();
    const res = await upload(
      { entityType: 'property', entityId: property.id, type: 'other' },
      { filename: 'notes.txt', contentType: 'text/plain' },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
    expect(res.json().error.message).toMatch(/Unsupported file type/);
  });

  it('rejects a file whose content does not match its declared (spoofed) Content-Type', async () => {
    // A polyglot-style attack: label an HTML/script payload as a PDF so it
    // clears the client-declared-mimetype check, hoping it's trusted and
    // later served back inline. Magic-byte verification must catch this even
    // though the declared Content-Type says application/pdf.
    const { property } = await seededEntities();
    const htmlPayload = Buffer.from('<html><body><script>alert(1)</script></body></html>', 'utf-8');
    const res = await upload(
      { entityType: 'property', entityId: property.id, type: 'other' },
      { filename: 'spoofed.pdf', contentType: 'application/pdf', content: htmlPayload },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
    expect(res.json().error.message).toMatch(/Unsupported file type/);
  });

  it('persists the content-sniffed mimeType, not the client-declared one', async () => {
    // A real PNG's bytes labeled (incorrectly, but not maliciously) as PDF —
    // the stored/served mimeType must reflect verified content, not the label.
    const { property } = await seededEntities();
    const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const res = await upload(
      { entityType: 'property', entityId: property.id, type: 'other' },
      { filename: 'mislabeled.pdf', contentType: 'application/pdf', content: pngBytes },
    );
    expect(res.statusCode).toBe(201);
    const doc = DocumentSchema.parse(res.json());
    createdDocIds.push(doc.id);
    expect(doc.mimeType).toBe('image/png');
  });

  it('rejects a request with no file part with a 400', async () => {
    const form = new FormData();
    form.append('entityType', 'property');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      payload: form.getBuffer(),
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/file field is required/);
  });

  it("404s when the entity belongs to another account or doesn't exist", async () => {
    const other = await prisma.account.create({
      data: { name: 'Other Landlord', email: `documents-test-${Date.now()}@example.com` },
    });
    createdAccountIds.push(other.id);
    const otherProperty = await prisma.property.create({
      data: {
        accountId: other.id,
        addressLine1: '1 Elsewhere Rd',
        city: 'Springfield',
        state: 'IL',
        zip: '62704',
      },
    });

    const crossAccount = await upload({
      entityType: 'property',
      entityId: otherProperty.id,
      type: 'other',
    });
    expect(crossAccount.statusCode).toBe(404);

    const missing = await upload({ entityType: 'tenant', entityId: 'nonexistent', type: 'other' });
    expect(missing.statusCode).toBe(404);
  });
});

describe('GET /documents (derivation, filters)', () => {
  it('a lease document appears under its tenant AND its property, not an unrelated tenant', async () => {
    const { accountId, okaforLease, okaforTenantId } = await seededEntities();
    const res = await upload({
      entityType: 'lease',
      entityId: okaforLease.id,
      type: 'notice',
      name: 'ZZDOC lease-scoped notice.pdf',
    });
    const doc = DocumentSchema.parse(res.json());
    createdDocIds.push(doc.id);

    const byTenant = DocumentListResponseSchema.parse(
      (await app.inject({ url: `/api/v1/documents?tenantId=${okaforTenantId}` })).json(),
    );
    expect(byTenant.documents.map((d) => d.id)).toContain(doc.id);

    const byProperty = DocumentListResponseSchema.parse(
      (
        await app.inject({ url: `/api/v1/documents?propertyId=${okaforLease.unit.propertyId}` })
      ).json(),
    );
    expect(byProperty.documents.map((d) => d.id)).toContain(doc.id);
    // The row resolves display context back to the owning property/tenant.
    const row = byProperty.documents.find((d) => d.id === doc.id)!;
    expect(row.propertyId).toBe(okaforLease.unit.propertyId);
    expect(row.tenantId).toBe(okaforTenantId);
    expect(row.entityLabel).toContain('Lease —');

    const unrelatedTenant = await prisma.tenant.findFirstOrThrow({
      where: { accountId, id: { not: okaforTenantId }, archivedAt: null },
    });
    const byUnrelated = DocumentListResponseSchema.parse(
      (await app.inject({ url: `/api/v1/documents?tenantId=${unrelatedTenant.id}` })).json(),
    );
    expect(byUnrelated.documents.map((d) => d.id)).not.toContain(doc.id);
  });

  it('filters by q and type, and caps limit', async () => {
    const { property } = await seededEntities();
    const inspection = await upload({
      entityType: 'property',
      entityId: property.id,
      type: 'inspection',
      name: 'ZZFILTER inspection walkthrough.pdf',
    });
    const inspectionDoc = DocumentSchema.parse(inspection.json());
    createdDocIds.push(inspectionDoc.id);
    const tax = await upload({
      entityType: 'property',
      entityId: property.id,
      type: 'tax',
      name: 'ZZFILTER assessment.pdf',
    });
    const taxDoc = DocumentSchema.parse(tax.json());
    createdDocIds.push(taxDoc.id);

    const byQ = DocumentListResponseSchema.parse(
      (await app.inject({ url: '/api/v1/documents?q=zzfilter%20inspection' })).json(),
    );
    expect(byQ.documents.map((d) => d.id)).toEqual([inspectionDoc.id]);

    const byType = DocumentListResponseSchema.parse(
      (await app.inject({ url: '/api/v1/documents?type=tax&q=ZZFILTER' })).json(),
    );
    expect(byType.documents.map((d) => d.id)).toEqual([taxDoc.id]);

    const limited = DocumentListResponseSchema.parse(
      (await app.inject({ url: '/api/v1/documents?limit=1' })).json(),
    );
    expect(limited.documents).toHaveLength(1);

    const overCap = await app.inject({ url: '/api/v1/documents?limit=501' });
    expect(overCap.statusCode).toBe(400);
  });

  it('lists the seeded documents by their pinned names', async () => {
    const list = DocumentListResponseSchema.parse(
      (await app.inject({ url: '/api/v1/documents' })).json(),
    );
    const names = list.documents.map((d) => d.name);
    expect(names).toContain(SEED_DOCUMENTS.insurancePolicy.name);
    expect(names).toContain(SEED_DOCUMENTS.signedLease.name);
  });
});

describe('GET /documents/:id/download', () => {
  it('round-trips the uploaded bytes with the right headers', async () => {
    const { property } = await seededEntities();
    const res = await upload({
      entityType: 'property',
      entityId: property.id,
      type: 'other',
      name: 'ZZDOC roundtrip.pdf',
    });
    const doc = DocumentSchema.parse(res.json());
    createdDocIds.push(doc.id);

    const download = await app.inject({ url: `/api/v1/documents/${doc.id}/download` });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('application/pdf');
    expect(download.headers['content-disposition']).toBe(
      "inline; filename=\"ZZDOC roundtrip.pdf\"; filename*=UTF-8''ZZDOC%20roundtrip.pdf",
    );
    expect(Buffer.compare(download.rawPayload, PDF_BYTES)).toBe(0);
  });
});

describe('PATCH /documents/:id', () => {
  it('renames and retypes a document', async () => {
    const { property } = await seededEntities();
    const res = await upload({
      entityType: 'property',
      entityId: property.id,
      type: 'other',
      name: 'ZZDOC before.pdf',
    });
    const doc = DocumentSchema.parse(res.json());
    createdDocIds.push(doc.id);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${doc.id}`,
      payload: { name: 'ZZDOC after.pdf', type: 'insurance' },
    });
    expect(patched.statusCode).toBe(200);
    const updated = DocumentSchema.parse(patched.json());
    expect(updated.name).toBe('ZZDOC after.pdf');
    expect(updated.type).toBe('insurance');
  });
});

describe('cross-account isolation (download/patch/delete/list)', () => {
  it("another account's document is invisible to every scoped route", async () => {
    const other = await prisma.account.create({
      data: { name: 'Other Landlord 2', email: `documents-isolation-${Date.now()}@example.com` },
    });
    createdAccountIds.push(other.id);
    const foreignDoc = await prisma.document.create({
      data: {
        accountId: other.id,
        entityType: 'property',
        entityId: 'someone-elses-property',
        type: 'other',
        name: 'foreign.pdf',
        storageKey: `${other.id}/foreign/foreign.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 10,
      },
    });

    // Demo-account requests must 404, never leak bytes or mutate.
    const download = await app.inject({ url: `/api/v1/documents/${foreignDoc.id}/download` });
    expect(download.statusCode).toBe(404);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${foreignDoc.id}`,
      payload: { name: 'stolen.pdf' },
    });
    expect(patched.statusCode).toBe(404);
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${foreignDoc.id}`,
    });
    expect(deleted.statusCode).toBe(404);

    const list = DocumentListResponseSchema.parse(
      (await app.inject({ url: '/api/v1/documents' })).json(),
    );
    expect(list.documents.map((d) => d.id)).not.toContain(foreignDoc.id);
    // Untouched by the PATCH/DELETE attempts.
    const still = await prisma.document.findUniqueOrThrow({ where: { id: foreignDoc.id } });
    expect(still.name).toBe('foreign.pdf');
  });
});

describe('hostile filenames', () => {
  it('a traversal filename is defanged and still round-trips', async () => {
    const { property } = await seededEntities();
    const res = await upload(
      { entityType: 'property', entityId: property.id, type: 'other' },
      { filename: '../../ZZDOC escape.pdf' },
    );
    expect(res.statusCode).toBe(201);
    const doc = DocumentSchema.parse(res.json());
    createdDocIds.push(doc.id);
    const row = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(row.storageKey).not.toContain('..');

    const download = await app.inject({ url: `/api/v1/documents/${doc.id}/download` });
    expect(download.statusCode).toBe(200);
    expect(Buffer.compare(download.rawPayload, PDF_BYTES)).toBe(0);
  });

  it('a non-ASCII filename downloads with an RFC 5987 header instead of a 500', async () => {
    const { property } = await seededEntities();
    const res = await upload(
      { entityType: 'property', entityId: property.id, type: 'other' },
      { filename: 'ZZDOC 契約書 №4.pdf' },
    );
    expect(res.statusCode).toBe(201);
    const doc = DocumentSchema.parse(res.json());
    createdDocIds.push(doc.id);

    const download = await app.inject({ url: `/api/v1/documents/${doc.id}/download` });
    expect(download.statusCode).toBe(200);
    const disposition = download.headers['content-disposition'] as string;
    // ASCII fallback plus the full UTF-8 name.
    expect(disposition).toContain('filename="ZZDOC ___ _4.pdf"');
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('ZZDOC 契約書 №4.pdf')}`);
    expect(Buffer.compare(download.rawPayload, PDF_BYTES)).toBe(0);
  });
});

describe('receipt flow (transaction + type receipt)', () => {
  it('sets receiptUrl on upload and clears it on delete', async () => {
    const { accountId } = await seededEntities();
    const txn = await createTestTransaction('ZZDOC receipt target');
    expect(txn.receiptUrl).toBeNull();

    const res = await upload({
      entityType: 'transaction',
      entityId: txn.id,
      type: 'receipt',
      name: 'ZZDOC receipt.pdf',
    });
    const doc = DocumentSchema.parse(res.json());
    createdDocIds.push(doc.id);

    const linked = await prisma.transaction.findUniqueOrThrow({ where: { id: txn.id } });
    expect(linked.receiptUrl).toBe(`/api/v1/documents/${doc.id}/download`);

    // A second receipt never clobbers the existing link.
    const second = await upload({
      entityType: 'transaction',
      entityId: txn.id,
      type: 'receipt',
      name: 'ZZDOC receipt-2.pdf',
    });
    const secondDoc = DocumentSchema.parse(second.json());
    createdDocIds.push(secondDoc.id);
    const stillFirst = await prisma.transaction.findUniqueOrThrow({ where: { id: txn.id } });
    expect(stillFirst.receiptUrl).toBe(`/api/v1/documents/${doc.id}/download`);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/documents/${doc.id}` });
    expect(deleted.statusCode).toBe(204);

    const cleared = await prisma.transaction.findUniqueOrThrow({ where: { id: txn.id } });
    expect(cleared.receiptUrl).toBeNull();
    expect(await prisma.document.findUnique({ where: { id: doc.id } })).toBeNull();

    const download = await app.inject({ url: `/api/v1/documents/${doc.id}/download` });
    expect(download.statusCode).toBe(404);

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'document.deleted', entityId: doc.id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actor).toBe('user');
  });
});
