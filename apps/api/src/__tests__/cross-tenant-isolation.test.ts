// Cross-tenant isolation (security remediation, docs/SECURITY_PRIVACY_AUDIT.md
// §A2/§A3 "RLS Tier 1"): the deployment plan's own launch checklist has an
// unchecked item — "cross-account isolation verified with a second,
// non-owner account" — because today the ONLY isolation boundary is the
// service layer's accountId scoping (RLS is enabled but has no policies and
// the app connects as a privileged role that bypasses it regardless).
//
// This suite builds two real, fully-populated accounts directly through the
// service layer (the same functions routes call) and then, for every entity
// type, tries to read/write Account A's data while authenticated as Account
// B — asserting every attempt is refused. This is a *service-layer* test
// (not HTTP): the test harness runs in demo mode, where the auth plugin
// always resolves the one seeded demo account, so there is no way to select
// between two accounts via headers alone. Calling the service functions
// directly with two distinct real accountIds is what "through the actual
// service layer" means here, and it's the same boundary every route relies on.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentPeriod, iso } from '../lib/dates';
import { prisma } from '../lib/prisma';
import * as categoryService from '../services/category.service';
import * as chatService from '../services/chat.service';
import * as contractorService from '../services/contractor.service';
import * as documentService from '../services/document.service';
import * as insightService from '../services/insight.service';
import * as integrationService from '../services/integration.service';
import * as leaseService from '../services/lease.service';
import * as propertyService from '../services/property.service';
import * as rentService from '../services/rent.service';
import * as reportService from '../services/report.service';
import * as tenantService from '../services/tenant.service';
import * as transactionService from '../services/transaction.service';
import * as unitService from '../services/unit.service';

process.env.STORAGE_DIR = mkdtempSync(path.join(os.tmpdir(), 'hearth-isolation-test-'));

const accountAId = { current: '' };
const accountBId = { current: '' };

// Every id-scoped fixture built under Account A, targeted by cross-tenant
// attempts made "as" Account B below.
const fixture = {
  propertyId: '',
  unitId: '',
  tenantId: '',
  leaseId: '',
  transactionId: '',
  rentPaymentId: '',
  reportId: '',
  insightId: '',
  chatSessionId: '',
  integrationId: '',
  documentId: '',
  contractorId: '',
};

const NOT_FOUND = { code: 'not_found' };

beforeAll(async () => {
  const [a, b] = await Promise.all([
    prisma.account.create({
      data: { name: 'Isolation Test A', email: 'isolation-a@integrationtest.example' },
    }),
    prisma.account.create({
      data: { name: 'Isolation Test B', email: 'isolation-b@integrationtest.example' },
    }),
  ]);
  accountAId.current = a.id;
  accountBId.current = b.id;

  const property = await propertyService.create(accountAId.current, {
    addressLine1: '1 Isolation Way',
    city: 'Springfield',
    state: 'IL',
    zip: '62701',
    units: [{ label: 'Unit A' }],
  });
  fixture.propertyId = property.id;
  const detail = await propertyService.getDetail(accountAId.current, property.id);
  fixture.unitId = detail.units[0]!.id;

  const tenant = await tenantService.create(accountAId.current, { fullName: 'Isolation Tenant' });
  fixture.tenantId = tenant.id;

  // Backdated start: the lease covers the whole current month, so the
  // materialized charge is the full rent (mid-month starts prorate).
  const start = new Date(Date.now() - 1000 * 60 * 60 * 24 * 90);
  const end = new Date(start.getTime() + 1000 * 60 * 60 * 24 * 365);
  const lease = await leaseService.create(accountAId.current, {
    unitId: fixture.unitId,
    tenantIds: [fixture.tenantId],
    rentCents: 100000,
    dueDay: 1,
    startDate: iso(start),
    endDate: iso(end),
  });
  fixture.leaseId = lease.id;

  const txn = await transactionService.create(accountAId.current, {
    date: iso(new Date()),
    amountCents: 5000,
    type: 'expense',
    description: 'Isolation test expense',
  });
  fixture.transactionId = txn.id;

  const period = currentPeriod();
  const rentPayment = await rentService.recordPayment(accountAId.current, {
    leaseId: fixture.leaseId,
    period,
    amountCents: 100000,
    method: 'manual',
  });
  fixture.rentPaymentId = rentPayment.id;

  const report = await reportService.generate(accountAId.current, {
    type: 'net_cashflow',
    taxYear: new Date().getUTCFullYear(),
  });
  fixture.reportId = report.id;

  const insight = await prisma.insight.create({
    data: {
      accountId: accountAId.current,
      scope: 'portfolio',
      type: 'late_rent',
      severity: 'warning',
      title: 'Isolation test insight',
      body: 'Should never be visible to Account B.',
      dedupeKey: `isolation_test:${accountAId.current}`,
      status: 'active',
    },
  });
  fixture.insightId = insight.id;

  const session = await chatService.createSession(accountAId.current, {});
  fixture.chatSessionId = session.id;

  const integration = await integrationService.connectMock(accountAId.current, 'stripe');
  fixture.integrationId = integration.id;

  const contractor = await contractorService.create(accountAId.current, {
    name: 'Isolation Contractor',
    trade: 'Plumbing',
  });
  fixture.contractorId = contractor.id;

  const document = await documentService.create(accountAId.current, {
    entityType: 'property',
    entityId: fixture.propertyId,
    type: 'other',
    name: 'isolation-test.pdf',
    buffer: Buffer.from('%PDF-1.4\nisolation test\n%%EOF', 'utf-8'),
    mimeType: 'application/pdf',
  });
  fixture.documentId = document.id;
});

