// WS7 — late fees v1. Policy is configured (Account default + optional Lease
// override); applying a fee is always an explicit human action (tracker button
// or the user-invoked apply_late_fee chat/MCP tool), never auto-applied. One
// concept everywhere: totalDue = amountCents + lateFeeCents. Own throwaway
// account + fixtures, cleaned up in afterAll — never touches the seeded demo
// account (later files pin its exact numbers, fee-free).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../app';
import { addDays, currentPeriodInTz, iso, startOfDayInTz } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { createMcpServer } from '../mcp/index';
import { resetAuthServiceCache } from '../services/auth.service';
import { deniedWriteTools, findServiceTool, WRITE_TOOL_PERMISSIONS } from '../ai/tools';
import * as leaseService from '../services/lease.service';
import * as rentService from '../services/rent.service';
import * as tenantService from '../services/tenant.service';

const EMAIL = (s: string) => `late-fee-${s}@latefeetest.example`;
const TZ = 'America/New_York';
const ACCOUNT_DEFAULT_FEE = 5000;

let accountId: string;
let propertyId: string;
let unitCounter = 0;
const now = new Date();
const period = currentPeriodInTz(TZ);

/** Fresh unit + tenant + active lease + a pre-materialized charge with an
 *  explicit dueDate so lateness is deterministic (grace is 0). daysLate < 0
 *  makes the charge future-dated (derives 'due', i.e. not late). */
async function makeCharge(opts?: {
  leaseLateFeeCents?: number | null;
  daysLate?: number;
  rentCents?: number;
}): Promise<{ leaseId: string; rentPaymentId: string; rentCents: number }> {
  const rentCents = opts?.rentCents ?? 100000;
  const daysLate = opts?.daysLate ?? 10;
  const unit = await prisma.unit.create({
    data: { propertyId, label: `LF${++unitCounter}` },
  });
  const tenant = await tenantService.create(accountId, { fullName: `LF Tenant ${unitCounter}` });
  const lease = await leaseService.create(accountId, {
    unitId: unit.id,
    tenantIds: [tenant.id],
    rentCents,
    dueDay: 1,
    ...(opts && 'leaseLateFeeCents' in opts ? { lateFeeCents: opts.leaseLateFeeCents } : {}),
    startDate: iso(addDays(now, -400)),
    endDate: iso(addDays(now, 400)),
  });
  const charge = await prisma.rentPayment.create({
    data: {
      leaseId: lease.id,
      period,
      dueDate: addDays(startOfDayInTz(now, TZ), -daysLate),
      amountCents: rentCents,
      status: 'due',
    },
  });
  return { leaseId: lease.id, rentPaymentId: charge.id, rentCents };
}

beforeAll(async () => {
  const account = await prisma.account.create({
    data: {
      name: 'Late Fee Co',
      email: EMAIL('main'),
      timezone: TZ,
      graceDays: 0,
      defaultLateFeeCents: ACCOUNT_DEFAULT_FEE,
    },
  });
  accountId = account.id;
  const property = await prisma.property.create({
    data: { accountId, addressLine1: '1 Late Fee Way', city: 'X', state: 'CA', zip: '00000' },
  });
  propertyId = property.id;
});

afterAll(async () => {
  await prisma.account.deleteMany({ where: { email: { endsWith: '@latefeetest.example' } } });
});

describe('applyLateFee guards', () => {
  it('rejects a charge that is not past its grace period (400)', async () => {
    const { rentPaymentId } = await makeCharge({ daysLate: -5 }); // due in the future
    await expect(rentService.applyLateFee(accountId, rentPaymentId, {})).rejects.toThrow(
      /past its grace period/,
    );
    expect(
      (await prisma.rentPayment.findUniqueOrThrow({ where: { id: rentPaymentId } })).lateFeeCents,
    ).toBe(0);
  });

  it('rejects a second fee on the same charge (400, one fee per charge in v1)', async () => {
    const { rentPaymentId } = await makeCharge();
    await rentService.applyLateFee(accountId, rentPaymentId, {});
    await expect(rentService.applyLateFee(accountId, rentPaymentId, {})).rejects.toThrow(
      /already been applied/,
    );
  });

  it('rejects when no policy is configured (lease 0 disables the account default)', async () => {
    // Account default is 5000, but this lease explicitly opts out with 0.
    const { rentPaymentId } = await makeCharge({ leaseLateFeeCents: 0 });
    await expect(rentService.applyLateFee(accountId, rentPaymentId, {})).rejects.toThrow(
      /no late-fee policy/,
    );
  });
});

