import { z } from 'zod';
import { ChatRoleSchema, ChatSessionStatusSchema } from '../enums';
import { ContentBlockSchema, ContentBlockTypeSchema } from './chat-blocks';

// providerStateJson is server-internal and never leaves the API.
export const ChatSessionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  title: z.string().nullable(),
  status: ChatSessionStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ChatSessionListResponseSchema = z.array(ChatSessionSchema);

export const ChatMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: ChatRoleSchema,
  blocks: z.array(ContentBlockSchema), // parsed from blocksJson
  createdAt: z.string().datetime(),
});

export const ChatMessageListResponseSchema = z.array(ChatMessageSchema);

// POST /chat/sessions
export const CreateChatSessionInputSchema = z.object({
  context: z
    .object({
      screen: z.string(),
      entityId: z.string().optional(),
    })
    .optional(),
});

// POST /chat/sessions/:id/messages → SSE stream
export const SendChatMessageInputSchema = z.object({
  text: z.string().min(1),
});

// ---------------------------------------------------------------------------
// SSE protocol (§5). Each wire event is `event: <name>\ndata: <json>`; the
// schemas below validate the `data` payloads.
// ---------------------------------------------------------------------------

export const SseMessageStartSchema = z.object({
  messageId: z.string(),
});

export const SseBlockStartSchema = z.object({
  index: z.number().int(),
  blockType: ContentBlockTypeSchema,
});

// Text blocks stream token-wise.
export const SseTextDeltaSchema = z.object({
  index: z.number().int(),
  delta: z.string(),
});

// Structured blocks (chart/table/action_card/ask_user_question) arrive whole.
export const SseBlockCompleteSchema = z.object({
  index: z.number().int(),
  block: ContentBlockSchema,
});

// Optional — drives the "checking your ledger…" indicator.
export const SseToolActivitySchema = z.object({
  name: z.string(),
  status: z.enum(['running', 'done']),
});

// Turn paused on an ask_user_question block; composer disabled except chips.
export const SseAwaitingInputSchema = z.object({
  messageId: z.string(),
  questionIndex: z.number().int(),
});

export const SseMessageCompleteSchema = z.object({
  messageId: z.string(),
});

export const SseErrorSchema = z.object({
  message: z.string(),
});

export const SseEventNameSchema = z.enum([
  'message_start',
  'block_start',
  'text_delta',
  'block_complete',
  'tool_activity',
  'awaiting_input',
  'message_complete',
  'error',
]);
export type SseEventName = z.infer<typeof SseEventNameSchema>;

/**
 * Discriminated wire-event union so both the API's SSE writer and the web
 * client's stream reader can exhaustively switch on `event`.
 */
export type SseEvent =
  | { event: 'message_start'; data: z.infer<typeof SseMessageStartSchema> }
  | { event: 'block_start'; data: z.infer<typeof SseBlockStartSchema> }
  | { event: 'text_delta'; data: z.infer<typeof SseTextDeltaSchema> }
  | { event: 'block_complete'; data: z.infer<typeof SseBlockCompleteSchema> }
  | { event: 'tool_activity'; data: z.infer<typeof SseToolActivitySchema> }
  | { event: 'awaiting_input'; data: z.infer<typeof SseAwaitingInputSchema> }
  | { event: 'message_complete'; data: z.infer<typeof SseMessageCompleteSchema> }
  | { event: 'error'; data: z.infer<typeof SseErrorSchema> };
