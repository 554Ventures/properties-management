import type {
  AskUserQuestionAnswer,
  ChatMessage,
  ChatRole,
  ChatSession,
  ChatSessionStatus,
  ContentBlock,
  CreateChatSessionInput,
} from '@hearth/shared';
import type { ChatSession as DbChatSession, ChatMessage as DbChatMessage } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import { iso } from '../lib/dates';
import { ConflictError, NotFoundError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { sseEnd, sseSend, sseStart } from '../plugins/sse';
import { prepareResume, resumeTurn, runUserTurn, type Emit } from '../ai/agent-loop';

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
): Promise<void> {
  const session = await getOwned(accountId, sessionId);
  if (session.status === 'awaiting_user') {
    throw new ConflictError('session is awaiting an answer to a question — POST /answer instead');
  }
  if (session.status === 'running') {
    throw new ConflictError('a turn is already running on this session');
  }

  sseStart(reply);
  const emit: Emit = (event, data) => sseSend(reply, event, data);
  try {
    await runUserTurn({ accountId, session, text, emit });
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
): Promise<void> {
  const session = await getOwned(accountId, sessionId);
  if (session.status !== 'awaiting_user') {
    throw new ConflictError('session has no pending question to answer');
  }
  // Validate before hijacking so bad answers get a normal 4xx JSON response.
  const prepared = await prepareResume(session, answer);

  sseStart(reply);
  const emit: Emit = (event, data) => sseSend(reply, event, data);
  try {
    await resumeTurn({ accountId, session, prepared, emit });
  } finally {
    sseEnd(reply);
  }
}
