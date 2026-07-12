import {
  AskUserQuestionAnswerSchema,
  CreateChatSessionInputSchema,
  SendChatMessageInputSchema,
} from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { parseBody } from '../plugins/zod-validation';
import * as chatService from '../services/chat.service';

// Per-account limit on turn-starting requests (deployment plan §4.5) — each
// one can cost model tokens. Reads (GET) stay unlimited.
function chatWriteLimit() {
  return {
    rateLimit: {
      max: Number(process.env.CHAT_RATE_LIMIT_MAX ?? 30),
      timeWindow: '1 minute',
    },
  };
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post('/chat/sessions', { config: chatWriteLimit() }, async (req, reply) => {
    const input = parseBody(CreateChatSessionInputSchema, req.body);
    const session = await chatService.createSession(req.accountId, input);
    return reply.code(201).send(session);
  });

  app.get('/chat/sessions', async (req) => chatService.listSessions(req.accountId));

  app.get<{ Params: { id: string } }>('/chat/sessions/:id/messages', async (req) =>
    chatService.getMessages(req.accountId, req.params.id),
  );

  // SSE — the service hijacks the reply and streams §5 protocol events.
  app.post<{ Params: { id: string } }>(
    '/chat/sessions/:id/messages',
    { config: chatWriteLimit() },
    async (req, reply) => {
      const input = parseBody(SendChatMessageInputSchema, req.body);
      await chatService.sendMessage(req.accountId, req.params.id, input.text, reply, {
        role: req.userRole,
        permissions: req.userPermissions,
      });
    },
  );

  // SSE — resumes the paused assistant turn on a fresh stream.
  app.post<{ Params: { id: string } }>(
    '/chat/sessions/:id/answer',
    { config: chatWriteLimit() },
    async (req, reply) => {
      const answer = parseBody(AskUserQuestionAnswerSchema, req.body);
      await chatService.answerQuestion(req.accountId, req.params.id, answer, reply, {
        role: req.userRole,
        permissions: req.userPermissions,
      });
    },
  );
}
