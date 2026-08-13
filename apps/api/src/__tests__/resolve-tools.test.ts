// Resolve/undo AI write tools (WHATS_NEXT §4 "the registry is a strict subset
// of REST", filed 2026-08-13): list_bank_discrepancies could show the stuck
// rows and nothing in the registry could clear them, and the rent-link guard's
// own error copy told the user to unlink a deposit the assistant had no way to
// unlink. accept_bank_discrepancy / dismiss_bank_discrepancy ('money') and
// unlink_rent_deposit ('rent') wrap the existing audited service functions —
// no new business logic, so what's asserted here is the wiring: registry flags,
// permission parity with the route guards, audit attribution, account scoping,
// and the guided unlink→accept flow being completable from chat alone.
//
// Own throwaway accounts, cleaned up in afterAll — never touches the seeded
// demo account (later files pin its figures exactly).
import { BankDiscrepancyResolutionSchema, RentPaymentSchema } from '@hearth/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';
import { deniedWriteTools, findServiceTool, WRITE_TOOL_PERMISSIONS } from '../ai/tools';
import { currentPeriod } from '../lib/dates';
import { prisma } from '../lib/prisma';
import { createMcpServer } from '../mcp/index';
import * as leaseService from '../services/lease.service';
import * as propertyService from '../services/property.service';
import * as rentService from '../services/rent.service';
import * as tenantService from '../services/tenant.service';
import { listBankDiscrepancies } from '../services/transaction.service';

const EMAIL_SUFFIX = '@resolvetooltest.example';
const RESOLVE_TOOLS = {
  accept_bank_discrepancy: 'money',
  dismiss_bank_discrepancy: 'money',
  unlink_rent_deposit: 'rent',
} as const;

async function makeAccount(tag: string): Promise<string> {
  const account = await prisma.account.create({
    data: { name: `Resolve Tool Co ${tag}`, email: `resolve-tool-${tag}${EMAIL_SUFFIX}` },
  });
  return account.id;
}

/** Run a tool the way the agent loop does: parsed input, service execution. */
async function run(name: string, accountId: string, input: Record<string, unknown>) {
  const tool = findServiceTool(name);
  expect(tool, `${name} is not registered`).toBeDefined();
  return tool!.execute(accountId, tool!.inputSchema.parse(input), 'system');
}

/** A confirmed ledger row plus a pending bank change against it. */
async function makeDiscrepancy(
  accountId: string,
  kind: 'modified' | 'removed',
  externalId: string,
) {
  const txn = await prisma.transaction.create({
    data: {
      accountId,
      date: new Date(),
      amountCents: 4200,
      type: 'expense',
      description: 'CONFIRMED CHARGE',
      source: 'bank',
      status: 'confirmed',
      externalId,
    },
  });
  const discrepancy = await prisma.bankSyncDiscrepancy.create({
    data: {
      accountId,
      transactionId: txn.id,
      externalId,
      provider: 'plaid',
      kind,
      status: 'pending',
      bankDataJson:
        kind === 'modified'
          ? JSON.stringify({
              date: txn.date.toISOString(),
              amountCents: 4500,
              type: 'expense',
              description: 'CONFIRMED CHARGE — POSTED',
              vendor: null,
            })
          : null,
    },
  });
  return { txn, discrepancy };
}

/** A lease with this period's rent fully paid — one deposit backed by one
 *  confirmed income transaction. */
async function makePaidRent(accountId: string, addressLine1: string) {
  const property = await propertyService.create(accountId, {
    addressLine1,
    city: 'Springfield',
    state: 'IL',
    zip: '62701',
    units: [{ label: 'A' }],
  });
  const detail = await propertyService.getDetail(accountId, property.id);
  const unitId = detail.units[0]!.id;
  const tenant = await tenantService.create(accountId, { fullName: 'Rent Payer' });
  await leaseService.create(accountId, {
    unitId,
    tenantIds: [tenant.id],
    rentCents: 100000,
    dueDay: 1,
    startDate: new Date(Date.now() - 200 * 86_400_000).toISOString(),
    endDate: new Date(Date.now() + 200 * 86_400_000).toISOString(),
  });
  const lease = await prisma.lease.findFirstOrThrow({ where: { unitId } });
  const period = currentPeriod();
  const charge = await rentService.recordPayment(accountId, {
    leaseId: lease.id,
    period,
    amountCents: 100000,
    method: 'manual',
  });
  const deposit = await prisma.rentPaymentDeposit.findFirstOrThrow({
    where: { rentPaymentId: charge.id },
  });
  return { unitId, charge, deposit };
}

