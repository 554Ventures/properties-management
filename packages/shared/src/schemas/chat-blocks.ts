// Chat content-block discriminated union, exactly per ARCHITECTURE §5.
// ChatMessage.blocksJson stores ContentBlock[]; the agent loop validates every
// structured block against these schemas before emitting `block_complete`.
import { z } from 'zod';

// colorRole → color mapping lives only in the frontend token file.
export const ColorRoleSchema = z.enum(['positive', 'warning', 'neutral', 'ai']);

export const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(), // markdown-lite: bold, lists
});

export const ChartPointSchema = z.object({
  x: z.string(),
  y: z.number(), // in cents when yUnit = "usd"
});

export const ChartSeriesSchema = z.object({
  label: z.string(),
  colorRole: ColorRoleSchema,
  points: z.array(ChartPointSchema),
});

export const ChartBlockSchema = z.object({
  type: z.literal('chart'),
  kind: z.enum(['line', 'bar', 'donut', 'sparkline']),
  title: z.string(),
  description: z.string(), // required a11y text alternative
  yUnit: z.enum(['usd', 'percent', 'count']),
  series: z.array(ChartSeriesSchema),
});

export const DataTableColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  align: z.enum(['left', 'right']).optional(),
  format: z.enum(['usd', 'date', 'text']).optional(),
});

export const DataTableBlockSchema = z.object({
  type: z.literal('data_table'),
  title: z.string().optional(),
  columns: z.array(DataTableColumnSchema),
  rows: z.array(z.record(z.union([z.string(), z.number()]))),
});

// api_call paths are the §3 REST routes — the button just calls the normal API.
export const ApiCallActionSchema = z.object({
  kind: z.literal('api_call'),
  method: z.enum(['POST', 'PATCH']),
  path: z.string(),
  body: z.unknown().optional(),
});

export const NavigateActionSchema = z.object({
  kind: z.literal('navigate'),
  to: z.string(),
});

export const ActionCardActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  style: z.enum(['primary', 'secondary']),
  action: z.discriminatedUnion('kind', [ApiCallActionSchema, NavigateActionSchema]),
});

export const ActionCardBlockSchema = z.object({
  type: z.literal('action_card'),
  title: z.string(),
  body: z.string().optional(),
  actions: z.array(ActionCardActionSchema).min(1),
});

export const AskUserQuestionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
});

export const AskUserQuestionBlockSchema = z.object({
  type: z.literal('ask_user_question'),
  questionId: z.string(),
  header: z.string().optional(),
  question: z.string(),
  multiSelect: z.boolean(),
  options: z.array(AskUserQuestionOptionSchema).min(2).max(4),
  allowFreeText: z.literal(true),
});

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ChartBlockSchema,
  DataTableBlockSchema,
  ActionCardBlockSchema,
  AskUserQuestionBlockSchema,
]);

export const ContentBlockTypeSchema = z.enum([
  'text',
  'chart',
  'data_table',
  'action_card',
  'ask_user_question',
]);

// POST /chat/sessions/:id/answer request body.
export const AskUserQuestionAnswerSchema = z.object({
  questionId: z.string(),
  selectedOptionIds: z.array(z.string()),
  freeText: z.string().optional(),
});