describe('effective-policy resolution', () => {
  it('uses the account default when the lease has no override', async () => {
    const { rentPaymentId } = await makeCharge({ leaseLateFeeCents: null });
    const updated = await rentService.applyLateFee(accountId, rentPaymentId, {});
    expect(updated.lateFeeCents).toBe(ACCOUNT_DEFAULT_FEE);
  });

  it('lets a lease override beat the account default', async () => {
    const { rentPaymentId } = await makeCharge({ leaseLateFeeCents: 3000 });
    const updated = await rentService.applyLateFee(accountId, rentPaymentId, {});
    expect(updated.lateFeeCents).toBe(3000);
  });

  it('lets an explicit feeCents override the policy entirely', async () => {
    const { rentPaymentId } = await makeCharge({ leaseLateFeeCents: 3000 });
    const updated = await rentService.applyLateFee(accountId, rentPaymentId, { feeCents: 1234 });
    expect(updated.lateFeeCents).toBe(1234);
  });
});

describe('outstanding / collected math with a fee', () => {
  it('grows outstanding by the fee, leaves collected unchanged, exposes lateFeeCents', async () => {
    const { rentPaymentId } = await makeCharge({ rentCents: 100000 });
    const before = await rentService.getMonthStatus(accountId, period);
    const beforeRow = before.rows.find((r) => r.rentPaymentId === rentPaymentId)!;
    expect(beforeRow.lateFeeCents).toBe(0);

    await rentService.applyLateFee(accountId, rentPaymentId, { feeCents: ACCOUNT_DEFAULT_FEE });

    const after = await rentService.getMonthStatus(accountId, period);
    const afterRow = after.rows.find((r) => r.rentPaymentId === rentPaymentId)!;
    expect(afterRow.lateFeeCents).toBe(ACCOUNT_DEFAULT_FEE);
    expect(after.outstandingCents - before.outstandingCents).toBe(ACCOUNT_DEFAULT_FEE);
    expect(after.collectedCents).toBe(before.collectedCents);
  });
});

describe('partial → fee → completing deposit', () => {
  it('flips to paid only once paidCents reaches totalDue (base + fee)', async () => {
    const { leaseId, rentPaymentId, rentCents } = await makeCharge({ rentCents: 100000 });
    // Partial base payment first; the charge is late so it derives 'partial'.
    await rentService.recordPayment(accountId, {
      leaseId,
      period,
      amountCents: 40000,
      method: 'manual',
    });
    // A partial past grace is fee-eligible.
    await rentService.applyLateFee(accountId, rentPaymentId, { feeCents: ACCOUNT_DEFAULT_FEE });
    const midTracker = await rentService.getMonthStatus(accountId, period);
    expect(midTracker.rows.find((r) => r.rentPaymentId === rentPaymentId)!.status).toBe('partial');

    // Completing the total (60000 base remainder + 5000 fee) flips it to paid.
    const completed = await rentService.recordPayment(accountId, {
      leaseId,
      period,
      amountCents: rentCents - 40000 + ACCOUNT_DEFAULT_FEE,
      method: 'manual',
    });
    expect(completed.status).toBe('paid');
    expect(completed.paidCents).toBe(rentCents + ACCOUNT_DEFAULT_FEE);
  });
});