afterAll(async () => {
  await prisma.account.deleteMany({ where: { email: { endsWith: EMAIL_SUFFIX } } });
});

describe('resolve/undo write tools — registry + permission gating', () => {
  it('registers all three as write tools gated on the same area as their route', () => {
    for (const [name, area] of Object.entries(RESOLVE_TOOLS)) {
      expect(findServiceTool(name)?.write, name).toBe(true);
      expect(WRITE_TOOL_PERMISSIONS[name], name).toBe(area);
    }
  });

  it('denies a member without the area, allows with it, never gates owners', () => {
    for (const [name, area] of Object.entries(RESOLVE_TOOLS)) {
      expect(deniedWriteTools('member', []).has(name), name).toBe(true);
      expect(deniedWriteTools('member', ['ai']).has(name), name).toBe(true);
      expect(deniedWriteTools('member', ['ai', area]).has(name), name).toBe(false);
      // The other area is not a substitute for the one the route requires.
      const wrongArea = area === 'money' ? 'rent' : 'money';
      expect(deniedWriteTools('member', ['ai', wrongArea]).has(name), name).toBe(true);
      expect(deniedWriteTools('owner', []).has(name), name).toBe(false);
    }
  });
});

describe('bank-discrepancy tools — execution + audit attribution', () => {
  it("accept_bank_discrepancy applies the bank's restated values and audits system", async () => {
    const accountId = await makeAccount('accept');
    const { txn, discrepancy } = await makeDiscrepancy(accountId, 'modified', 'ext_tool_accept');

    const resolution = BankDiscrepancyResolutionSchema.parse(
      await run('accept_bank_discrepancy', accountId, { discrepancyId: discrepancy.id }),
    );
    expect(resolution).toMatchObject({ id: discrepancy.id, status: 'accepted' });

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txn.id } });
    expect(after.amountCents).toBe(4500);
    expect((await listBankDiscrepancies(accountId)).items).toHaveLength(0);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { accountId, action: 'bank_discrepancy.accepted', entityId: discrepancy.id },
    });
    expect(audit.actor).toBe('system');
  });

  it('dismiss_bank_discrepancy keeps the ledger row and audits system', async () => {
    const accountId = await makeAccount('dismiss');
    const { txn, discrepancy } = await makeDiscrepancy(accountId, 'removed', 'ext_tool_dismiss');

    const resolution = BankDiscrepancyResolutionSchema.parse(
      await run('dismiss_bank_discrepancy', accountId, { discrepancyId: discrepancy.id }),
    );
    expect(resolution).toMatchObject({ id: discrepancy.id, status: 'dismissed' });
    // "Keep my version" — the row the bank wanted removed survives untouched.
    expect(await prisma.transaction.findUnique({ where: { id: txn.id } })).not.toBeNull();

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { accountId, action: 'bank_discrepancy.dismissed', entityId: discrepancy.id },
    });
    expect(audit.actor).toBe('system');
  });

  it('refuses a discrepancy belonging to another account', async () => {
    const accountId = await makeAccount('disc-isolate-a');
    const otherAccountId = await makeAccount('disc-isolate-b');
    const { discrepancy } = await makeDiscrepancy(accountId, 'modified', 'ext_tool_isolate');

    for (const name of ['accept_bank_discrepancy', 'dismiss_bank_discrepancy']) {
      await expect(
        run(name, otherAccountId, { discrepancyId: discrepancy.id }),
      ).rejects.toThrow(/bank discrepancy/i);
    }
    expect(
      (await prisma.bankSyncDiscrepancy.findUniqueOrThrow({ where: { id: discrepancy.id } })).status,
    ).toBe('pending');
  });
});

