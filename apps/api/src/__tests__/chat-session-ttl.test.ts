// Session TTL sweep (WHATS_NEXT §2 session hygiene): awaiting_user sessions
// past their 7-day TTL reopen as idle with the paused resume state dropped
// (screen context kept); running sessions past one hour are zombie claims
// (crash between the atomic claim and finalize) released back to idle; fresh
// sessions in either state are never touched. Wired into runDailyJobs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { getDemoAccountId } from '../plugins/auth';
import * as chatService from '../services/chat.service';
import { runDailyJobs } from '../services/jobs.service';

let accountId: string;
const createdSessionIds: string[] = [];

/** Create a session in `status` whose updatedAt is `ageHours` in the past.
 *  updatedAt is @updatedAt-managed, so backdating goes through raw SQL. */
async function makeSession(
  status: string,
  ageHours: number,
  providerStateJson: string | null = null,
): Promise<string> {
  const row = await prisma.chatSession.create({
    data: { accountId, status, providerStateJson },
  });
  createdSessionIds.push(row.id);
  // Bound as an explicit-UTC string: Prisma binds a raw Date in local wall
  // time, which would silently shift the fixture by the machine's UTC offset.
  const backdated = new Date(Date.now() - ageHours * 3_600_000).toISOString();
  await prisma.$executeRaw`
    UPDATE "ChatSession"
    SET "updatedAt" = (${backdated}::timestamptz AT TIME ZONE 'UTC')
    WHERE "id" = ${row.id}`;
  return row.id;
}

beforeAll(async () => {
  accountId = await getDemoAccountId();
});

afterAll(async () => {
  await prisma.chatSession.deleteMany({ where: { id: { in: createdSessionIds } } });
});

describe('expireStaleSessions', () => {
  it('reopens an awaiting_user session past the 7-day TTL, keeping context but dropping the pause', async () => {
    const staleId = await makeSession(
      'awaiting_user',
      8 * 24,
      JSON.stringify({
        context: { screen: 'reports' },
        paused: { messages: [], pendingToolUseId: 't1', questionId: 'q1', blockIndex: 0, assistantMessageId: 'm1', completedToolResults: [] },
      }),
    );
    const freshId = await makeSession(
      'awaiting_user',
      2 * 24,
      JSON.stringify({ paused: { messages: [], pendingToolUseId: 't2', questionId: 'q2', blockIndex: 0, assistantMessageId: 'm2', completedToolResults: [] } }),
    );

    const result = await chatService.expireStaleSessions();
    expect(result.awaitingExpired).toBeGreaterThanOrEqual(1);

    const stale = await prisma.chatSession.findUniqueOrThrow({ where: { id: staleId } });
    expect(stale.status).toBe('idle');
    // Context survives; the paused resume state does not.
    expect(JSON.parse(stale.providerStateJson!)).toEqual({ context: { screen: 'reports' } });

    // Two days old is well inside the TTL — untouched, still answerable.
    const fresh = await prisma.chatSession.findUniqueOrThrow({ where: { id: freshId } });
    expect(fresh.status).toBe('awaiting_user');
    expect(JSON.parse(fresh.providerStateJson!).paused).toBeDefined();
  });

  it('releases a zombie running claim after an hour but never a live turn', async () => {
    const zombieId = await makeSession('running', 3);
    const liveId = await makeSession('running', 0);

    const result = await chatService.expireStaleSessions();
    expect(result.runningReleased).toBeGreaterThanOrEqual(1);

    expect((await prisma.chatSession.findUniqueOrThrow({ where: { id: zombieId } })).status).toBe('idle');
    expect((await prisma.chatSession.findUniqueOrThrow({ where: { id: liveId } })).status).toBe('running');

    // Reset the live fixture so the daily-jobs test below sweeps nothing extra.
    await prisma.chatSession.update({ where: { id: liveId }, data: { status: 'idle' } });
  });

  it('runs inside runDailyJobs and reports both counters', async () => {
    const staleId = await makeSession('awaiting_user', 8 * 24, null);

    const result = await runDailyJobs();
    expect(result.chatSessionsExpired).toBeGreaterThanOrEqual(1);
    expect(result.chatSessionsReleased).toBeGreaterThanOrEqual(0);
    expect((await prisma.chatSession.findUniqueOrThrow({ where: { id: staleId } })).status).toBe('idle');
  });
});
