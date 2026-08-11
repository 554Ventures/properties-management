// Mortgages + property valuations (PLAN-REAL-EQUITY §2/§4 Phase 1): service
// derivation (currentBalanceCents via lib/mortgage-balance.ts, valuation
// latest-as-of), route CRUD with the shared schemas, archive/restore,
// cross-account 404, and the 'properties' permission gate on both write
// surfaces. A throwaway property under the seeded demo account carries the
// round-trip fixtures; a fully separate account backs the cross-account and
// permission tests. Everything created here is cleaned up in afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { MortgageSchema, PropertyValuationSchema } from '@hearth/shared';
import { buildApp } from '../app';
import { iso } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import { resetAuthServiceCache } from '../services/auth.service';
import * as mortgageService from '../services/mortgage.service';
import * as propertyService from '../services/property.service';
import * as valuationService from '../services/valuation.service';

const API = '/api/v1';

let app: FastifyInstance;
let accountId: string;
let propertyId: string;

const createdPropertyIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  accountId = await getDemoAccountId();
  const property = await prisma.property.create({
    data: { accountId, addressLine1: '1 Equity Ln', city: 'Springfield', state: 'CA', zip: '90000' },
  });
  propertyId = property.id;
  createdPropertyIds.push(propertyId);
});

afterAll(async () => {
  // Cascades mortgages/valuations; audit rows are cleaned separately since
  // they don't cascade off the property.
  await prisma.auditLog.deleteMany({
    where: { accountId, entityType: { in: ['mortgage', 'valuation'] } },
  });
  await prisma.property.deleteMany({ where: { id: { in: createdPropertyIds } } });
  await app.close();
});

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `${API}${url}`, payload: payload as never });
}