describe('waiveLateFee', () => {
  it('resets an applied fee to 0 (happy path)', async () => {
    const { rentPaymentId } = await makeCharge();
    await rentService.applyLateFee(accountId, rentPaymentId, { feeCents: ACCOUNT_DEFAULT_FEE });
    const waived = await rentService.waiveLateFee(accountId, rentPaymentId);
    expect(waived.lateFeeCents).toBe(0);
  });

  it('rejects a waive on a charge with no fee (400)', async () => {
    const { rentPaymentId } = await makeCharge();
    await expect(rentService.waiveLateFee(accountId, rentPaymentId)).rejects.toThrow(
      /no late fee to waive/,
    );
  });

  it('blocks a waive once the total (base + fee) is fully collected', async () => {
    const { leaseId, rentPaymentId, rentCents } = await makeCharge({ rentCents: 100000 });
    await rentService.applyLateFee(accountId, rentPaymentId, { feeCents: ACCOUNT_DEFAULT_FEE });
    await rentService.recordPayment(accountId, {
      leaseId,
      period,
      amountCents: rentCents + ACCOUNT_DEFAULT_FEE, // pays base + fee in full
      method: 'manual',
    });
    await expect(rentService.waiveLateFee(accountId, rentPaymentId)).rejects.toThrow(
      /already been collected/,
    );
  });

  it('blocks a waive once ANY fee money is collected (partial fee payment)', async () => {
    // Base 100000 + fee 5000 = totalDue 105000. Paying 102000 puts paidCents
    // strictly between base and totalDue; waiving then would strand a 2000
    // overpayment (paidCents > new totalDue) that the tracker's min/max
    // clamping silently hides.
    const { leaseId, rentPaymentId, rentCents } = await makeCharge({ rentCents: 100000 });
    await rentService.applyLateFee(accountId, rentPaymentId, { feeCents: ACCOUNT_DEFAULT_FEE });
    await rentService.recordPayment(accountId, {
      leaseId,
      period,
      amountCents: rentCents + 2000,
      method: 'manual',
    });
    await expect(rentService.waiveLateFee(accountId, rentPaymentId)).rejects.toThrow(
      /already been collected/,
    );

    // Paying exactly the base leaves the fee untouched — waive stays allowed.
    const exact = await makeCharge({ rentCents: 100000 });
    await rentService.applyLateFee(accountId, exact.rentPaymentId, {
      feeCents: ACCOUNT_DEFAULT_FEE,
    });
    await rentService.recordPayment(accountId, {
      leaseId: exact.leaseId,
      period,
      amountCents: exact.rentCents,
      method: 'manual',
    });
    const waived = await rentService.waiveLateFee(accountId, exact.rentPaymentId);
    expect(waived.lateFeeCents).toBe(0);
    expect(waived.paidCents).toBe(exact.rentCents); // fully paid at the new totalDue, no overpayment
  });
});

describe('cash-basis deposit categorization', () => {
  it('categorizes a fee-only deposit as Late Fees and the base/blended as Rent', async () => {
    const rentCat = await prisma.category.findFirstOrThrow({
      where: { name: 'Rent', type: 'income', isSystem: true },
    });
    const lateFeeCat = await prisma.category.findFirstOrThrow({
      where: { name: 'Late Fees', type: 'income', isSystem: true },
    });

    // Fee applied while late, then base paid, then the fee paid on its own.
    const feeOnly = await makeCharge({ rentCents: 100000 });
    await rentService.applyLateFee(accountId, feeOnly.rentPaymentId, { feeCents: ACCOUNT_DEFAULT_FEE });
    await rentService.recordPayment(accountId, {
      leaseId: feeOnly.leaseId,
      period,
      amountCents: 100000, // base
      method: 'manual',
    });
    await rentService.recordPayment(accountId, {
      leaseId: feeOnly.leaseId,
      period,
      amountCents: ACCOUNT_DEFAULT_FEE, // fee only (base already covered)
      method: 'manual',
    });
    const feeDeposits = await prisma.rentPaymentDeposit.findMany({
      where: { rentPaymentId: feeOnly.rentPaymentId },
      include: { transaction: true },
    });
    expect(feeDeposits.find((d) => d.amountCents === 100000)!.transaction.categoryId).toBe(rentCat.id);
    expect(feeDeposits.find((d) => d.amountCents === ACCOUNT_DEFAULT_FEE)!.transaction.categoryId).toBe(
      lateFeeCat.id,
    );

    // A single blended payment covering base + fee together stays Rent.
    const blended = await makeCharge({ rentCents: 100000 });
    await rentService.applyLateFee(accountId, blended.rentPaymentId, { feeCents: ACCOUNT_DEFAULT_FEE });
    await rentService.recordPayment(accountId, {
      leaseId: blended.leaseId,
      period,
      amountCents: 100000 + ACCOUNT_DEFAULT_FEE,
      method: 'manual',
    });
    const blendedDeposit = await prisma.rentPaymentDeposit.findFirstOrThrow({
      where: { rentPaymentId: blended.rentPaymentId },
      include: { transaction: true },
    });
    expect(blendedDeposit.transaction.categoryId).toBe(rentCat.id);
  });
});