describe('unlink_rent_deposit — execution + audit attribution', () => {
  it('reopens the charge, leaves the ledger row confirmed, and audits system', async () => {
    const accountId = await makeAccount('unlink');
    const { charge, deposit } = await makePaidRent(accountId, '1 Unlink Way');
    expect(charge.paidCents).toBe(100000);

    const reopened = RentPaymentSchema.parse(
      await run('unlink_rent_deposit', accountId, {
        rentPaymentId: charge.id,
        depositId: deposit.id,
      }),
    );
    expect(reopened).toMatchObject({ id: charge.id, paidCents: 0, status: 'due', paidAt: null });

    // The ledger transaction survives as an ordinary confirmed income row.
    const txn = await prisma.transaction.findUniqueOrThrow({
      where: { id: deposit.transactionId },
    });
    expect(txn).toMatchObject({ status: 'confirmed', type: 'income', amountCents: 100000 });
    expect(await prisma.rentPaymentDeposit.findUnique({ where: { id: deposit.id } })).toBeNull();

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { accountId, action: 'rent_payment.deposit_unlinked', entityId: charge.id },
    });
    expect(audit.actor).toBe('system');
  });

  it('refuses a deposit belonging to another account', async () => {
    const accountId = await makeAccount('unlink-isolate-a');
    const otherAccountId = await makeAccount('unlink-isolate-b');
    const { charge, deposit } = await makePaidRent(accountId, '2 Unlink Way');

    await expect(
      run('unlink_rent_deposit', otherAccountId, {
        rentPaymentId: charge.id,
        depositId: deposit.id,
      }),
    ).rejects.toThrow(/rent deposit/i);
    expect(
      (await prisma.rentPayment.findUniqueOrThrow({ where: { id: charge.id } })).paidCents,
    ).toBe(100000);
  });

  it('unblocks the guided unlink→accept flow entirely from the tool registry', async () => {
    const accountId = await makeAccount('guided');
    const { charge, deposit } = await makePaidRent(accountId, '3 Unlink Way');
    const depositTxn = await prisma.transaction.findUniqueOrThrow({
      where: { id: deposit.transactionId },
    });
    const discrepancy = await prisma.bankSyncDiscrepancy.create({
      data: {
        accountId,
        transactionId: depositTxn.id,
        externalId: 'ext_tool_guided',
        provider: 'plaid',
        kind: 'modified',
        status: 'pending',
        bankDataJson: JSON.stringify({
          date: depositTxn.date.toISOString(),
          amountCents: 100500, // differs → trips the rent-link guard
          type: 'income',
          description: depositTxn.description,
          vendor: null,
        }),
      },
    });

    // Accepting first is refused: the row still backs a rent deposit.
    await expect(
      run('accept_bank_discrepancy', accountId, { discrepancyId: discrepancy.id }),
    ).rejects.toMatchObject({ statusCode: 400 });

    // The ids the assistant needs come off the discrepancy list itself.
    const row = (await listBankDiscrepancies(accountId)).items.find(
      (d) => d.id === discrepancy.id,
    )!;
    expect(row.rentPaymentId).toBe(charge.id);
    expect(row.depositId).toBe(deposit.id);

    await run('unlink_rent_deposit', accountId, {
      rentPaymentId: row.rentPaymentId!,
      depositId: row.depositId!,
    });
    const resolution = BankDiscrepancyResolutionSchema.parse(
      await run('accept_bank_discrepancy', accountId, { discrepancyId: discrepancy.id }),
    );
    expect(resolution.status).toBe('accepted');
    expect(
      (await prisma.transaction.findUniqueOrThrow({ where: { id: depositTxn.id } })).amountCents,
    ).toBe(100500);
  });
});

describe('resolve/undo write tools — MCP', () => {
  it('dismisses a bank change over MCP with system attribution', async () => {
    const accountId = await makeAccount('mcp');
    const { discrepancy } = await makeDiscrepancy(accountId, 'removed', 'ext_tool_mcp');

    const server = createMcpServer({ accountId, allowWrites: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'resolve-tool-test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const res = (await client.callTool({
        name: 'dismiss_bank_discrepancy',
        arguments: { discrepancyId: discrepancy.id },
      })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      expect(res.isError ?? false).toBe(false);
      expect(BankDiscrepancyResolutionSchema.parse(JSON.parse(res.content[0]!.text))).toMatchObject({
        id: discrepancy.id,
        status: 'dismissed',
      });

      const rows = await prisma.auditLog.findMany({
        where: { accountId, action: 'bank_discrepancy.dismissed', entityId: discrepancy.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe('system');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