afterAll(async () => {
  await prisma.account.deleteMany({ where: { email: { endsWith: '@integrationtest.example' } } });
});

describe('cross-tenant isolation: Account B can never read or write Account A data', () => {
  it('Property: getDetail/update/remove/restore/getPnl all refuse cross-account access', async () => {
    await expect(
      propertyService.getDetail(accountBId.current, fixture.propertyId),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      propertyService.update(accountBId.current, fixture.propertyId, { nickname: 'Hijacked' }),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      propertyService.remove(accountBId.current, fixture.propertyId),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      propertyService.restore(accountBId.current, fixture.propertyId),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      propertyService.getPnl(accountBId.current, fixture.propertyId, {
        from: new Date(0),
        to: new Date(),
      }),
    ).rejects.toMatchObject(NOT_FOUND);
  });

  it('Unit: update/remove/restore refuse cross-account access (parent-chain check)', async () => {
    await expect(
      unitService.update(accountBId.current, fixture.unitId, { label: 'Hijacked' }),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(unitService.remove(accountBId.current, fixture.unitId)).rejects.toMatchObject(
      NOT_FOUND,
    );
    await expect(unitService.restore(accountBId.current, fixture.unitId)).rejects.toMatchObject(
      NOT_FOUND,
    );
  });

  it('Tenant: getDetail/update/remove/restore refuse cross-account access', async () => {
    await expect(
      tenantService.getDetail(accountBId.current, fixture.tenantId),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      tenantService.update(accountBId.current, fixture.tenantId, { fullName: 'Hijacked' }),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(tenantService.remove(accountBId.current, fixture.tenantId)).rejects.toMatchObject(
      NOT_FOUND,
    );
    await expect(
      tenantService.restore(accountBId.current, fixture.tenantId),
    ).rejects.toMatchObject(NOT_FOUND);
  });

  it('Lease: getDetail/update/terminate/addTenant/sendForEsign refuse cross-account access', async () => {
    await expect(leaseService.getDetail(accountBId.current, fixture.leaseId)).rejects.toMatchObject(
      NOT_FOUND,
    );
    await expect(
      leaseService.update(accountBId.current, fixture.leaseId, { rentCents: 1 }),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      leaseService.terminate(accountBId.current, fixture.leaseId),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      leaseService.addTenant(accountBId.current, fixture.leaseId, { tenantId: fixture.tenantId }),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      leaseService.sendForEsign(accountBId.current, fixture.leaseId),
    ).rejects.toMatchObject(NOT_FOUND);
  });

  it('Transaction: update/remove/confirm/dismiss refuse cross-account access', async () => {
    await expect(
      transactionService.update(accountBId.current, fixture.transactionId, { description: 'Hijacked' }),
    ).rejects.toMatchObject(NOT_FOUND);
    // Attribution: B can't point its own ledger at A's property or unit.
    await expect(
      transactionService.create(accountBId.current, {
        date: iso(new Date()),
        amountCents: 1000,
        type: 'expense',
        description: 'Cross-account attribution attempt',
        propertyId: fixture.propertyId,
      }),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      transactionService.create(accountBId.current, {
        date: iso(new Date()),
        amountCents: 1000,
        type: 'expense',
        description: 'Cross-account attribution attempt',
        unitId: fixture.unitId,
      }),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      transactionService.confirm(accountBId.current, fixture.transactionId, {}),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      transactionService.dismiss(accountBId.current, fixture.transactionId),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      transactionService.remove(accountBId.current, fixture.transactionId),
    ).rejects.toMatchObject(NOT_FOUND);
  });

  it('RentPayment: createPaymentLink refuses and sendReminders skips cross-account access', async () => {
    await expect(
      rentService.createPaymentLink(accountBId.current, fixture.rentPaymentId),
    ).rejects.toMatchObject(NOT_FOUND);

    // sendReminders degrades gracefully per-id rather than throwing — assert
    // it reports "skipped: not_found" instead of silently emailing Account
    // A's tenant on Account B's behalf.
    const result = await rentService.sendReminders(accountBId.current, {
      rentPaymentIds: [fixture.rentPaymentId],
    });
    expect(result.results).toEqual([
      { rentPaymentId: fixture.rentPaymentId, status: 'skipped', reason: 'not_found' },
    ]);
  });

  it('Report: getById/exportCsv/exportPdf/emailToAccountant refuse cross-account access', async () => {
    await expect(reportService.getById(accountBId.current, fixture.reportId)).rejects.toMatchObject(
      NOT_FOUND,
    );
    await expect(
      reportService.exportCsv(accountBId.current, fixture.reportId),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      reportService.exportPdf(accountBId.current, fixture.reportId),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      reportService.emailToAccountant(accountBId.current, fixture.reportId, 'attacker@example.com'),
    ).rejects.toMatchObject(NOT_FOUND);
  });

  it('Insight: dismiss refuses cross-account access', async () => {
    await expect(
      insightService.dismiss(accountBId.current, fixture.insightId),
    ).rejects.toMatchObject(NOT_FOUND);
  });

  it('ChatSession: getMessages refuses cross-account access', async () => {
    await expect(
      chatService.getMessages(accountBId.current, fixture.chatSessionId),
    ).rejects.toMatchObject(NOT_FOUND);
  });

  it('Integration: disconnect refuses cross-account access', async () => {
    await expect(
      integrationService.disconnect(accountBId.current, fixture.integrationId),
    ).rejects.toMatchObject(NOT_FOUND);
  });

  it('Contractor: detail/update/remove/restore refuse cross-account access', async () => {
    await expect(
      contractorService.detail(accountBId.current, fixture.contractorId),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      contractorService.update(accountBId.current, fixture.contractorId, { name: 'Hijacked' }),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      contractorService.remove(accountBId.current, fixture.contractorId),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      contractorService.restore(accountBId.current, fixture.contractorId),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      contractorService.logJob(accountBId.current, fixture.contractorId, {
        date: iso(new Date()),
        description: 'Hijacked job',
        amountCents: 10000,
      }),
    ).rejects.toMatchObject(NOT_FOUND);
  });

  it('Document: getForDownload/update/remove refuse cross-account access', async () => {
    await expect(
      documentService.getForDownload(accountBId.current, fixture.documentId),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      documentService.update(accountBId.current, fixture.documentId, { name: 'hijacked.pdf' }),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      documentService.remove(accountBId.current, fixture.documentId),
    ).rejects.toMatchObject(NOT_FOUND);
  });

  it("list-style reads never mix in the other account's rows", async () => {
    // Account B's own lists must be empty/unaffected by Account A's fixtures
    // — a coarser regression check on top of the id-scoped checks above.
    expect(await propertyService.list(accountBId.current)).toEqual([]);
    expect(await tenantService.list(accountBId.current)).toEqual([]);
    expect((await leaseService.list(accountBId.current)).map((l) => l.id)).not.toContain(
      fixture.leaseId,
    );
    expect(
      (await transactionService.list(accountBId.current, {})).items.map((t) => t.id),
    ).not.toContain(fixture.transactionId);
    expect(await insightService.listActive(accountBId.current)).toEqual([]);
    expect(await contractorService.list(accountBId.current)).toEqual([]);
    expect((await chatService.listSessions(accountBId.current)).map((s) => s.id)).not.toContain(
      fixture.chatSessionId,
    );
    expect(
      (await documentService.list(accountBId.current, {})).documents.map((d) => d.id),
    ).not.toContain(fixture.documentId);
    // Categories are the one intentional exception: system categories
    // (accountId: null) are shared/visible to every account by design.
    const categoriesB = await categoryService.list(accountBId.current);
    expect(categoriesB.every((c) => c.isSystem)).toBe(true);
  });

  it('fixtures under Account A are still fully intact and readable by Account A itself', async () => {
    // Guards against a broken test accidentally proving isolation by having
    // silently failed to create the fixtures in the first place.
    await expect(propertyService.getDetail(accountAId.current, fixture.propertyId)).resolves.toBeTruthy();
    await expect(tenantService.getDetail(accountAId.current, fixture.tenantId)).resolves.toBeTruthy();
    await expect(leaseService.getDetail(accountAId.current, fixture.leaseId)).resolves.toBeTruthy();
    await expect(reportService.getById(accountAId.current, fixture.reportId)).resolves.toBeTruthy();
    await expect(
      documentService.getForDownload(accountAId.current, fixture.documentId),
    ).resolves.toBeTruthy();
  });
});
