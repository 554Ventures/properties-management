import {
  AskUserQuestionAnswerSchema,
  CreateChatSessionInputSchema,
  SendChatMessageInputSchema,
} from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { parseBody } from '../plugins/zod-validation';
import * as chatService from '../services/chat.service';

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post('/chat/sessions', async (req, reply) => {
    const input = parseBody(CreateChatSessionInputSchema, req.body);
    const session = await chatService.createSession(req.accountId, input);
    return reply.code(201).send(session);
  });

  app.get('/chat/sessions', async (req) => chatService.listSessions(req.accountId));

  app.get<{ Params: { id: string } }>('/chat/sessions/:id/messages', async (req) =>
    chatService.getMessages(req.accountId, req.params.id),
  );

  // SSE — the service hijacks the reply and streams §5 protocol events.
  app.post<{ Params: { id: string } }>('/chat/sessions/:id/messages', async (req, reply) => {
    const input = parseBody(SendChatMessageInputSchema, req.body);
    await chatService.sendMessage(req.accountId, req.params.id, input.text, reply);
  });

  // SSE — resumes the paused assistant turn on a fresh stream.
  app.post<{ Params: { id: string } }>('/chat/sessions/:id/answer', async (req, reply) => {
    const answer = parseBody(AskUserQuestionAnswerSchema, req.body);
    await chatService.answerQuestion(req.accountId, req.params.id, answer, reply);
  });
}