describe('unlink recompute with a fee present', () => {
  it('reopens the charge below totalDue and keeps the fee intact', async () => {
    const { leaseId, rentPaymentId, rentCents } = await makeCharge({ rentCents: 100000 });
    await rentService.applyLateFee(accountId, rentPaymentId, { feeCents: ACCOUNT_DEFAULT_FEE });
    // Two deposits: base then fee — fully covers totalDue → paid.
    await rentService.recordPayment(accountId, { leaseId, period, amountCents: 100000, method: 'manual' });
    await rentService.recordPayment(accountId, {
      leaseId,
      period,
      amountCents: ACCOUNT_DEFAULT_FEE,
      method: 'manual',
    });
    const paid = await prisma.rentPayment.findUniqueOrThrow({ where: { id: rentPaymentId } });
    expect(paid.status).toBe('paid');

    const feeDeposit = await prisma.rentPaymentDeposit.findFirstOrThrow({
      where: { rentPaymentId, amountCents: ACCOUNT_DEFAULT_FEE },
    });
    const reopened = await rentService.unlinkDeposit(accountId, rentPaymentId, feeDeposit.id);
    expect(reopened.status).toBe('due'); // no longer covers totalDue
    expect(reopened.paidCents).toBe(rentCents);
    expect(reopened.lateFeeCents).toBe(ACCOUNT_DEFAULT_FEE); // fee untouched by the unlink
  });
});

describe('rent-match suppression after a fee', () => {
  it('drops the exact-base chip but still matches the exact remaining (incl. fee)', async () => {
    const { rentPaymentId, rentCents } = await makeCharge({ rentCents: 100000 });
    await rentService.applyLateFee(accountId, rentPaymentId, { feeCents: ACCOUNT_DEFAULT_FEE });
    const candidates = await rentService.findRentMatchCandidates(accountId, {
      from: addDays(now, -30),
      to: addDays(now, 5),
    });
    const mine = candidates.find((c) => c.rentPaymentId === rentPaymentId)!;
    expect(mine.lateFeeCents).toBe(ACCOUNT_DEFAULT_FEE);

    // Exact base rent no longer clears the high-confidence exact-match chip.
    expect(rentService.pickRentMatch({ amountCents: rentCents, date: now }, [mine])).toBeNull();
    // The exact total-due (rent + fee) does match.
    expect(
      rentService.pickRentMatch({ amountCents: rentCents + ACCOUNT_DEFAULT_FEE, date: now }, [mine])
        ?.rentPaymentId,
    ).toBe(rentPaymentId);
  });
});

describe('audit trail', () => {
  it('writes late_fee_applied and late_fee_waived rows attributed to the actor', async () => {
    const { rentPaymentId } = await makeCharge();
    await rentService.applyLateFee(accountId, rentPaymentId, { feeCents: ACCOUNT_DEFAULT_FEE }, 'user');
    const applied = await prisma.auditLog.findFirstOrThrow({
      where: { accountId, action: 'rent_payment.late_fee_applied', entityId: rentPaymentId },
    });
    expect(applied.actor).toBe('user');
    expect(JSON.parse(applied.detailJson!)).toMatchObject({ feeCents: ACCOUNT_DEFAULT_FEE, period });

    await rentService.waiveLateFee(accountId, rentPaymentId, 'user');
    const waived = await prisma.auditLog.findFirstOrThrow({
      where: { accountId, action: 'rent_payment.late_fee_waived', entityId: rentPaymentId },
    });
    expect(waived.actor).toBe('user');
    expect(JSON.parse(waived.detailJson!)).toMatchObject({ feeCents: ACCOUNT_DEFAULT_FEE });
  });
});