describe('mortgages — create+read round-trip, checkpoint audit, archive/restore', () => {
  it('POST /properties/:id/mortgages returns a Mortgage with currentBalanceCents === balanceCents (no principal rows yet)', async () => {
    const res = await inject('POST', `/properties/${propertyId}/mortgages`, {
      lender: 'First Federal',
      balanceCents: 25_000_000,
      balanceAsOfDate: iso(new Date('2024-01-01')),
      originalPrincipalCents: 30_000_000,
      interestRateMilliPct: 6375,
    });
    expect(res.statusCode).toBe(201);
    const mortgage = MortgageSchema.parse(res.json());
    expect(mortgage.propertyId).toBe(propertyId);
    expect(mortgage.balanceCents).toBe(25_000_000);
    expect(mortgage.currentBalanceCents).toBe(25_000_000);
    expect(mortgage.archivedAt).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'mortgage.created', entityType: 'mortgage', entityId: mortgage.id },
    });
    expect(audit?.actor).toBe('user');
  });

  it('a plain field edit audits mortgage.updated; supplying balanceCents+balanceAsOfDate together audits mortgage.checkpointed', async () => {
    const created = MortgageSchema.parse(
      (
        await inject('POST', `/properties/${propertyId}/mortgages`, {
          lender: 'Checkpoint Bank',
          balanceCents: 10_000_000,
          balanceAsOfDate: iso(new Date('2024-01-01')),
        })
      ).json(),
    );

    const plainEdit = await inject('PATCH', `/mortgages/${created.id}`, { notes: 'Escrow includes flood' });
    expect(plainEdit.statusCode).toBe(200);
    expect(
      (
        await prisma.auditLog.findFirst({
          where: { accountId, action: 'mortgage.updated', entityType: 'mortgage', entityId: created.id },
        })
      )?.actor,
    ).toBe('user');

    const recheckpoint = await inject('PATCH', `/mortgages/${created.id}`, {
      balanceCents: 9_800_000,
      balanceAsOfDate: iso(new Date('2024-06-01')),
    });
    expect(recheckpoint.statusCode).toBe(200);
    const reCheckpointed = MortgageSchema.parse(recheckpoint.json());
    expect(reCheckpointed.balanceCents).toBe(9_800_000);
    expect(reCheckpointed.currentBalanceCents).toBe(9_800_000);
    expect(
      (
        await prisma.auditLog.findFirst({
          where: { accountId, action: 'mortgage.checkpointed', entityType: 'mortgage', entityId: created.id },
        })
      )?.actor,
    ).toBe('user');
  });

  it('PATCH rejects balanceCents without balanceAsOfDate (400 validation_error)', async () => {
    const created = MortgageSchema.parse(
      (
        await inject('POST', `/properties/${propertyId}/mortgages`, {
          lender: 'Partial Patch Bank',
          balanceCents: 5_000_000,
          balanceAsOfDate: iso(new Date('2024-01-01')),
        })
      ).json(),
    );

    const res = await inject('PATCH', `/mortgages/${created.id}`, { balanceCents: 4_900_000 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('archive drops it from listForProperty; restore brings it back', async () => {
    const created = MortgageSchema.parse(
      (
        await inject('POST', `/properties/${propertyId}/mortgages`, {
          lender: 'Archive Test Bank',
          balanceCents: 1_000_000,
          balanceAsOfDate: iso(new Date('2024-01-01')),
        })
      ).json(),
    );
    expect((await mortgageService.listForProperty(accountId, propertyId)).some((m) => m.id === created.id)).toBe(
      true,
    );

    const archiveRes = await inject('DELETE', `/mortgages/${created.id}`);
    expect(archiveRes.statusCode).toBe(204);
    expect((await mortgageService.listForProperty(accountId, propertyId)).some((m) => m.id === created.id)).toBe(
      false,
    );
    expect(
      (
        await prisma.auditLog.findFirst({
          where: { accountId, action: 'mortgage.archived', entityType: 'mortgage', entityId: created.id },
        })
      )?.actor,
    ).toBe('user');

    const restoreRes = await inject('POST', `/mortgages/${created.id}/restore`);
    expect(restoreRes.statusCode).toBe(200);
    expect(MortgageSchema.parse(restoreRes.json()).archivedAt).toBeNull();
    expect((await mortgageService.listForProperty(accountId, propertyId)).some((m) => m.id === created.id)).toBe(
      true,
    );
    expect(
      (
        await prisma.auditLog.findFirst({
          where: { accountId, action: 'mortgage.restored', entityType: 'mortgage', entityId: created.id },
        })
      )?.actor,
    ).toBe('user');
  });

  it('an archived mortgage stays visible on the property hub but is not owed', async () => {
    // The hub needs it listed to offer "restore" (units[] carries archived
    // units for the same reason); equity must never count it as debt.
    // Needs an acquisition cost: with no cost and no valuation there is no
    // asset figure, so `equity` is deliberately null and there is nothing to
    // assert a liability against.
    const owned = await prisma.property.create({
      data: {
        accountId,
        addressLine1: '2 Archive Ave',
        city: 'Springfield',
        state: 'CA',
        zip: '90000',
        acquisitionCostCents: 20_000_000,
      },
    });
    createdPropertyIds.push(owned.id);
    const created = MortgageSchema.parse(
      (
        await inject('POST', `/properties/${owned.id}/mortgages`, {
          lender: 'Paid Off Savings & Loan',
          balanceCents: 4_500_000,
          balanceAsOfDate: iso(new Date('2024-06-01')),
        })
      ).json(),
    );
    const before = await propertyService.getDetail(accountId, owned.id);
    expect(before.equity?.liabilityCents).toBe(4_500_000);
    const owedBefore = before.equity?.liabilityCents ?? 0;

    expect((await inject('DELETE', `/mortgages/${created.id}`)).statusCode).toBe(204);

    const after = await propertyService.getDetail(accountId, owned.id);
    const archived = after.mortgages.find((m) => m.id === created.id);
    expect(archived?.archivedAt).not.toBeNull();
    expect(after.equity?.liabilityCents).toBe(owedBefore - 4_500_000);
  });

  it('the balanceCents/balanceAsOfDate pairing rule holds in the service, not just the route schema', async () => {
    // Chat/MCP tools compose their own input shapes off the unrefined
    // UpdateMortgageFieldsSchema, so the route's refine can't be the only guard:
    // a balance stored without its as-of date corrupts every later derivation.
    const created = MortgageSchema.parse(
      (
        await inject('POST', `/properties/${propertyId}/mortgages`, {
          lender: 'Pairing Rule Bank',
          balanceCents: 2_000_000,
          balanceAsOfDate: iso(new Date('2024-01-01')),
        })
      ).json(),
    );
    await expect(
      mortgageService.update(accountId, created.id, { balanceCents: 1_900_000 }),
    ).rejects.toThrow(/together/i);
    await expect(
      mortgageService.update(accountId, created.id, { balanceAsOfDate: iso(new Date('2025-01-01')) }),
    ).rejects.toThrow(/together/i);
    // Unchanged on disk.
    expect((await prisma.mortgage.findUniqueOrThrow({ where: { id: created.id } })).balanceCents).toBe(
      2_000_000,
    );
  });
});

describe('valuations — history, latest-as-of derivation, hard delete', () => {
  it('POST /properties/:id/valuations round-trips through the shared schema and lists newest-first', async () => {
    const older = PropertyValuationSchema.parse(
      (
        await inject('POST', `/properties/${propertyId}/valuations`, {
          valueCents: 40_000_000,
          asOfDate: iso(new Date('2023-01-01')),
          source: 'owner_estimate',
        })
      ).json(),
    );
    const newer = PropertyValuationSchema.parse(
      (
        await inject('POST', `/properties/${propertyId}/valuations`, {
          valueCents: 45_000_000,
          asOfDate: iso(new Date('2024-01-01')),
          source: 'appraisal',
        })
      ).json(),
    );

    const listRes = await inject('GET', `/properties/${propertyId}/valuations`);
    expect(listRes.statusCode).toBe(200);
    const rows = listRes.json().map((r: unknown) => PropertyValuationSchema.parse(r));
    const ids = rows.map((r: { id: string }) => r.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id)); // asOfDate desc
  });

  it('latestForProperty picks the highest asOfDate <= asOf, and null when every row is in the future', async () => {
    const property = await prisma.property.create({
      data: { accountId, addressLine1: '2 Latest Ave', city: 'Springfield', state: 'CA', zip: '90000' },
    });
    createdPropertyIds.push(property.id);

    const a = await valuationService.create(accountId, property.id, {
      valueCents: 30_000_000,
      asOfDate: iso(new Date('2024-01-01')),
      source: 'owner_estimate',
    });
    await valuationService.create(accountId, property.id, {
      valueCents: 32_000_000,
      asOfDate: iso(new Date('2025-01-01')),
      source: 'owner_estimate',
    });

    const between = await valuationService.latestForProperty(accountId, property.id, new Date('2024-06-01'));
    expect(between?.id).toBe(a.id);

    const beforeEither = await valuationService.latestForProperty(accountId, property.id, new Date('2023-01-01'));
    expect(beforeEither).toBeNull();
  });

  it('two valuations sharing an asOfDate resolve to the same row for one property and for the whole account', async () => {
    // Re-recording a value for the same date is how a typo gets corrected. With
    // no tiebreaker the single-property query (property hub) and the
    // whole-account query (balance sheet) can pick different rows, and the hub
    // and a filed balance sheet then disagree about the same property.
    const owned = await prisma.property.create({
      data: { accountId, addressLine1: '3 Tie Break Ct', city: 'Springfield', state: 'CA', zip: '90000' },
    });
    createdPropertyIds.push(owned.id);
    const sameDay = iso(new Date('2026-05-01'));
    for (const valueCents of [26_800_000, 28_600_000]) {
      await inject('POST', `/properties/${owned.id}/valuations`, {
        valueCents,
        asOfDate: sameDay,
        source: 'owner_estimate',
      });
    }
    const asOf = new Date('2026-08-01');
    const single = await valuationService.latestForProperty(accountId, owned.id, asOf);
    const byProperty = await valuationService.latestByProperty(accountId, asOf);
    expect(single?.valueCents).toBe(28_600_000); // newest correction wins
    expect(byProperty.get(owned.id)?.valueCents).toBe(single?.valueCents);
  });

  it('DELETE hard-deletes the row and audits valuation.deleted', async () => {
    const created = PropertyValuationSchema.parse(
      (
        await inject('POST', `/properties/${propertyId}/valuations`, {
          valueCents: 20_000_000,
          asOfDate: iso(new Date('2022-01-01')),
          source: 'tax_assessment',
        })
      ).json(),
    );

    const res = await inject('DELETE', `/valuations/${created.id}`);
    expect(res.statusCode).toBe(204);
    expect(await prisma.propertyValuation.findUnique({ where: { id: created.id } })).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { accountId, action: 'valuation.deleted', entityType: 'valuation', entityId: created.id },
    });
    expect(audit?.actor).toBe('user');
  });
});

