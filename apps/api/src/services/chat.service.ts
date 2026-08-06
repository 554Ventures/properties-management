import type {
  AskUserQuestionAnswer,
  ChatMessage,
  ChatRole,
  ChatSession,
  ChatSessionStatus,
  ContentBlock,
  CreateChatSessionInput,
  MemberPermission,
  UserRole,
} from '@hearth/shared';
import type { ChatSession as DbChatSession, ChatMessage as DbChatMessage } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import { iso } from '../lib/dates';
import { ConflictError, NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { sseEnd, sseSend, sseStart } from '../plugins/sse';
import { prepareResume, resumeTurn, runUserTurn, type Emit, type UsageLog } from '../ai/agent-loop';
import { deniedWriteTools } from '../ai/tools';

/** The acting user's chat write authorization (docs/WHATS_NEXT.md §4). */
export interface ChatWriteAccess {
  role: UserRole;
  permissions: MemberPermission[];
}

export function toApiSession(s: DbChatSession): ChatSession {
  return {
    id: s.id,
    accountId: s.accountId,
    title: s.title,
    status: s.status as ChatSessionStatus,
    createdAt: iso(s.createdAt),
    updatedAt: iso(s.updatedAt),
  };
}

export function toApiMessage(m: DbChatMessage): ChatMessage {
  return {
    id: m.id,
    sessionId: m.sessionId,
    role: m.role as ChatRole,
    blocks: JSON.parse(m.blocksJson) as ContentBlock[],
    createdAt: iso(m.createdAt),
  };
}

async function getOwned(accountId: string, id: string): Promise<DbChatSession> {
  const row = await prisma.chatSession.findFirst({ where: { id, accountId } });
  if (!row) throw new NotFoundError('chat session', id);
  return row;
}

// TTL sweep bounds (WHATS_NEXT §2 session hygiene). A question can sit
// unanswered for days legitimately — the web/iOS clients restore the last
// session, so "answer it next week" is a real flow — hence the generous
// awaiting_user window. A running turn is bounded by MAX_ITERATIONS and
// finishes in minutes; anything 'running' for an hour is a zombie from a
// crash between the claim and finalize, and every send on it 409s forever.
const AWAITING_USER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RUNNING_TTL_MS = 60 * 60 * 1000;

/**
 * Expire sessions stuck in a claimed state, called by the daily jobs run.
 * awaiting_user past its TTL reopens as idle with the paused resume state
 * dropped (screen context kept) — the unanswered question block stays in the
 * transcript and renders frozen, and sends work again instead of 409ing
 * forever. running past its TTL releases the claim untouched otherwise.
 * Each row flips through a conditional updateMany keyed on its current
 * status, so a sweep racing a genuine answer/turn loses cleanly.
 */
export async function expireStaleSessions(
  now: Date = new Date(),
): Promise<{ awaitingExpired: number; runningReleased: number }> {
  const result = { awaitingExpired: 0, runningReleased: 0 };

  const staleAwaiting = await prisma.chatSession.findMany({
    where: { status: 'awaiting_user', updatedAt: { lt: new Date(now.getTime() - AWAITING_USER_TTL_MS) } },
  });
  for (const session of staleAwaiting) {
    let context: unknown = null;
    try {
      context = (JSON.parse(session.providerStateJson ?? '{}') as { context?: unknown }).context ?? null;
    } catch {
      // Unparseable state — nothing to preserve.
    }
    const claimed = await prisma.chatSession.updateMany({
      where: { id: session.id, status: 'awaiting_user' },
      data: { status: 'idle', providerStateJson: context ? JSON.stringify({ context }) : null },
    });
    result.awaitingExpired += claimed.count;
  }

  const staleRunning = await prisma.chatSession.updateMany({
    where: { status: 'running', updatedAt: { lt: new Date(now.getTime() - RUNNING_TTL_MS) } },
    data: { status: 'idle' },
  });
  result.runningReleased = staleRunning.count;

  return result;
}

export async function createSession(
  accountId: string,
  input: CreateChatSessionInput,
): Promise<ChatSession> {
  const row = await prisma.chatSession.create({
    data: {
      accountId,
      status: 'idle',
      providerStateJson: input.context ? JSON.stringify({ context: input.context }) : null,
    },
  });
  return toApiSession(row);
}

export async function listSessions(accountId: string): Promise<ChatSession[]> {
  const rows = await prisma.chatSession.findMany({
    where: { accountId },
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map(toApiSession);
}

export async function getMessages(accountId: string, sessionId: string): Promise<ChatMessage[]> {
  await getOwned(accountId, sessionId);
  const rows = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toApiMessage);
}

/** POST /chat/sessions/:id/messages → SSE stream (reply is hijacked). */
export async function sendMessage(
  accountId: string,
  sessionId: string,
  text: string,
  reply: FastifyReply,
  writeAccess: ChatWriteAccess,
): Promise<void> {
  const session = await getOwned(accountId, sessionId);
  // Atomic claim (WHATS_NEXT §2): the conditional WHERE is the transition
  // guard. Two concurrent sends can both read 'idle', but only one matches
  // the idle→running update — the loser sees count 0 and 409s here, before
  // the SSE hijack, so it still gets a normal JSON error response. The first
  // message stamps the session title inside the same write.
  const claimed = await prisma.chatSession.updateMany({
    where: { id: session.id, status: 'idle' },
    data: { status: 'running', ...(session.title ? {} : { title: text.slice(0, 80) }) },
  });
  if (claimed.count === 0) {
    const fresh = await getOwned(accountId, sessionId);
    if (fresh.status === 'awaiting_user') {
      throw new ConflictError('session is awaiting an answer to a question — POST /answer instead');
    }
    throw new ConflictError('a turn is already running on this session');
  }

  const deniedTools = deniedWriteTools(writeAccess.role, writeAccess.permissions);
  sseStart(reply);
  const emit: Emit = (event, data) => sseSend(reply, event, data);
  const log: UsageLog = (data, message) => reply.log.info(data, message);
  try {
    await runUserTurn({ accountId, session, text, emit, log, deniedTools });
  } finally {
    sseEnd(reply);
  }
}

/** POST /chat/sessions/:id/answer → SSE stream resuming the paused turn. */
export async function answerQuestion(
  accountId: string,
  sessionId: string,
  answer: AskUserQuestionAnswer,
  reply: FastifyReply,
  writeAccess: ChatWriteAccess,
): Promise<void> {
  const session = await getOwned(accountId, sessionId);
  if (session.status !== 'awaiting_user') {
    throw new ConflictError('session has no pending question to answer');
  }
  // Validate before hijacking so bad answers get a normal 4xx JSON response.
  const prepared = await prepareResume(session, answer);

  // Atomic claim (WHATS_NEXT §2): awaiting_user→running consumes the paused
  // state (context kept) in the same conditional write. Two concurrent
  // answers can both pass the read guard above, but only one can consume the
  // pause — the loser sees count 0 and 409s before the SSE hijack.
  const claimed = await prisma.chatSession.updateMany({
    where: { id: session.id, status: 'awaiting_user' },
    data: {
      status: 'running',
      providerStateJson: prepared.context ? JSON.stringify({ context: prepared.context }) : null,
    },
  });
  if (claimed.count === 0) {
    throw new ConflictError('session has no pending question to answer');
  }

  const deniedTools = deniedWriteTools(writeAccess.role, writeAccess.permissions);
  sseStart(reply);
  const emit: Emit = (event, data) => sseSend(reply, event, data);
  const log: UsageLog = (data, message) => reply.log.info(data, message);
  try {
    await resumeTurn({ accountId, session, prepared, emit, log, deniedTools });
  } finally {
    sseEnd(reply);
  }
}
