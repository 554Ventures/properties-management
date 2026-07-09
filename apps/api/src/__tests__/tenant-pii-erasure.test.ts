// Data erasure — tenant PII anonymization (docs/SECURITY_PRIVACY_AUDIT.md
// §B2): fullName/email/phone/notes are wiped in place, this tenant's
// PII-bearing Documents and referencing Insights are hard-deleted, but the
// Lease/LeaseTenant/RentPayment/Transaction history stays intact (financial
// recordkeeping is a recognized retention basis independent of the erasure
// request).
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { iso } from '../lib/dates';
import { prisma } from '../lib/prisma';
import * as documentService from '../services/document.service';
import * as leaseService from '../services/lease.service';
import * as propertyService from '../services/property.service';
import * as tenantService from '../services/tenant.service';

process.env.STORAGE_DIR = mkdtempSync(path.join(os.tmpdir(), 'hearth-pii-erasure-test-'));

let accountId: string;
let tenantId: string;
let leaseId: string;
let documentId: string;
let insightId: string;

beforeAll(async () => {
  const account = await prisma.account.create({
    data: { name: 'PII Erasure Test', email: 'pii-erasure@integrationtest.example' },
  });
  accountId = account.id;

  const property = await propertyService.create(accountId, {
    addressLine1: '1 Erase PII St',
    city: 'Springfield',
    state: 'IL',
    zip: '62701',
    units: [{ label: 'Unit A' }],
  });
  const detail = await propertyService.getDetail(accountId, property.id);
  const unitId = detail.units[0]!.id;

  const tenant = await tenantService.create(accountId, {
    fullName: 'Pat Erasable',
    email: 'pat@erasable.example',
    phone: '555-0100',
    notes: 'Called about a leaky faucet in March.',
  });
  tenantId = tenant.id;

  const start = new Date();
  const end = new Date(start.getTime() + 1000 * 60 * 60 * 24 * 365);
  const lease = await leaseService.create(accountId, {
    unitId,
    tenantIds: [tenantId],
    rentCents: 150000,
    dueDay: 1,
    startDate: iso(start),
    endDate: iso(end),
  });
  leaseId = lease.id;

  const document = await documentService.create(accountId, {
    entityType: 'tenant',
    entityId: tenantId,
    type: 'lease',
    name: 'pat-id-scan.pdf',
    buffer: Buffer.from('%PDF-1.4\nid scan\n%%EOF', 'utf-8'),
    mimeType: 'application/pdf',
  });
  documentId = document.id;

  const insight = await prisma.insight.create({
    data: {
      accountId,
      scope: 'tenant',
      tenantId,
      type: 'late_rent',
      severity: 'warning',
      title: 'Pat Erasable is late',
      body: 'Pat Erasable has an outstanding balance.',
      dedupeKey: `late_rent:pii-erasure-test:${tenantId}`,
      status: 'active',
    },
  });
  insightId = insight.id;
});

afterAll(async () => {
  await prisma.account.deleteMany({ where: { email: { endsWith: '@integrationtest.example' } } });
});

describe('tenantService.erasePii', () => {
  it('anonymizes contact fields, hard-deletes tenant documents and insights, keeps lease history', async () => {
    const result = await tenantService.erasePii(accountId, tenantId);

    expect(result.fullName).not.toContain('Pat');
    expect(result.email).toBeNull();
    expect(result.phone).toBeNull();
    expect(result.notes).toBeNull();

    // The tenant row and its lease link survive under the same id — history
    // (rent roll, tenant ledger) still resolves correctly.
    const row = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(row.id).toBe(tenantId);
    const lease = await prisma.lease.findUniqueOrThrow({ where: { id: leaseId } });
    expect(lease.id).toBe(leaseId);
    const leaseTenant = await prisma.leaseTenant.findUnique({
      where: { leaseId_tenantId: { leaseId, tenantId } },
    });
    expect(leaseTenant).not.toBeNull();

    // PII-bearing document and its bytes are gone.
    expect(await prisma.document.findUnique({ where: { id: documentId } })).toBeNull();

    // Insight referencing the tenant is gone (cheap to regenerate; often
    // embeds the tenant's name in free text).
    expect(await prisma.insight.findUnique({ where: { id: insightId } })).toBeNull();

    // The erasure itself is audited, without leaking PII into the log.
    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'tenant.pii_erased', entityId: tenantId },
    });
    expect(audit).not.toBeNull();
    const detail = JSON.parse(audit!.detailJson!);
    expect(detail).toEqual({ documentsRemoved: 1 });
    expect(JSON.stringify(detail)).not.toMatch(/Pat|erasable|555-0100/i);
  });

  it('404s for a tenant that does not belong to the account', async () => {
    const other = await prisma.account.create({
      data: { name: 'Other Account', email: 'pii-erasure-other@integrationtest.example' },
    });
    await expect(tenantService.erasePii(other.id, tenantId)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