describe('cross-account isolation — a foreign id 404s, never leaks', () => {
  let otherAccountId: string;
  let otherPropertyId: string;

  beforeAll(async () => {
    const otherAccount = await prisma.account.create({
      data: { name: 'Other Equity Co', email: 'other-equity@mortgagetest.example' },
    });
    otherAccountId = otherAccount.id;
    const otherProperty = await prisma.property.create({
      data: { accountId: otherAccountId, addressLine1: '9 Elsewhere St', city: 'X', state: 'CA', zip: '00000' },
    });
    otherPropertyId = otherProperty.id;
  });

  afterAll(async () => {
    await prisma.account.delete({ where: { id: otherAccountId } });
  });

  it('a mortgage owned by another account 404s on PATCH/DELETE from this account', async () => {
    const foreign = await mortgageService.create(otherAccountId, otherPropertyId, {
      lender: 'Foreign Bank',
      balanceCents: 1_000_000,
      balanceAsOfDate: iso(new Date('2024-01-01')),
    });

    const patchRes = await inject('PATCH', `/mortgages/${foreign.id}`, { notes: 'nope' });
    expect(patchRes.statusCode).toBe(404);
    expect(patchRes.json().error.code).toBe('not_found');

    const deleteRes = await inject('DELETE', `/mortgages/${foreign.id}`);
    expect(deleteRes.statusCode).toBe(404);
    expect(deleteRes.json().error.code).toBe('not_found');
  });

  it('a valuation owned by another account 404s on DELETE from this account', async () => {
    const foreign = await valuationService.create(otherAccountId, otherPropertyId, {
      valueCents: 1_000_000,
      asOfDate: iso(new Date('2024-01-01')),
      source: 'other',
    });

    const res = await inject('DELETE', `/valuations/${foreign.id}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});

describe("write routes are gated on the 'properties' member permission", () => {
  const TEST_SECRET = 'test-jwt-secret-with-at-least-32-characters!';
  let authzApp: FastifyInstance;
  let authzAccountId: string;
  let authzPropertyId: string;

  beforeAll(async () => {
    process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
    resetAuthServiceCache();
    authzApp = await buildApp();

    const account = await prisma.account.create({
      data: { name: 'Equity Authz Co', email: 'equity-authz@mortgagetest.example' },
    });
    authzAccountId = account.id;
    const property = await prisma.property.create({
      data: { accountId: authzAccountId, addressLine1: '3 Authz Blvd', city: 'X', state: 'CA', zip: '00000' },
    });
    authzPropertyId = property.id;
    await prisma.user.create({
      data: {
        accountId: authzAccountId,
        supabaseUserId: 'equity-authz-member',
        email: 'equity-authz-member@example.com',
        role: 'member',
        permissionsJson: JSON.stringify(['ai']), // deliberately missing 'properties'
      },
    });
  });

  afterAll(async () => {
    await prisma.account.delete({ where: { id: authzAccountId } });
    delete process.env.SUPABASE_JWT_SECRET;
    resetAuthServiceCache();
    await authzApp.close();
  });

  async function memberToken(): Promise<string> {
    return new SignJWT({ email: 'equity-authz-member@example.com', aud: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('equity-authz-member')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(TEST_SECRET));
  }

  it("403s a member without 'properties' on POST /properties/:id/mortgages", async () => {
    const token = await memberToken();
    const res = await authzApp.inject({
      method: 'POST',
      url: `${API}/properties/${authzPropertyId}/mortgages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { lender: 'Denied Bank', balanceCents: 1_000_000, balanceAsOfDate: iso(new Date('2024-01-01')) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });

  it("403s a member without 'properties' on every other mortgage/valuation write, not just the creates", async () => {
    // A guard missing from PATCH/DELETE/restore is exactly as bad as one missing
    // from POST, and each is a separate registration.
    const token = await memberToken();
    const headers = { authorization: `Bearer ${token}` };
    const mortgage = await prisma.mortgage.create({
      data: {
        accountId: authzAccountId,
        propertyId: authzPropertyId,
        lender: 'Guarded Bank',
        balanceCents: 1_000_000,
        balanceAsOfDate: new Date('2024-01-01'),
      },
    });
    const valuation = await prisma.propertyValuation.create({
      data: {
        accountId: authzAccountId,
        propertyId: authzPropertyId,
        valueCents: 5_000_000,
        asOfDate: new Date('2024-01-01'),
        source: 'owner_estimate',
      },
    });

    for (const [method, url, payload] of [
      ['PATCH', `${API}/mortgages/${mortgage.id}`, { lender: 'Renamed' }],
      ['DELETE', `${API}/mortgages/${mortgage.id}`, undefined],
      ['POST', `${API}/mortgages/${mortgage.id}/restore`, undefined],
      ['DELETE', `${API}/valuations/${valuation.id}`, undefined],
    ] as const) {
      const res = await authzApp.inject({ method, url, headers, payload: payload as never });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.code).toBe('forbidden');
    }
    // Nothing moved.
    expect((await prisma.mortgage.findUniqueOrThrow({ where: { id: mortgage.id } })).lender).toBe(
      'Guarded Bank',
    );
    expect(await prisma.propertyValuation.findUnique({ where: { id: valuation.id } })).not.toBeNull();
  });

  it("403s a member without 'properties' on POST /properties/:id/valuations", async () => {
    const token = await memberToken();
    const res = await authzApp.inject({
      method: 'POST',
      url: `${API}/properties/${authzPropertyId}/valuations`,
      headers: { authorization: `Bearer ${token}` },
      payload: { valueCents: 1_000_000, asOfDate: iso(new Date('2024-01-01')), source: 'owner_estimate' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });
});