describe('AI surface — apply_late_fee tool', () => {
  it('is a rent-gated write tool with no waive counterpart', () => {
    const tool = findServiceTool('apply_late_fee');
    expect(tool?.write).toBe(true);
    expect(WRITE_TOOL_PERMISSIONS.apply_late_fee).toBe('rent');
    expect(findServiceTool('waive_late_fee')).toBeUndefined();

    // A member needs both the 'ai' capability and the 'rent' area to run it.
    expect(deniedWriteTools('member', []).has('apply_late_fee')).toBe(true);
    expect(deniedWriteTools('member', ['ai']).has('apply_late_fee')).toBe(true);
    expect(deniedWriteTools('member', ['ai', 'rent']).has('apply_late_fee')).toBe(false);
    expect(deniedWriteTools('owner', []).has('apply_late_fee')).toBe(false);
  });

  it('executes through the tool registry and audits the passed actor', async () => {
    const { rentPaymentId } = await makeCharge();
    const tool = findServiceTool('apply_late_fee')!;
    const result = (await tool.execute(accountId, { rentPaymentId }, 'system')) as {
      lateFeeCents: number;
    };
    expect(result.lateFeeCents).toBe(ACCOUNT_DEFAULT_FEE); // effective policy (account default)
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { accountId, action: 'rent_payment.late_fee_applied', entityId: rentPaymentId },
    });
    expect(audit.actor).toBe('system');
  });

  it('applies via the MCP server with system attribution', async () => {
    const { rentPaymentId } = await makeCharge();
    const server = createMcpServer({ accountId, allowWrites: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'late-fee-test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const res = (await client.callTool({
        name: 'apply_late_fee',
        arguments: { rentPaymentId, feeCents: 4200 },
      })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      expect(res.isError ?? false).toBe(false);
      const payment = JSON.parse(res.content[0]!.text) as { lateFeeCents: number };
      expect(payment.lateFeeCents).toBe(4200);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { accountId, action: 'rent_payment.late_fee_applied', entityId: rentPaymentId },
      });
      expect(audit.actor).toBe('system');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('route permission enforcement (Supabase mode)', () => {
  const TEST_SECRET = 'test-jwt-secret-with-at-least-32-characters!';
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
    resetAuthServiceCache();
    app = await buildApp();
  });

  afterAll(async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    resetAuthServiceCache();
    await app.close();
  });

  it("403s a member without 'rent' on POST /rent/payments/:id/late-fee", async () => {
    const account = await prisma.account.create({
      data: { name: 'Late Fee Authz', email: EMAIL('authz'), timezone: TZ, defaultLateFeeCents: 5000 },
    });
    await prisma.user.create({
      data: {
        accountId: account.id,
        supabaseUserId: 'late-fee-member',
        email: EMAIL('member'),
        role: 'member',
        permissionsJson: '[]',
      },
    });
    const property = await prisma.property.create({
      data: { accountId: account.id, addressLine1: '2 Late Fee Way', city: 'X', state: 'CA', zip: '00000' },
    });
    const unit = await prisma.unit.create({ data: { propertyId: property.id, label: 'A' } });
    const tenant = await tenantService.create(account.id, { fullName: 'Authz Tenant' });
    const lease = await leaseService.create(account.id, {
      unitId: unit.id,
      tenantIds: [tenant.id],
      rentCents: 100000,
      dueDay: 1,
      startDate: iso(addDays(now, -400)),
      endDate: iso(addDays(now, 400)),
    });
    const charge = await prisma.rentPayment.create({
      data: {
        leaseId: lease.id,
        period,
        dueDate: addDays(startOfDayInTz(now, TZ), -10),
        amountCents: 100000,
        status: 'due',
      },
    });

    const token = await new SignJWT({ email: EMAIL('member'), aud: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('late-fee-member')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(TEST_SECRET));

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/rent/payments/${charge.id}/late-fee`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
    // The write never happened — no fee applied.
    expect(
      (await prisma.rentPayment.findUniqueOrThrow({ where: { id: charge.id } })).lateFeeCents,
    ).toBe(0);
  });
});
